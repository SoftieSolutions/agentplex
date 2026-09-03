import { PROTOCOL_VERSION, type StoreDescriptor } from '@agentplex/protocol';
import type { Clock } from '../shared/clock.js';
import { sendJson, startHttpServer, type HttpListener } from '../shared/http.js';
import type { IdGenerator } from '../shared/ids.js';
import type { Logger } from '../shared/logger.js';
import type { ProviderRegistry } from './providers/provider-registry.js';
import { discoverStoreSessions, noLiveSessions } from './providers/store-discovery.js';
import { ensureStores, type StoreFileSystem } from './store-identity.js';

/**
 * The server role.
 *
 * A session runner and nothing else: it holds no database, and it dials out to
 * nothing. The hub dials it. Milestone 2 gives it the one durable fact it
 * owns — the identity of each store it has mounted — which is what every
 * session id it later reports is scoped by. The provider adapters and the PTY
 * supervisor follow.
 */

export interface SessionServerDependencies {
  readonly logger: Logger;
  readonly ids: IdGenerator;
  readonly host: string;
  readonly port: number;
  /** Store roots from configuration, already absolute and deduplicated. */
  readonly storePaths: readonly string[];
  readonly storeFileSystem: StoreFileSystem;
  /** The adapters this build can drive. An empty registry finds nothing and says nothing. */
  readonly providers: ProviderRegistry;
  readonly clock: Clock;
}

export interface SessionServer {
  readonly port: number;
  /** The stores this server can speak for. A store it could not read is not in here. */
  readonly stores: readonly StoreDescriptor[];
  stop(): Promise<void>;
}

export async function startSessionServer(
  dependencies: SessionServerDependencies,
): Promise<SessionServer> {
  const { host, port, ids, storePaths, storeFileSystem, providers, clock } = dependencies;
  const logger = dependencies.logger.child({ role: 'server' });

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

  // One pass over every mounted store, so that a misconfigured store path is
  // discovered at boot rather than the first time somebody opens the client.
  // It is a log line and not a field on the returned server on purpose: a
  // snapshot taken at startup goes stale the moment a session writes, and a
  // stale list presented as current is the failure the watcher exists to
  // avoid. Nothing is running yet, and `noLiveSessions` says so honestly.
  for (const store of stores) {
    const found = await discoverStoreSessions(store, {
      registry: providers,
      clock,
      liveness: noLiveSessions,
    });
    logger.info('store scanned', {
      storeId: store.storeId,
      sessions: found.sessions.length,
      providers: providers.providers,
    });
    for (const { provider, subject, problem } of found.problems) {
      logger.warn('session unreadable', { provider, subject, problem });
    }
  }

  const listener: HttpListener = await startHttpServer(port, host, (request, response) => {
    if (request.url === '/health') {
      sendJson(response, 200, { status: 'ok', role: 'server', protocolVersion: PROTOCOL_VERSION });
      return;
    }
    sendJson(response, 404, { error: 'not found' });
  });

  logger.info('server listening', { port: listener.port, stores: stores.length });

  return {
    port: listener.port,
    stores,
    async stop() {
      await listener.close();
      logger.info('server stopped');
    },
  };
}
