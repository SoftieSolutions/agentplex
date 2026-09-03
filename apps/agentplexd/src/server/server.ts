import { PROTOCOL_VERSION, type ServerId, type StoreDescriptor } from '@agentplex/protocol';
import type { Clock } from '../shared/clock.js';
import { HTTP_TIMEOUTS, sendJson, startHttpServer, type HttpListener } from '../shared/http.js';
import type { IdGenerator } from '../shared/ids.js';
import type { Logger } from '../shared/logger.js';
import type { TokenMinter } from '../shared/tokens.js';
import { createWebSocketListener } from '../shared/ws-message-socket.js';
import { serveHubConnection } from './hub-connection.js';
import type { OperationRegistry } from './operations/operation-registry.js';
import type { ProviderRegistry } from './providers/provider-registry.js';
import { ensureServerIdentity } from './server-identity.js';
import { createSessionController } from './session-control.js';
import type { TerminalManager } from './terminal-manager.js';
import { ensureStores, type StoreFileSystem } from './store-identity.js';

/**
 * The server role.
 *
 * A session runner and nothing else: it holds no database, and it dials out to
 * nothing. The hub dials it. Milestone 2 gives it the one durable fact it
 * owns — the identity of each store it has mounted — which is what every
 * session id it later reports is scoped by. It also holds the one thing here
 * that starts processes, the PTY supervisor, because a shutdown that does not
 * reach the agents it started has not shut anything down.
 */

export interface SessionServerDependencies {
  readonly logger: Logger;
  readonly ids: IdGenerator;
  readonly host: string;
  readonly port: number;
  /** Store roots from configuration, already absolute and deduplicated. */
  readonly storePaths: readonly string[];
  readonly storeFileSystem: StoreFileSystem;
  /**
   * Where this server's own identity and pairing token live, absolute.
   *
   * Not in a store: a store is a volume two servers may mount at once, and an
   * identity written there would hand both of them the same name and secret.
   */
  readonly identityPath: string;
  /** Where the pairing token comes from the first time this server starts. */
  readonly tokens: TokenMinter;
  /** The adapters this build can drive. An empty registry finds nothing and says nothing. */
  readonly providers: ProviderRegistry;
  readonly clock: Clock;
  /**
   * The one thing on this server that starts processes.
   *
   * It is held here rather than made here so that shutdown can reach it. A
   * server that closes its port and leaves agents running has not stopped: the
   * processes keep the store's transcripts moving, the next server to start
   * finds sessions it did not launch and cannot drive, and on a laptop they
   * outlive the terminal that started them.
   *
   * Shutdown is also the only thing besides the cap that closes a terminal:
   * nothing here runs an idle timer, and a session whose last tab closed goes
   * on working.
   */
  readonly terminals: TerminalManager;
  /**
   * The one thing on this server that starts anything else.
   *
   * Every non-PTY child comes from here: a name, a parsed request, an argv this
   * process built, `shell: false`. The division with the terminals above is by
   * shape of process rather than by trust — an interactive session is a pty
   * that lives for hours and is written to, a one-shot operation is a program
   * that answers a question and exits — and neither of them takes an argv
   * element off the wire. What a launch plan is to the PTY path, an operation
   * is to this one.
   *
   * It is a dependency rather than something the server builds, because the
   * runner underneath it decides what environment children inherit, and only
   * `main` may read this process's environment.
   */
  readonly operations: OperationRegistry;
}

export interface SessionServer {
  readonly port: number;
  /** What this server calls itself to every hub that dials it. */
  readonly serverId: ServerId;
  /** The stores this server can speak for. A store it could not read is not in here. */
  readonly stores: readonly StoreDescriptor[];
  stop(): Promise<void>;
}

