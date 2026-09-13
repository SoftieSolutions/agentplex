import type { HubId } from '@agentplex/protocol';
import {
  HTTP_TIMEOUTS,
  startHttpServer,
  type HttpListener,
  type Clock,
  type Logger,
  type IdGenerator,
  closure,
  CLOSE_POLICY,
  type SocketDialer,
  type Timers,
  type TokenMinter,
  createWebSocketListener,
} from '@agentplex/node-shared';
import type { StoreFileSystem } from '@agentplex/providers';
import type { Database } from './db/database.js';
import { loadMigrations, type MigrationFileSystem } from './db/migration-files.js';
import { migrate } from './db/migrations.js';
import {
  createClientAuth,
  requestPath,
  NOT_AUTHORIZED,
} from './features/client-auth/client-auth.js';
import { createCatalogue } from './features/catalogue/catalogue.js';
import { createClients, type Clients } from './features/clients/clients.js';
import { createDiscovery, type BeaconSource } from './features/discovery/discovery.js';
import { createFleetState, type FleetState } from './features/fleet-state/fleet-state.js';
import { createMcp } from './features/mcp/mcp.js';
import { createPairing, type LocalServerEntry } from './features/pairing/pairing.js';
import { createPaneLayout } from './features/pane-layout/pane-layout.js';
import { createProjects } from './features/projects/projects.js';
import { createServers, type Servers } from './features/servers/servers.js';
import { createSessions } from './features/sessions/sessions.js';
import { createWeb, type WebAssetFileSystem } from './features/web/web.js';
import { createHubRoutes } from './http/routes.js';
import { ensureHubIdentity } from './hub-identity.js';

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
 *
 * What is left in this file is composition and nothing else. Every part of the
 * hub is a feature behind its own entry file, and this is the one place that
 * knows the concrete set: which seam each of them gets, which of them is handed
 * to which, and in what order they are allowed to start. The route chain moved
 * to `http/routes.ts`, which is where the argument for one origin now lives.
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
   * Where beacons are heard.
   *
   * Required rather than optional, because listening is unconditional:
   * hearing a machine announce itself costs nothing and grants nothing, so
   * there is no setting to consult and no state in which a hub is running and
   * deliberately deaf. Announcing, on the other side, is opt-in — that
   * asymmetry is the design, and this is the half of it that has no switch.
   *
   * A seam for the reason the dialer is one: every test in this repository
   * that starts a hub would otherwise open a UDP port on the machine running
   * the suite.
   */
  readonly discovery: BeaconSource;
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
  /**
   * The built PWA, on whatever disk it turned out to be on.
   *
   * A dependency rather than a directory this file opens, for the reason the
   * migrations are one and for one more: where the client lives is a fact
   * about how agentplex was installed — a workspace build, a layer in the
   * image, a published package — and the hub should serve the same way in all
   * three. `main.ts` is the only thing that knows which of them this is.
   */
  readonly webAssets: WebAssetFileSystem;
  readonly host: string;
  readonly port: number;
  /**
   * The server on this machine, if the hub's settings name one, paired at boot
   * from the token in its identity file. `null` is most hubs: nothing is
   * registered and nothing is said. See `pairing/local-server.ts` for the
   * bounds of the one pairing nobody types.
   */
  readonly localServer: LocalServerEntry | null;
  /**
   * The disk the identity file is read from, through the same seam the server
   * reads it with. Injected for the reason the migrations directory is, and for
   * one more: a test pairs a local server from a file it wrote down.
   */
  readonly files: StoreFileSystem;
}

export interface Hub {
  readonly hubId: HubId;
  readonly port: number;
  /**
   * The paired servers and what the hub can reach. Exposed because it is the
   * live half of the hub's state: the fleet state reads it, and a listing that
   * shows a store has to be able to say whether anybody can still reach it.
   */
  readonly connections: Servers;
  /**
   * Everything every server has reported, merged: one store per volume, one
   * session list under it, and the servers attached to it. The read surface
   * the client broadcast is built on, and the only place a session row is
   * assembled.
   */
  readonly state: FleetState;
  /**
   * Every attached client, and the pipeline that keeps them all looking at the
   * same thing. An authenticated socket is handed to `attach` and becomes a
   * client; nothing else in the hub sends a client anything.
   */
  readonly clients: Clients;
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
    discovery,
    timers,
    migrationsDirectory,
    migrationFileSystem,
    webAssets,
    host,
    port,
    localServer,
    files,
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

  const pairing = createPairing({ database, files, ids, clock, logger });

  // Before anything reads the pairing table, so that the row a first boot
  // writes is dialled on that boot and not the next one. After the migrations,
  // because it is a row in a table they make.
  await pairing.registerLocalServer(localServer);

