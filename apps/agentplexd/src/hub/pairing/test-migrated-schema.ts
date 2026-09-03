import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMigrations } from '../db/migration-files.js';
import { nodeMigrationFileSystem } from '../db/node-migration-files.js';
import { createSqliteDatabase, type SqliteDatabase } from '../db/sqlite.js';

/**
 * A private, migrated database for one integration suite.
 *
 * This was schema machinery once. Against Postgres every suite shared one
 * server, the migration suite reset itself by dropping `public` between tests,
 * and a suite that put its tables there would have them vanish mid-run in a
 * way that reads as a flake rather than a collision -- so each suite took a
 * schema named after itself and reached it through the connection's
 * `search_path`. A database that is a file needs none of that: a temporary
 * directory is the isolation, `close` is `rm`, and two suites cannot collide
 * because they were never in the same place. What is left is small enough to
 * read in one go, which is the point.
 *
 * The migrations are executed directly rather than through `migrate`, as
 * before: what a suite needs from here is the tables, and whether the runner
 * puts them there correctly is the migration suite's question and already
 * asked. `query` carries a whole migration file because the driver sends a
 * multi-statement script to `exec` rather than preparing only its first
 * statement.
 *
 * Test support: `tsconfig.build.json` excludes `test-*.ts`, so this never ships.
 */

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../../migrations', import.meta.url));

export interface MigratedSchema {
  readonly database: SqliteDatabase;
  /** Closes the database and deletes the directory holding it. */
  close(): Promise<void>;
}

/**
 * `name` reaches a directory name, so it is checked rather than trusted. It no
 * longer reaches any DDL, which is why this can be a loose rule about
 * filenames instead of the strict one an interpolated schema name needed.
 */
const SUITE_NAME = /^[a-z][a-z0-9-]*$/;

export async function openMigratedSchema(name: string): Promise<MigratedSchema> {
  if (!SUITE_NAME.test(name)) {
    throw new Error(`${JSON.stringify(name)} is not a usable suite name`);
  }

  const directory = await mkdtemp(join(tmpdir(), `agentplex-${name}-`));
  const database = createSqliteDatabase(join(directory, 'hub.db'));
  const migrations = await loadMigrations(MIGRATIONS_DIRECTORY, nodeMigrationFileSystem);
  for (const migration of migrations) await database.query(migration.sql);

  return {
    database,
    async close() {
      await database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
