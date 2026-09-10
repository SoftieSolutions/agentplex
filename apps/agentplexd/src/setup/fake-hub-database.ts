import { fileURLToPath } from 'node:url';
import type { Queryable } from '../hub/db/database.js';
import { loadMigrations } from '../hub/db/migration-files.js';
import { nodeMigrationFileSystem } from '../hub/db/node-migration-files.js';
import { createSqliteDatabase, type SqliteDatabase } from '../hub/db/sqlite.js';
import type { HubDatabase, HubDatabaseResult } from './hub-database.js';

/**
 * A hub database that lives in memory and holds real rows.
 *
 * A real implementation of the seam rather than a mock, for the reason the rest
 * of them are: what matters about the pairing step is the row it leaves behind
 * and the second run that does not leave another one, and neither is observable
 * against something that only records the calls.
 *
 * The schema is the application's own migrations, because a pairing this build
 * writes has to be one this build's hub can read back. It is applied by running
 * the files rather than through `migrate`, which is what `test-migrated-schema`
 * does and for the same reason: what a suite needs from here is the tables.
 *
 * One connection per path, kept between opens, because an in-memory database
 * belongs to its connection -- and because "the second run finds the first run's
 * row" is exactly the property being asserted.
 *
 * Test support: `tsconfig.build.json` excludes `fake-*.ts`, so this never ships.
 */

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../migrations', import.meta.url));

export interface FakeHubDatabaseOptions {
  /** Paths that cannot be opened: a directory that is not there, a read-only disk. */
  readonly unopenable?: readonly string[];
}

export interface FakeHubDatabase extends HubDatabase {
  /** Every path an open was attempted at, in order. Empty means none was opened. */
  readonly opened: readonly string[];
  /** The database at `path`, for a test that reads the rows back. `null` if never opened. */
  at(path: string): Queryable | null;
  /** Releases every connection. A suite that opened one owes this. */
  close(): Promise<void>;
}

export function createFakeHubDatabase(options: FakeHubDatabaseOptions = {}): FakeHubDatabase {
  const unopenable = new Set(options.unopenable ?? []);
  const databases = new Map<string, SqliteDatabase>();
  const opened: string[] = [];

  const migrated = async (path: string): Promise<SqliteDatabase> => {
    const existing = databases.get(path);
    if (existing !== undefined) return existing;

    const database = createSqliteDatabase(':memory:');
    const migrations = await loadMigrations(MIGRATIONS_DIRECTORY, nodeMigrationFileSystem);
    for (const migration of migrations) await database.query(migration.sql);
    databases.set(path, database);
    return database;
  };

  return {
    opened,

    at: (path) => databases.get(path) ?? null,

    async withDatabase<T>(
      path: string,
      body: (database: Queryable) => Promise<T>,
    ): Promise<HubDatabaseResult<T>> {
      opened.push(path);
      if (unopenable.has(path)) {
        return { ok: false, problem: `cannot open the hub database at ${path}: ENOENT` };
      }
      return { ok: true, value: await body(await migrated(path)) };
    },

    async close() {
      for (const database of databases.values()) await database.close();
      databases.clear();
    },
  };
}