  // Built before the servers feature, because that starts dialling the moment
  // it is told to sync and a connection that came up before there was anywhere
  // to put it would be a state that is wrong until the next change.
  const state = createFleetState({ logger });

  // Started before anything is served, because a machine that announced itself
  // while the hub was coming up should be on the pairing screen when somebody
  // opens it, rather than up to five seconds later. Nothing it hears is
  // written down: candidates live in the fleet state's own collection beside
  // the paired servers and never among them, and a hub that restarts knows
  // nothing about the network until it is announced to again -- which is the
  // honest state, because a claim read back off a disk is a claim nobody made
  // today.
  const beacons = createDiscovery({ source: discovery, clock, timers, logger });
  beacons.subscribe((candidates) => void state.applyCandidates(candidates));

  // The tree, read from the database per request rather than held in memory
  // beside the fleet state. It is durable and the fleet state is not: where the
  // user put things survives a restart, and which sessions are reachable this
  // second does not.
  //
  // Built before the servers feature for the reason the fleet state is: it is
  // told about a store the moment one is read, and a report that arrived before
  // there was anywhere to put it would leave the tree behind until the next
  // one. It reads a store through the reducer rather than from the report,
  // which is the decision `catalogue.ts` argues: the tree follows what the hub
  // believes is in a store, not what the one server that spoke last could see.
  const catalogue = createCatalogue({
    database,
    ids,
    clock,
    logger,
    readStore: (storeId) => state.storeSessions(storeId),
    // Which project a directory is, so that a session reported from one is
    // filed under it. Reached through a call rather than by holding the
    // feature, and that is this file's ordering rather than a seam of its own:
    // the tree has to exist before the servers feature, because a report is
    // handed to it, and projects has to exist after it, because a browse goes
    // out over a connection. Nothing asks this question until a store has been
    // reported, which is after `sync` far below.
    projects: { findByDirectory: (directory) => projects.findByDirectory(directory) },
    // Who is running a session, asked at the moment a removal is decided. The
    // tree is durable and this is a claim about right now, which is the whole
    // reason it is a seam rather than a column: a node the user removed while
    // its process ran would be a process still going with nothing on any
    // screen pointing at it.
    readHolder: (ref) => state.sessionHolder(ref),
  });

  // Constructed here and dialling nothing yet. That is what the split between
  // building this and calling `sync` below buys: everything that has to see a
  // connectivity change -- the fleet state, and the broadcast attached to it --
  // exists before the first change can happen, and no part of this file holds a
  // reference that is null for part of a startup.
  const servers = createServers({
    pairing,
    dialer,
    hubId,
    timers,
    clock,
    logger,
    onChange: (report) => state.applyConnection(report),
    onReport: (report) => {
      // Stamped with the hub's clock and not the server's. Two machines' clocks
      // disagree, and a hub comparing readings dated by the machines that made
      // them is comparing two different times.
      const accepted = state.applySessions({
        registrationId: report.registrationId,
        storeId: report.storeId,
        sessions: report.sessions,
        holding: report.holding,
        reportedAt: clock.now(),
      });
      // Only what the reducer took. A report from a server the hub holds no
      // connection to, or for a store that server has not mounted, is refused
      // there because the hub cannot place it -- and a tree built on one would
      // name sessions the state on the same screen does not have.
      //
      // Not awaited, and nothing on this path may await it: a server's report
      // is answered by the fleet state and the broadcast, and the tree write is
      // what happens after that. A failed one costs this store's tree update
      // and is logged where it happened.
      if (accepted) void catalogue.observe(report.storeId);
    },
  });

  // Projects: the rows a user makes, and the browse a directory is picked with.
  // The rule about which directories may be browsed is not this hub's -- it is
  // checked against roots that machine's operator configured -- so what this
  // feature adds is the one fact a server cannot have: whether the hub holds a
  // connection to ask down at all. What it owns outright is the record: a name,
  // a directory, and the node the tree shows it as.
  const projects = createProjects({
    database,
    ids,
    clock,
    state,
    connections: servers,
    logger,
    // A project is a node, so making one changes the tree, and the tree has one
    // version whoever wrote it. See `project-rows.ts` for why this feature
    // writes `nodes` at all, and `catalogue.ts` for why the number is the
    // catalogue's to keep.
    onTreeChanged: () => catalogue.changed(),
  });

  const sessions = createSessions({ state, projects, connections: servers, logger });

  // Read per request for the reason the tree above is, and durable for the
  // same one: an arrangement of panes outlives the process that was told it.
  const paneLayout = createPaneLayout({ database, clock });