export async function startSessionServer(
  dependencies: SessionServerDependencies,
): Promise<SessionServer> {
  const {
    host,
    port,
    ids,
    storePaths,
    storeFileSystem,
    identityPath,
    tokens,
    providers,
    clock,
    terminals,
    operations,
  } = dependencies;
  const logger = dependencies.logger.child({ role: 'server' });

  // Before anything is served, and fatally. A store that cannot be read costs
  // itself; an identity that cannot be read costs the whole server, because
  // every alternative is worse: minting a fresh one would present this machine
  // to the hub as a server nobody has paired, with a token the user has never
  // seen, and the only symptom would be a paired server that quietly stopped
  // answering.
  const identity = await ensureServerIdentity(identityPath, {
    files: storeFileSystem,
    ids,
    tokens,
  });
  if (!identity.ok) {
    throw new Error(`agentplexd cannot establish its server identity: ${identity.problem}`);
  }

  // The path, never the token. The file is where the operator reads the token
  // to paste into the hub, and a secret in a log line is one that has to be
  // rotated. `logger.ts` would redact a `token` field anyway; not gathering it
  // is the version that does not depend on remembering.
  logger.info(identity.minted ? 'server identity minted' : 'server identity loaded', {
    serverId: identity.identity.serverId,
    identityPath,
  });

  // What this build can run, said out loud at boot. The registry is closed, so
  // this line is the complete answer to "what can this server start", and an
  // operator reading it against a machine that has no `git` learns why an
  // operation refuses before anybody asks.
  logger.info('operations registered', {
    operations: operations.operations.map(({ name }) => name),
  });

  // A store that cannot be read costs itself and nothing else: the server
  // comes up, reports the stores it does have, and says out loud which one it
  // dropped and why. Refusing to start would take every healthy store offline
  // over one bad mount, and minting a fresh id over the bad one would quietly
  // orphan every session already filed under the old identity.
  const resolved = await ensureStores(storePaths, { files: storeFileSystem, ids });
  const stores: StoreDescriptor[] = [];
  for (const result of resolved) {
    if (result.ok) {
      stores.push(result.store);
      logger.info('store mounted', { ...result.store, minted: result.minted });
    } else {
      logger.error('store unavailable', { path: result.path, problem: result.problem });
    }
  }

  // The one thing here that turns a store id and a provider name into a running
  // agent. It is built once and outlives every hub connection: a socket comes
  // and goes, and the sessions this server started go on running across both.
  const sessions = createSessionController({ stores, providers, terminals, clock, logger });

  // One pass over every mounted store, so that a misconfigured store path is
  // discovered at boot rather than the first time somebody opens the client.
  // It is a log line and not a field on the returned server on purpose: a
  // snapshot taken at startup goes stale the moment a session writes, and a
  // stale list presented as current is the failure the watcher exists to
  // avoid. It goes through the same scan a hub is answered with, so there is
  // one code path that reads a store rather than two that can disagree.
  for (const store of stores) {
    const scanned = await sessions.report(store.storeId);
    logger.info('store scanned', {
      storeId: store.storeId,
      sessions: scanned?.sessions.length ?? 0,
      providers: providers.providers,
    });
  }

  // The one thing a hub can do with this server before it has proved itself:
  // open a socket. Everything past that is the handshake's to allow.
  const hubs = createWebSocketListener({
    onConnection: (socket) =>
      void serveHubConnection(socket, {
        identity: identity.identity,
        sessions,
        // Read at connection time rather than captured, so a hub that dials
        // after a store came back reachable is told what is mounted now.
        stores,
        logger,
      }),
  });

  const listener: HttpListener = await startHttpServer(
    port,
    host,
    (request, response) => {
      if (request.url === '/health') {
        sendJson(response, 200, {
          status: 'ok',
          role: 'server',
          protocolVersion: PROTOCOL_VERSION,
        });
        return;
      }
      sendJson(response, 404, { error: 'not found' });
    },
    HTTP_TIMEOUTS,
    // Same port as the health check: a server needs exactly one inbound port
    // reachable by the hub, and that is a promise to whoever opens the firewall.
    hubs.onUpgrade,
  );

  logger.info('server listening', {
    port: listener.port,
    serverId: identity.identity.serverId,
    stores: stores.length,
  });

  return {
    port: listener.port,
    serverId: identity.identity.serverId,
    stores,
    async stop() {
      // Children first. Closing the listener only stops new work arriving;
      // anything already running would go on writing into the store with
      // nothing left to watch it.
      const running = terminals.terminals.length;
      terminals.closeAll();
      // Then the hub sockets: an upgraded connection is not an HTTP request,
      // so closing the listener does not reach it, and a live websocket would
      // hold the process open after everything it could ask about had stopped.
      hubs.close();
      await listener.close();
      logger.info('server stopped', { killed: running });
    },
  };
}
