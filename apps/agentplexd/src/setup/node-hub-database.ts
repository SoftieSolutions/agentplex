import { loadMigrations, type MigrationFileSystem } from '../hub/db/migration-files.js';
import { migrate } from '../hub/db/migrations.js';
import { createSqliteDatabase, type SqliteDatabase } from '../hub/db/sqlite.js';
import type { Clock, Logger } from '@agentplex/node-shared';
import type { HubDatabase, HubDatabaseResult } from './hub-database.js';

/**
 * The real hub database, opened from setup.
 *
 * The one module on the setup path that names the SQLite driver, for the reason
 * `sqlite.ts` is the one module the runtime names it in. Everything above this
 * is written against `Queryable` and can be tested without a file.
 *
 * Failures are values rather than exceptions, all the way through: a directory
 * that is not there, a file somebody else's hub already has the write lock on, a
 * database from a build that has migrations this one does not know. Each of them
 * is a sentence the operator can act on, and none of them is worth ending a
 * setup run that has already provisioned a machine.
 */
export interface NodeHubDatabaseDependencies {
  readonly migrationsDirectory: string;
  readonly migrationFileSystem: MigrationFileSystem;
  /**
   * Where the migration runner's own account of what it applied goes.
   *
   * Setup writes to a terminal a person is reading, not to a log, so the
   * entrypoint hands this one a level that keeps the wizard's output the
   * wizard's. What a hub start says about the same file is unchanged.
   */
  readonly logger: Logger;
  readonly clock: Clock;
}

export function createNodeHubDatabase(dependencies: NodeHubDatabaseDependencies): HubDatabase {
  return {
    async withDatabase<T>(
      path: string,
      body: (database: SqliteDatabase) => Promise<T>,
    ): Promise<HubDatabaseResult<T>> {
      let database: SqliteDatabase;
      try {
        database = createSqliteDatabase(path);
      } catch (error) {
        // The directory is not there, the file is not a database, the disk is
        // read only. All of them arrive here as a throw from the driver.
        return { ok: false, problem: `cannot open the hub database at ${path}: ${String(error)}` };
      }

      try {
        const migrations = await loadMigrations(
          dependencies.migrationsDirectory,
          dependencies.migrationFileSystem,
        );
        await migrate(database, migrations, dependencies.logger, dependencies.clock);
        return { ok: true, value: await body(database) };
      } catch (error) {
        return { ok: false, problem: `cannot use the hub database at ${path}: ${String(error)}` };
      } finally {
        // A close that fails after a committed write does not un-commit it, so
        // it costs itself: reporting it as the failure of the step would be the
        // report over-claiming in the direction that loses the truth.
        await database.close().catch(() => undefined);
      }
    },
  };
}
