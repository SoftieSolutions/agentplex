import type {
  Clock,
  IdGenerator,
  Logger,
  SocketDialer,
  Timers,
  TokenMinter,
} from '@agentplex/node-shared';
import type { StoreFileSystem } from '@agentplex/providers';
import type { HubConfig } from './config.js';
import type { Database } from './db/database.js';
import type { MigrationFileSystem } from './db/migration-files.js';
import type { BeaconSource } from './discovery/beacon-listener.js';
import { startHub, type Hub } from './hub.js';
import type { WebAssetFileSystem } from './web/web-assets.js';

/**
 * Composition of the hub from a configuration.
 *
 * Everything the process supplies -- the database driver, the disk, the
 * logger, the id source -- arrives as a dependency, so the whole thing can be
 * started in a test against fakes and shut back down. `main` is the only
 * caller that supplies real ones.
 */
export interface HubRuntimeDependencies {
  readonly logger: Logger;
  readonly ids: IdGenerator;
  /** Named rather than imported, so no test path opens a real database by accident. */
  readonly openDatabase: (path: string) => Database;
  readonly migrationsDirectory: string;
  readonly migrationFileSystem: MigrationFileSystem;
  /**
   * The built PWA the hub serves, injected for the same reason the migrations
   * are. Where it sits is a fact about the installation -- a workspace build,
   * a layer in the image, a published package -- and `main` is the only place
   * that has read one.
   */
  readonly webAssets: WebAssetFileSystem;
  /**
   * The disk the local server's identity file is read from, through the same
   * seam the server reads it with. Injected for the reason the migrations
   * directory is.
   */
  readonly files: StoreFileSystem;
  /**
   * Where a ticket's entropy comes from. Injected rather than imported for the
   * reason the id source is, and one more: a test that redeems a ticket needs
   * to know the value, and a seam is how it does that without the entropy
   * being weaker in the build anyone actually runs.
   */
  readonly tokens: TokenMinter;
  /**
   * What the hub dials paired servers with, and the deadlines it retries on.
   * Injected so that a test drives the whole thing against fake sockets and a
   * clock it controls, and the one place a real websocket is opened stays
   * visible in `main`.
   */
  readonly dialer: SocketDialer;
  /**
   * Where the hub hears the beacons other machines send. A hub listens
   * whenever it runs; there is no setting.
   */
  readonly discovery: BeaconSource;
  readonly timers: Timers;
  readonly clock: Clock;
}

export interface HubRuntime {
  readonly hub: Hub;
  stop(): Promise<void>;
}

export async function startHubRuntime(
  config: HubConfig,
  dependencies: HubRuntimeDependencies,
): Promise<HubRuntime> {
  const {
    logger,
    ids,
    openDatabase,
    migrationsDirectory,
    migrationFileSystem,
    webAssets,
    files,
    tokens,
    dialer,
    discovery,
    timers,
    clock,
  } = dependencies;

  const database = openDatabase(config.databaseFile);

  // Torn back down on failure: a half-started process that keeps a port open
  // is harder to diagnose than one that exited.
  let hub: Hub;
  try {
    hub = await startHub({
      database,
      logger,
      ids,
      clock,
      dialer,
      discovery,
      timers,
      migrationsDirectory,
      migrationFileSystem,
      webAssets,
      files,
      host: config.host,
      port: config.port,
      clientToken: config.clientToken,
      tokens,
      // The one pairing nobody types, and it arrives as configuration: a hub
      // whose settings name no local server registers nothing.
      localServer: config.localServer,
    });
  } catch (error) {
    await database.close().catch((closing: unknown) => {
      logger.error('shutdown step failed', { what: 'database', error: String(closing) });
    });
    throw error;
  }

  logger.info('agentplex hub started');

  let stopped = false;
  return {
    hub,
    async stop() {
      if (stopped) return;
      stopped = true;
      await shutDown(hub, database, logger);
      logger.info('agentplex hub stopped');
    },
  };
}

/**
 * Shuts the hub and then its database down, and reports the first failure at
 * the end. The database must not stay open because the listener would not
 * close: a handle that outlives the shutdown holds the file against the next
 * start.
 */
async function shutDown(hub: Hub, database: Database, logger: Logger): Promise<void> {
  const failures: unknown[] = [];

  for (const [what, close] of [
    ['hub', () => hub.stop()],
    ['database', () => database.close()],
  ] as const) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
      logger.error('shutdown step failed', { what, error: String(error) });
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, 'the hub did not shut down cleanly');
  }
}
