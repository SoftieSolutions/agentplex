import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadMigrations } from './migration-files.js';
import { nodeMigrationFileSystem } from './node-migration-files.js';
import { migrate, type Migration } from './migrations.js';
import { createSqliteDatabase, type SqliteDatabase } from './sqlite.js';
import { ensureHubIdentity } from '../hub-identity.js';
import { createLogger } from '../../shared/logger.js';
import { randomIdGenerator } from '../../shared/ids.js';

/**
 * The shipped migrations, against a real SQLite file.
 *
 * The fake in `migrations.test.ts` covers the runner's control flow; only the
 * engine can say whether the SQL is valid, whether the single-row constraint
 * holds, and what a second process meets when it tries to migrate at the same
 * time. Nothing here skips and nothing here starts a container: the database is
 * a file in a temporary directory, so this suite runs on a laptop, in CI and in
 * the image, always.
 */
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../../migrations', import.meta.url));

const directory = await mkdtemp(join(tmpdir(), 'agentplex-migrations-'));
const logger = createLogger('error', () => {});

/** The clock the schema does not supply, fixed so a stored millisecond is checkable. */
const MINTED_AT = 1_756_000_000_000;
const clock = { now: () => MINTED_AT };

let files = 0;
const open: SqliteDatabase[] = [];

function openDatabase(name: string, options?: { readonly busyTimeoutMs?: number }): SqliteDatabase {
  const database = createSqliteDatabase(join(directory, name), options);
  open.push(database);
  return database;
}

/** A fresh, empty database file, so "applies from empty" means it. */
function emptyDatabase(options?: { readonly busyTimeoutMs?: number }): SqliteDatabase {
  files += 1;
  return openDatabase(`hub-${String(files)}.db`, options);
}

async function shippedMigrations(): Promise<readonly Migration[]> {
  return loadMigrations(MIGRATIONS_DIRECTORY, nodeMigrationFileSystem);
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((database) => database.close()));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('the shipped migrations against SQLite', () => {
  it('applies every one of them to an empty database', async () => {
    const database = emptyDatabase();
    const migrations = await shippedMigrations();
    expect(migrations.length).toBeGreaterThan(0);

    const outcome = await migrate(database, migrations, logger, clock);

    expect(outcome.applied).toHaveLength(migrations.length);
  });

  it('is idempotent: a second run against a migrated file applies nothing', async () => {
    const database = emptyDatabase();
    const migrations = await shippedMigrations();
    await migrate(database, migrations, logger, clock);

    const second = await migrate(database, migrations, logger, clock);

    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toBe(migrations.length);
  });

  it('reopens a file another process migrated and applies nothing to it', async () => {
    files += 1;
    const name = `reopened-${String(files)}.db`;
    const migrations = await shippedMigrations();
    const first = openDatabase(name);
    await migrate(first, migrations, logger, clock);
    await first.close();

    // A second start of the hub is a second connection to a file that is
    // already at the current schema, which is the case every start after the
    // first one is.
    const second = openDatabase(name);
    const outcome = await migrate(second, migrations, logger, clock);

    expect(outcome.applied).toEqual([]);
    expect(outcome.alreadyApplied).toBe(migrations.length);
  });

  it('stamps the bookkeeping row with the injected clock, in epoch milliseconds', async () => {
    const database = emptyDatabase();
    const migrations = await shippedMigrations();

    await migrate(database, migrations, logger, clock);

    const result = await database.query<{ applied_at: number }>(
      'SELECT applied_at FROM schema_migrations ORDER BY version',
    );
    expect(result.rows.map((row) => row.applied_at)).toEqual(migrations.map(() => MINTED_AT));
  });

  it('refuses to open a database that has run a migration this build does not ship', async () => {
    const database = emptyDatabase();
    const migrations = await shippedMigrations();
    await migrate(database, migrations, logger, clock);
    await database.query(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (9999, ?, ?)',
      ['from_a_newer_build', MINTED_AT],
    );

    await expect(migrate(database, migrations, logger, clock)).rejects.toMatchObject({
      code: 'database-ahead',
    });
  });

  it('applies every statement of a migration that is a script, not just the first', async () => {
    const database = emptyDatabase();

    await migrate(
      database,
      [
        {
          version: 1,
          name: 'two_statements',
          sql: 'CREATE TABLE a (x integer);\nCREATE TABLE b (x integer);\n',
        },
      ],
      logger,
      clock,
    );

    const tables = await database.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('a', 'b') ORDER BY name",
    );
    expect(tables.rows.map((row) => row.name)).toEqual(['a', 'b']);
  });

  it('leaves nothing behind when a migration fails, not even the ones before it', async () => {
    const database = emptyDatabase();

    await expect(
      migrate(
        database,
        [
          { version: 1, name: 'good', sql: 'CREATE TABLE good (x integer)' },
          { version: 2, name: 'bad', sql: 'CREATE TABLE bad (' },
        ],
        logger,
        clock,
      ),
    ).rejects.toMatchObject({ code: 'apply-failed' });

    const tables = await database.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    expect(tables.rows.map((row) => row.name)).toEqual([]);
  });

  it('waits for a writer that already holds the database, then says so', async () => {
    files += 1;
    const name = `contended-${String(files)}.db`;
    const migrations = await shippedMigrations();

    // A second connection stands in for a second hub process, holding the write
    // lock for the whole attempt. Serializing two hubs against one file is the
    // database's own write lock and nothing else: `BEGIN IMMEDIATE` under a
    // busy timeout is the whole mechanism. A short timeout keeps the test
    // short; the hub's is five seconds.
    const holder = openDatabase(name);
    const contender = openDatabase(name, { busyTimeoutMs: 50 });

    let releaseHolder = (): void => {};
    const held = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    const holding = holder.transaction(async (tx) => {
      await tx.query('CREATE TABLE squatter (x integer)');
      await held;
    });

    try {
      await expect(migrate(contender, migrations, logger, clock)).rejects.toThrow(/locked|busy/i);
    } finally {
      releaseHolder();
      await holding;
    }

    // And once the holder is gone the same migration goes through, so what
    // failed was the contention and not the migration.
    const outcome = await migrate(contender, migrations, logger, clock);
    expect(outcome.applied).toHaveLength(migrations.length);
  });
});

describe('hub identity against SQLite', () => {
  it('mints one hub id and returns the same one on every later start', async () => {
    const database = emptyDatabase();
    await migrate(database, await shippedMigrations(), logger, clock);

    const first = await ensureHubIdentity(database, randomIdGenerator, clock);
    const second = await ensureHubIdentity(database, randomIdGenerator, clock);

    expect(second).toBe(first);
    const rows = await database.query<{ only_row: number; created_at: number }>(
      'SELECT only_row, created_at FROM hub_identity',
    );
    expect(rows.rows).toEqual([{ only_row: 1, created_at: MINTED_AT }]);
  });

  it('refuses a second identity row rather than making one unlikely', async () => {
    const database = emptyDatabase();
    await migrate(database, await shippedMigrations(), logger, clock);
    await ensureHubIdentity(database, randomIdGenerator, clock);

    await expect(
      database.query('INSERT INTO hub_identity (only_row, hub_id, created_at) VALUES (2, ?, ?)', [
        'a-second-hub',
        MINTED_AT,
      ]),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});
