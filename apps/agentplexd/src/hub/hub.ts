import { PROTOCOL_VERSION, type HubId } from '@agentplex/protocol';
import { HTTP_TIMEOUTS, sendJson, startHttpServer, type HttpListener } from '../shared/http.js';
import type { Clock } from '../shared/clock.js';
import type { Logger } from '../shared/logger.js';
import type { IdGenerator } from '../shared/ids.js';
import { closure, CLOSE_POLICY, type SocketDialer } from '../shared/message-socket.js';
import type { Timers } from '../shared/timers.js';
import type { TokenMinter } from '../shared/tokens.js';
import { createWebSocketListener } from '../shared/ws-message-socket.js';
import {
  admitsUpgrade,
  answerTicketRequest,
  requestPath,
  CLIENT_TICKET_PATH,
  NOT_AUTHORIZED,
} from './clients/client-auth.js';
import { createClientTickets } from './clients/client-tickets.js';
import { startClientBroadcast, type ClientBroadcast } from './clients/client-broadcast.js';
import {
  startConnectionSupervisor,
  type ConnectionSupervisor,
} from './connections/connection-supervisor.js';
import type { Database } from './db/database.js';
import { loadMigrations, type MigrationFileSystem } from './db/migration-files.js';
import { migrate } from './db/migrations.js';
import { ensureHubIdentity } from './hub-identity.js';
import { readLayout } from './layout/node-tree.js';
import { createReducer, type Reducer } from './state/reducer.js';

/**
 * The hub role.
 *
 * Milestone 1 brought up what everything later stands on: the database is
 * migrated before anything is served, the hub knows its own id, and it answers
 * a health check. Milestone 3 adds the outbound half -- the hub dials every
 * paired server and keeps dialling, the reducer merges what they report into
 * one state, and the broadcast publishes that state whole to every client --
 * and the inbound one: a client exchanges the credential it was configured with
 * for a single-use ticket, opens a socket with it, and is attached.
 *
 * This file is where the two failures of that exchange are made into one fact.
 * A wrong credential is a 401 from the ticket route; a bad, spent or expired
 * ticket is a 1008 close on the socket. Both say `not authorized`, both are
 * logged as one refusal with no field saying which check it was, and neither
 * ever carries the URL it came in on -- see `client-auth.ts` for why the
 * distinction is not this hub's to publish.
 */

export interface HubDependencies {
  readonly database: Database;
  readonly logger: Logger;
  readonly ids: IdGenerator;
  /**
   * What the hub dials paired servers with. The hub dials, always: a server
   * needs one inbound port and dials out to nothing.
   */
  readonly dialer: SocketDialer;
  /**
   * The deadline seam the connection supervisor retries on. Injected for the
   * reason the clock is: a test that waited out a real backoff is one nobody
   * runs.
   */
  readonly timers: Timers;
  /**
   * The clock the schema does not have. Both rows this role writes at startup —
   * a migration's bookkeeping and the hub's own identity — record when they
   * were written, and SQLite has no `now()` default that a test could set.
   */
  readonly clock: Clock;
  /**
   * The shared credential a client presents to be given a ticket. It arrives
   * from configuration and is never minted here, because a hub has nowhere to
   * put a minted secret that the person typing it on a phone can read.
   */
  readonly clientToken: string;
  /**
   * Where a ticket's entropy comes from. Injected next to the id source rather
   * than folded into it: an id may be public and a ticket may not, and one seam
   * for both is how a uuid ends up authenticating a socket.
   */
  readonly tokens: TokenMinter;
  readonly migrationsDirectory: string;
  readonly migrationFileSystem: MigrationFileSystem;
  readonly host: string;
  readonly port: number;
}

export interface Hub {
  readonly hubId: HubId;
  readonly port: number;
  /**
   * The paired servers and what the hub can reach. Exposed because it is the
   * live half of the hub's state: the reducer reads it, and a listing that
   * shows a store has to be able to say whether anybody can still reach it.
   */
  readonly connections: ConnectionSupervisor;
  /**
   * Everything every server has reported, merged: one store per volume, one
   * session list under it, and the servers attached to it. The read surface
   * the client broadcast is built on, and the only place a session row is
   * assembled.
   */
  readonly state: Reducer;
  /**
   * Every attached client, and the pipeline that keeps them all looking at the
   * same thing. An authenticated socket is handed to `attach` and becomes a
   * client; nothing else in the hub sends a client anything.
   */
  readonly clients: ClientBroadcast;
  stop(): Promise<void>;
}

