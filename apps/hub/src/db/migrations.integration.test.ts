import { createHash } from 'node:crypto';
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
import { createLogger, randomIdGenerator } from '@agentplex/node-shared';

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
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../migrations', import.meta.url));

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

function digestOf(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

async function storedDigests(database: SqliteDatabase): Promise<readonly (string | null)[]> {
  const result = await database.query<{ sql_sha256: string | null }>(
    'SELECT sql_sha256 FROM schema_migrations ORDER BY version',
  );
  return result.rows.map((row) => row.sql_sha256);
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

  it('records the sha256 of every migration it applies', async () => {
    const database = emptyDatabase();
    const migrations = await shippedMigrations();

    await migrate(database, migrations, logger, clock);

    expect(await storedDigests(database)).toEqual(migrations.map((each) => digestOf(each.sql)));
  });

  it('starts over rows with no digest and fills them in from the shipped SQL', async () => {
    // What an older build rolled back onto an upgraded file leaves: its INSERT
    // names three columns, so the digest is null until this build starts again.
    const database = emptyDatabase();
    const migrations = await shippedMigrations();
    await migrate(database, migrations, logger, clock);
    await database.query('UPDATE schema_migrations SET sql_sha256 = NULL');

    const outcome = await migrate(database, migrations, logger, clock);

    expect(outcome.applied).toEqual([]);
    expect(await storedDigests(database)).toEqual(migrations.map((each) => digestOf(each.sql)));
  });

  it('refuses to open when an applied migration keeps its name but its SQL was edited', async () => {
    const database = emptyDatabase();
    const migrations = await shippedMigrations();
    await migrate(database, migrations, logger, clock);
    const [first, ...rest] = migrations;
    if (first === undefined) throw new Error('no shipped migrations');

    const edited = [{ ...first, sql: `${first.sql}\n-- edited after it ran\n` }, ...rest];

    await expect(migrate(database, edited, logger, clock)).rejects.toMatchObject({
      code: 'history-edited',
    });
  });

  it('upgrades a database whose bookkeeping table predates the digest column', async () => {
    // Built the way a build before digests left it: the three-column table,
    // each shipped migration run, and a three-column row for each.
    const database = emptyDatabase();
    const migrations = await shippedMigrations();
    await database.query(`
      CREATE TABLE schema_migrations (
        version    integer PRIMARY KEY,
        name       text    NOT NULL,
        applied_at integer NOT NULL
      )
    `);
    for (const each of migrations) {
      await database.query(each.sql);
      await database.query(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
        [each.version, each.name, MINTED_AT],
      );
    }

    const outcome = await migrate(database, migrations, logger, clock);

    expect(outcome.applied).toEqual([]);
    expect(outcome.alreadyApplied).toBe(migrations.length);
    expect(await storedDigests(database)).toEqual(migrations.map((each) => digestOf(each.sql)));
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

describe('migration 0020', () => {
  /** A database at 0019, as a hub that last ran before HOME existed left it. */
  async function atNineteen(): Promise<{
    readonly database: SqliteDatabase;
    readonly migrations: readonly Migration[];
  }> {
    const database = emptyDatabase();
    const migrations = await shippedMigrations();
    await migrate(
      database,
      migrations.filter((each) => each.version <= 19),
      logger,
      clock,
    );
    return { database, migrations };
  }

  async function insertNode(
    database: SqliteDatabase,
    node: {
      readonly id: string;
      readonly parentId: string | null;
      readonly kind: string;
      readonly position: number;
      readonly createdAt?: number;
      readonly session?: string;
    },
  ): Promise<void> {
    await database.query(
      `INSERT INTO nodes (id, parent_id, kind, position, name, name_source,
                          anchor_store_id, anchor_session_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'user', ?, ?, ?)`,
      [
        node.id,
        node.parentId,
        node.kind,
        node.position,
        node.id,
        node.session === undefined ? null : 'store-a',
        node.session ?? null,
        node.createdAt ?? MINTED_AT,
      ],
    );
    if (node.kind === 'project') {
      await database.query(
        'INSERT INTO projects (node_id, directory, created_at) VALUES (?, ?, ?)',
        [node.id, `/srv/${node.id}`, node.createdAt ?? MINTED_AT],
      );
    }
  }

  /** The ticket's tree: everything 0020 has to move, and everything it must not. */
  async function fixtureTree(database: SqliteDatabase): Promise<void> {
    await insertNode(database, {
      id: 'session-1',
      parentId: null,
      kind: 'session',
      position: 0,
      session: 's1',
    });
    await insertNode(database, {
      id: 'session-2',
      parentId: null,
      kind: 'session',
      position: 1,
      session: 's2',
    });
    await insertNode(database, { id: 'folder-a', parentId: null, kind: 'folder', position: 2 });
    await insertNode(database, {
      id: 'session-a',
      parentId: 'folder-a',
      kind: 'session',
      position: 0,
      session: 'sa',
    });
    await insertNode(database, { id: 'folder-b', parentId: null, kind: 'folder', position: 3 });
    await insertNode(database, {
      id: 'project-2',
      parentId: 'folder-b',
      kind: 'project',
      position: 0,
    });
    await insertNode(database, {
      id: 'session-p2',
      parentId: 'project-2',
      kind: 'session',
      position: 0,
      session: 'sp2',
    });
    await insertNode(database, { id: 'project-1', parentId: null, kind: 'project', position: 4 });
    await insertNode(database, {
      id: 'session-p1',
      parentId: 'project-1',
      kind: 'session',
      position: 0,
      session: 'sp1',
    });
    await insertNode(database, { id: 'doc', parentId: null, kind: 'doc', position: 5 });
  }

  async function childrenOf(
    database: SqliteDatabase,
    parentId: string | null,
  ): Promise<readonly string[]> {
    const result = await database.query<{ id: string }>(
      parentId === null
        ? 'SELECT id FROM nodes WHERE parent_id IS NULL ORDER BY position, id'
        : 'SELECT id FROM nodes WHERE parent_id = ? ORDER BY position, id',
      parentId === null ? [] : [parentId],
    );
    return result.rows.map((row) => row.id);
  }

  it('lifts every project to the root, HOME first, and gathers the rest into HOME', async () => {
    const { database, migrations } = await atNineteen();
    await fixtureTree(database);

    await migrate(database, migrations, logger, clock);

    expect(await childrenOf(database, null)).toEqual(['home', 'project-1', 'project-2']);
    expect(await childrenOf(database, 'home')).toEqual([
      'session-1',
      'session-2',
      'folder-a',
      'folder-b',
      'doc',
    ]);
    expect(await childrenOf(database, 'folder-a')).toEqual(['session-a']);
    expect(await childrenOf(database, 'folder-b')).toEqual([]);
    expect(await childrenOf(database, 'project-2')).toEqual(['session-p2']);
    expect(await childrenOf(database, 'project-1')).toEqual(['session-p1']);

    const home = await database.query(
      `SELECT kind, name, name_source, anchor_store_id, anchor_session_id, created_at
       FROM nodes WHERE id = 'home'`,
    );
    expect(home.rows).toEqual([
      {
        kind: 'project',
        name: 'HOME',
        name_source: 'user',
        anchor_store_id: null,
        anchor_session_id: null,
        created_at: 0,
      },
    ]);
    const directory = await database.query("SELECT node_id FROM projects WHERE node_id = 'home'");
    expect(directory.rows).toEqual([]);
  });

  it('keeps root projects in their order and puts lifted ones after them, oldest first', async () => {
    const { database, migrations } = await atNineteen();
    await insertNode(database, { id: 'root-late', parentId: null, kind: 'project', position: 7 });
    await insertNode(database, { id: 'root-early', parentId: null, kind: 'project', position: 3 });
    await insertNode(database, { id: 'holder', parentId: null, kind: 'folder', position: 0 });
    await insertNode(database, {
      id: 'lifted-newer',
      parentId: 'holder',
      kind: 'project',
      position: 0,
      createdAt: 20,
    });
    await insertNode(database, {
      id: 'lifted-older',
      parentId: 'holder',
      kind: 'project',
      position: 1,
      createdAt: 10,
    });

    await migrate(database, migrations, logger, clock);

    expect(await childrenOf(database, null)).toEqual([
      'home',
      'root-early',
      'root-late',
      'lifted-older',
      'lifted-newer',
    ]);
    const positions = await database.query<{ id: string; position: number }>(
      'SELECT id, position FROM nodes WHERE parent_id IS NULL ORDER BY position, id',
    );
    expect(positions.rows.map((row) => row.position)).toEqual([0, 1, 2, 3, 4]);
  });

  it('leaves no project below the root and no other node outside a project', async () => {
    const { database, migrations } = await atNineteen();
    await fixtureTree(database);

    await migrate(database, migrations, logger, clock);

    const nested = await database.query(
      "SELECT id FROM nodes WHERE kind = 'project' AND parent_id IS NOT NULL",
    );
    expect(nested.rows).toEqual([]);

    // Walk up from every non-project and keep the walks that reach the root
    // without passing a project: there must be none.
    const homeless = await database.query<{ id: string }>(`
      WITH RECURSIVE climb (start, at, kind) AS (
        SELECT n.id, n.parent_id, p.kind
        FROM nodes n LEFT JOIN nodes p ON p.id = n.parent_id
        WHERE n.kind <> 'project'
        UNION ALL
        SELECT climb.start, up.parent_id, above.kind
        FROM climb
        JOIN nodes up ON up.id = climb.at
        LEFT JOIN nodes above ON above.id = up.parent_id
        WHERE climb.kind <> 'project'
      )
      SELECT DISTINCT start AS id FROM climb WHERE at IS NULL
    `);
    expect(homeless.rows).toEqual([]);
  });

  it('seeds HOME on an empty database and moves nothing', async () => {
    const { database, migrations } = await atNineteen();

    await migrate(database, migrations, logger, clock);

    const nodes = await database.query<{ id: string; parent_id: string | null; position: number }>(
      'SELECT id, parent_id, position FROM nodes',
    );
    expect(nodes.rows).toEqual([{ id: 'home', parent_id: null, position: 0 }]);
  });
});