  // Subscribed before the first server is dialled, so that the first
  // connectivity change has somewhere to go. A client that attached a moment
  // later would still see it -- the state is whole and read at the moment it is
  // sent -- but a broadcast that missed changes it was running for would be a
  // pipeline whose correctness depended on start order.
  const clients = createClients({
    hubId,
    state,
    timers,
    logger,
    readLayout: () => catalogue.readLayout(),
    readPaneLayout: () => paneLayout.read(),
    writePaneLayout: (layout) => paneLayout.write(layout),
    sessions,
    pairing,
    // The other half of a pairing frame: the row is the pairing feature's to
    // write, and dialling what the row now says is the supervisor's to do. A
    // hub that recorded a pairing and waited for a restart to dial it would be
    // a settings screen whose successful answer is followed by nothing.
    syncServers: () => servers.sync(),
    projects,
    catalogue,
  });

  // Not awaited past its first read of the pairing table, and started before
  // the port is opened. A server that is switched off must not delay the hub
  // coming up: it is marked stale, dialled again on a backoff, and the hub
  // serves in the meantime with its rows labelled rather than absent.
  await servers.sync();

  // The short-lived half of client auth. Nothing durable: a ticket outliving a
  // restart would be a credential the hub could not count the uses of, and the
  // client holds the long-lived token it can always exchange for another.
  const clientAuth = createClientAuth({ token: clientToken, tokens, clock });

  // A socket is admitted by its ticket and then handed straight to the
  // broadcast. There is no third state: either the ticket was good and this is
  // a client, or it was not and the socket is closed before it has been read
  // from. `onConnection` is where the check lives rather than `onUpgrade`,
  // because a refusal has to be a 1008 close and a close is only available once
  // the upgrade has completed -- a browser handed a failed upgrade is told
  // nothing it can act on, and telling the user "not authorized" is the point.
  const sockets = createWebSocketListener({
    onConnection: (socket, request) => {
      if (!clientAuth.admitsUpgrade(request.url ?? '')) {
        // The path and nothing else. The URL carries the ticket, so logging the
        // request target would be logging the credential.
        logger.warn('client refused', { path: requestPath(request.url) });
        socket.close(closure(CLOSE_POLICY, NOT_AUTHORIZED));
        return;
      }
      clients.attach(socket);
    },
  });

  // Behind the same token the exchange above checks, on the same port, and
  // built here rather than inside the route chain for the reason every other
  // feature is: this file is the only one that knows the concrete set. It holds
  // no session and nothing durable, so it is the last thing that has to be
  // built and the first of the two that has to be stopped.
  const mcp = createMcp({ hubId, clientToken, logger });

  const web = createWeb({ files: webAssets, logger });

  // Asked once, before the port is open, so that a hub with nothing to serve
  // says so in the first lines of its log rather than in a 503 nobody is
  // watching for. It is a warning and not a failure: this hub still owns the
  // database, still dials every paired server and still answers a health
  // check, and refusing to start would take a fleet down over a directory
  // that did not get copied.
  await web.reportBuild();

  const listener: HttpListener = await startHttpServer(
    port,
    host,
    createHubRoutes({ clientAuth, mcp, web, logger }),
    HTTP_TIMEOUTS,
    // The same port the health check is on. One inbound port per process is the
    // promise both roles make to whoever opens the firewall, and the client
    // socket is not an exception to it.
    sockets.onUpgrade,
  );

  logger.info('hub listening', {
    port: listener.port,
    hubId,
    servers: servers.snapshot().length,
  });

  return {
    hubId,
    port: listener.port,
    connections: servers,
    state,
    clients,
    async stop() {
      // Clients first. Every server dropping in turn is a real sequence of
      // changes, and a client still attached through the shutdown would be sent
      // each one -- a screen that reports the fleet collapsing when what is
      // actually happening is that the hub is going away.
      clients.stop();
      // Then the ear. Nobody is left to be told what the network says, and a
      // beacon arriving mid-shutdown would otherwise bump a state whose
      // readers have all been closed.
      beacons.stop();
      // Then the sockets those clients were served on. An upgraded connection
      // is not an HTTP request, so closing the listener below does not reach
      // it, and a live websocket would hold the process open after everything
      // it could ask about had stopped.
      sockets.close();
      // Then whatever an agent was in the middle of asking. An MCP request has
      // a server and a transport behind it that closing the listener does not
      // reach, and a tool still running would be one reading a fleet state
      // whose parts are being stopped underneath it.
      await mcp.close();
      // Then outbound. The dials are what hold sockets open and what would
      // otherwise still be retrying while the listener is closing.
      await servers.stop();
      await listener.close();
      logger.info('hub stopped');
    },
  };
}