export async function startHub(dependencies: HubDependencies): Promise<Hub> {
  const {
    database,
    ids,
    clock,
    clientToken,
    tokens,
    dialer,
    timers,
    migrationsDirectory,
    migrationFileSystem,
    host,
    port,
  } = dependencies;
  const logger = dependencies.logger.child({ role: 'hub' });

  // Migrating before listening is the point of doing it here: a hub that serves
  // from a schema it has not reconciled has already told a client something.
  const migrations = await loadMigrations(migrationsDirectory, migrationFileSystem);
  const outcome = await migrate(database, migrations, logger, clock);
  logger.info('database ready', {
    applied: outcome.applied.length,
    alreadyApplied: outcome.alreadyApplied,
  });

  const hubId = await ensureHubIdentity(database, ids, clock);

  // Started before the port is opened, and not awaited past its first read of
  // the pairing table. A server that is switched off must not delay the hub
  // coming up: it is marked stale, dialled again on a backoff, and the hub
  // serves in the meantime with its rows labelled rather than absent.
  // Built before the supervisor, because the supervisor starts dialling as
  // soon as it exists and a connection that came up before there was anywhere
  // to put it would be a state that is wrong until the next change.
  const state = createReducer({ logger });

  // Subscribed before the supervisor exists, so that the first connectivity
  // change has somewhere to go. A client that attached a moment later would
  // still see it -- the state is whole and read at the moment it is sent -- but
  // a broadcast that missed changes it was running for would be a pipeline
  // whose correctness depended on start order.
  // The layout is read from the database per request rather than held in
  // memory beside the reducer's state. It is durable and the state is not:
  // where the user put things survives a restart, and which sessions are
  // reachable this second does not.
  const clients = startClientBroadcast({
    hubId,
    state,
    timers,
    logger,
    readLayout: () => readLayout(database),
  });

  const connections = await startConnectionSupervisor({
    database,
    dialer,
    hubId,
    timers,
    clock,
    logger,
    onChange: (report) => state.applyConnection(report),
  });

  // The short-lived half of client auth. Nothing durable: a ticket outliving a
  // restart would be a credential the hub could not count the uses of, and the
  // client holds the long-lived token it can always exchange for another.
  const tickets = createClientTickets({ tokens, clock });

  // A socket is admitted by its ticket and then handed straight to the
  // broadcast. There is no third state: either the ticket was good and this is
  // a client, or it was not and the socket is closed before it has been read
  // from. `onConnection` is where the check lives rather than `onUpgrade`,
  // because a refusal has to be a 1008 close and a close is only available once
  // the upgrade has completed -- a browser handed a failed upgrade is told
  // nothing it can act on, and telling the user "not authorized" is the point.
  const sockets = createWebSocketListener({
    onConnection: (socket, request) => {
      if (!admitsUpgrade(request.url, tickets)) {
        // The path and nothing else. The URL carries the ticket, so logging the
        // request target would be logging the credential.
        logger.warn('client refused', { path: requestPath(request.url) });
        socket.close(closure(CLOSE_POLICY, NOT_AUTHORIZED));
        return;
      }
      clients.attach(socket);
    },
  });

  const listener: HttpListener = await startHttpServer(
    port,
    host,
    (request, response) => {
      const path = requestPath(request.url);

      if (path === '/health') {
        sendJson(response, 200, { status: 'ok', role: 'hub', protocolVersion: PROTOCOL_VERSION });
        return;
      }

      if (path === CLIENT_TICKET_PATH) {
        const answer = answerTicketRequest(
          { method: request.method, authorization: request.headers.authorization },
          { token: clientToken, tickets },
        );
        if (answer.status === 401) logger.warn('client refused', { path });
        sendJson(response, answer.status, answer.body);
        return;
      }

      sendJson(response, 404, { error: 'not found' });
    },
    HTTP_TIMEOUTS,
    // The same port the health check is on. One inbound port per process is the
    // promise both roles make to whoever opens the firewall, and the client
    // socket is not an exception to it.
    sockets.onUpgrade,
  );

  logger.info('hub listening', {
    port: listener.port,
    hubId,
    servers: connections.snapshot().length,
  });

  return {
    hubId,
    port: listener.port,
    connections,
    state,
    clients,
    async stop() {
      // Clients first. Every server dropping in turn is a real sequence of
      // changes, and a client still attached through the shutdown would be sent
      // each one -- a screen that reports the fleet collapsing when what is
      // actually happening is that the hub is going away.
      clients.stop();
      // Then the sockets those clients were served on. An upgraded connection
      // is not an HTTP request, so closing the listener below does not reach
      // it, and a live websocket would hold the process open after everything
      // it could ask about had stopped.
      sockets.close();
      // Then outbound. The dials are what hold sockets open and what would
      // otherwise still be retrying while the listener is closing.
      await connections.stop();
      await listener.close();
      logger.info('hub stopped');
    },
  };
}
