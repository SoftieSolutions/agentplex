import { PROTOCOL_VERSION, type HubId } from '@agentplex/protocol';
import { sendJson, startHttpServer, type HttpListener } from '../shared/http.js';
import type { Clock } from '../shared/clock.js';
import type { Logger } from '../shared/logger.js';
import type { IdGenerator } from '../shared/ids.js';
import type { SocketDialer } from '../shared/message-socket.js';
import type { Timers } from '../shared/timers.js';
import {
  startConnectionSupervisor,
  type ConnectionSupervisor,
} from './connections/connection-supervisor.js';
import type { Database } from './db/database.js';
import { loadMigrations, type MigrationFileSystem } from './db/migration-files.js';
import { migrate } from './db/migrations.js';
import { ensureHubIdentity } from './hub-identity.js';
import { createReducer, type Reducer } from './state/reducer.js';

/**
 * The hub role.
 *
 * Milestone 1 brought up what everything later stands on: the database is
 * migrated before anything is served, the hub knows its own id, and it answers
 * a health check. Milestone 3 adds the outbound half -- the hub dials every
 * paired server and keeps dialling, and the reducer merges what they report
 * into one state. The client socket that broadcasts it arrives next.
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
  stop(): Promise<void>;
}

export async function startHub(dependencies: HubDependencies): Promise<Hub> {
  const {
    database,
    ids,
    clock,
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

  const connections = await startConnectionSupervisor({
    database,
    dialer,
    hubId,
    timers,
    clock,
    logger,
    onChange: (report) => state.applyConnection(report),
  });

  const listener: HttpListener = await startHttpServer(port, host, (request, response) => {
    if (request.url === '/health') {
      sendJson(response, 200, { status: 'ok', role: 'hub', protocolVersion: PROTOCOL_VERSION });
      return;
    }
    sendJson(response, 404, { error: 'not found' });
  });

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
    async stop() {
      // Outbound first. The dials are what hold sockets open and what would
      // otherwise still be retrying while the listener is closing.
      await connections.stop();
      await listener.close();
      logger.info('hub stopped');
    },
  };
}
