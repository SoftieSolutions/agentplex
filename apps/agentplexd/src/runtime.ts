import type { Config } from './config/config.js';
import type { Database } from './hub/db/database.js';
import type { MigrationFileSystem } from './hub/db/migration-files.js';
import { startHub, type Hub } from './hub/hub.js';
import type { OperationRegistry } from './server/operations/operation-registry.js';
import type { ProviderRegistry } from './server/providers/provider-registry.js';
import { startSessionServer, type SessionServer } from './server/server.js';
import type { TerminalManager } from './server/terminal-manager.js';
import type { StoreFileSystem } from './server/store-identity.js';
import type { Clock } from './shared/clock.js';
import type { IdGenerator } from './shared/ids.js';
import type { Logger } from './shared/logger.js';

/**
 * Composition of the roles a configuration asks for.
 *
 * Everything the process supplies — the database driver, the disk, the logger,
 * the id source — arrives as a dependency, so the whole runtime can be started
 * in a test against fakes and shut back down.
 */
export interface RuntimeDependencies {
  readonly logger: Logger;
  readonly ids: IdGenerator;
  /** Named rather than imported, so no test path opens a real database by accident. */
  readonly openDatabase: (path: string) => Database;
  readonly migrationsDirectory: string;
  readonly migrationFileSystem: MigrationFileSystem;
  /** The store volumes, injected for the same reason the migrations directory is. */
  readonly storeFileSystem: StoreFileSystem;
  /**
   * The provider adapters this process runs with.
   *
   * Built in `main` rather than imported here, so that a test can start the
   * whole runtime against a store of fixtures without a real Claude Code
   * transcript existing anywhere, and so that "which providers does this build
   * drive" is one visible line in the entrypoint.
   */
  readonly providers: ProviderRegistry;
  /**
   * The terminal manager the server role starts sessions on, and the supervisor
   * underneath it. Injected for the same reason the providers are: a test
   * starts the whole runtime without forking anything, and the one place a real
   * pty is opened stays visible in `main`. It is built there rather than here
   * because its cap is configuration, and only `main` has read the config.
   */
  readonly terminals: TerminalManager;
  /**
   * The server role's operation registry: every child that is not a pty.
   *
   * Injected for the same reason the terminals are. The runner underneath it
   * fixes the environment children inherit, and `main` is the only place
   * allowed to read this process's environment; a registry built here would
   * have to reach for `process.env` two layers below the entrypoint.
   */
  readonly operations: OperationRegistry;
  readonly clock: Clock;
}

export interface Runtime {
  readonly hub: Hub | null;
  readonly server: SessionServer | null;
  stop(): Promise<void>;
}

export async function startRuntime(
  config: Config,
  dependencies: RuntimeDependencies,
): Promise<Runtime> {
  const {
    logger,
    ids,
    openDatabase,
    migrationsDirectory,
    migrationFileSystem,
    storeFileSystem,
    providers,
    terminals,
    operations,
    clock,
  } = dependencies;
  // The interface to bind is a setting like any other, so it arrives with the
  // rest of them rather than as a dependency the process reads for itself.
  const host = config.host;

  const database = 'hub' in config ? openDatabase(config.hub.databaseFile) : null;

  // Started one at a time, and torn back down on failure: a half-started
  // process that keeps a port open is harder to diagnose than one that exited.
  let hub: Hub | null = null;
  let server: SessionServer | null = null;

  try {
    if ('hub' in config && database !== null) {
      hub = await startHub({
        database,
        logger,
        ids,
        clock,
        migrationsDirectory,
        migrationFileSystem,
        host,
        port: config.hub.port,
      });
    }
    if ('server' in config) {
      server = await startSessionServer({
        logger,
        ids,
        host,
        port: config.server.port,
        storePaths: config.server.storePaths,
        storeFileSystem,
        providers,
        terminals,
        operations,
        clock,
      });
    }
  } catch (error) {
    await shutDown(hub, server, database, logger);
    throw error;
  }

  logger.info('agentplexd started', { role: config.role });

  let stopped = false;
  return {
    hub,
    server,
    async stop() {
      if (stopped) return;
      stopped = true;
      await shutDown(hub, server, database, logger);
      logger.info('agentplexd stopped');
    },
  };
}

/**
 * Shuts every part down and reports the first failure at the end.
 *
 * One half failing to close must not leave the other half running: a listener
 * that outlives the shutdown holds the port against the next start.
 */
async function shutDown(
  hub: Hub | null,
  server: SessionServer | null,
  database: Database | null,
  logger: Logger,
): Promise<void> {
  const failures: unknown[] = [];

  for (const [what, close] of [
    ['server', () => server?.stop()],
    ['hub', () => hub?.stop()],
    ['database', () => database?.close()],
  ] as const) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
      logger.error('shutdown step failed', { what, error: String(error) });
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, 'agentplexd did not shut down cleanly');
  }
}
