import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createSqliteDatabase, type SqliteDatabase } from './sqlite.js';

/**
 * The driver's contract, against the engine it drives.
 *
 * There is no skip condition and no container here, which is the point of the
 * database being a file: the suite that proves WAL is on and that a rollback
 * rolls back runs on a laptop, in CI, and in the image, always. The schema is
 * this file's own, not the application migrations, so nothing here breaks when
 * they change.
 */
const directory = await mkdtemp(join(tmpdir(), 'agentplex-sqlite-'));
const open: SqliteDatabase[] = [];

function openDatabase(name: string, options?: { readonly busyTimeoutMs?: number }): SqliteDatabase {
  const database = createSqliteDatabase(join(directory, name), options);
  open.push(database);
  return database;
}

async function createProbeTable(database: SqliteDatabase): Promise<void> {
  await database.query(
    'CREATE TABLE probe (id integer PRIMARY KEY AUTOINCREMENT, value integer NOT NULL)',
  );
}

async function probeValues(database: SqliteDatabase): Promise<number[]> {
  const result = await database.query<{ value: number }>('SELECT value FROM probe ORDER BY value');
  return result.rows.map((row) => row.value);
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((database) => database.close()));
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('createSqliteDatabase', () => {
  it('opens a file-backed database in WAL mode', async () => {
    const database = openDatabase('wal.db');

    const result = await database.query<{ journal_mode: string }>('PRAGMA journal_mode');

    expect(result.rows[0]?.journal_mode).toBe('wal');
  });

  it('accepts an in-memory database, where there is no journal to write ahead of', async () => {
    const database = createSqliteDatabase(':memory:');
    open.push(database);

    const result = await database.query<{ journal_mode: string }>('PRAGMA journal_mode');

    expect(result.rows[0]?.journal_mode).toBe('memory');
  });

  it('applies a busy timeout, so a held write lock waits instead of failing at once', async () => {
    const database = openDatabase('timeout.db', { busyTimeoutMs: 1_234 });

    const result = await database.query<{ timeout: number }>('PRAGMA busy_timeout');

    expect(result.rows[0]?.timeout).toBe(1_234);
  });

  it('reports rows for a statement that returns them and changes for one that does not', async () => {
    const database = openDatabase('counts.db');
    await createProbeTable(database);

    const written = await database.query('INSERT INTO probe (value) VALUES (?), (?)', [1, 2]);
    expect(written).toEqual({ rows: [], rowCount: 2 });

    const read = await database.query<{ value: number }>('SELECT value FROM probe ORDER BY value');
    expect(read.rowCount).toBe(2);
    expect(read.rows.map((row) => row.value)).toEqual([1, 2]);

    const deleted = await database.query('DELETE FROM probe WHERE value > ?', [1]);
    expect(deleted.rowCount).toBe(1);
  });

  it('binds a boolean as the integer SQLite stores, having no boolean type', async () => {
    const database = openDatabase('booleans.db');
    await createProbeTable(database);

    await database.query('INSERT INTO probe (value) VALUES (?)', [true]);
    await database.query('INSERT INTO probe (value) VALUES (?)', [false]);

    expect(await probeValues(database)).toEqual([0, 1]);
  });

  it('refuses a parameter no column could hold rather than storing something else', async () => {
    const database = openDatabase('unbindable.db');
    await createProbeTable(database);

    await expect(
      database.query('INSERT INTO probe (value) VALUES (?)', [{ value: 1 }]),
    ).rejects.toThrow('parameter 1');
  });

  it('runs every statement of a script, not the first one and silence', async () => {
    const database = openDatabase('script.db');

    // What a migration file is. `prepare` compiles the leading statement and
    // ignores the rest, so a driver that only prepared would create the table
    // and skip its index while reporting success.
    const result = await database.query(
      'CREATE TABLE probe (value integer NOT NULL);\nCREATE INDEX probe_value ON probe (value);\n',
    );

    expect(result).toEqual({ rows: [], rowCount: 0 });
    const objects = await database.query<{ name: string }>(
      'SELECT name FROM sqlite_master ORDER BY name',
    );
    expect(objects.rows.map((row) => row.name)).toEqual(['probe', 'probe_value']);
  });

  it('refuses a script with parameters, which could only bind to its first statement', async () => {
    const database = openDatabase('bound-script.db');
    await createProbeTable(database);

    await expect(
      database.query('INSERT INTO probe (value) VALUES (?); DELETE FROM probe;', [1]),
    ).rejects.toThrow('multi-statement script');
  });

  it('commits a transaction that returns', async () => {
    const database = openDatabase('commit.db');
    await createProbeTable(database);

    const returned = await database.transaction(async (tx) => {
      await tx.query('INSERT INTO probe (value) VALUES (?)', [7]);
      return 'done';
    });

    expect(returned).toBe('done');
    expect(await probeValues(database)).toEqual([7]);
  });

  it('rolls a transaction back when its body throws, and stays usable after', async () => {
    const database = openDatabase('rollback.db');
    await createProbeTable(database);

    await expect(
      database.transaction(async (tx) => {
        await tx.query('INSERT INTO probe (value) VALUES (?)', [1]);
        throw new Error('changed my mind');
      }),
    ).rejects.toThrow('changed my mind');

    expect(await probeValues(database)).toEqual([]);

    await database.query('INSERT INTO probe (value) VALUES (?)', [2]);
    expect(await probeValues(database)).toEqual([2]);
  });

  it('serializes overlapping transactions instead of nesting them on the one connection', async () => {
    const database = openDatabase('serialized.db');
    await createProbeTable(database);

    // Every one of these opens its transaction before the previous body has
    // finished awaiting. On one connection a second BEGIN is an error, so if
    // this passes they ran one after another.
    await Promise.all(
      [1, 2, 3, 4].map((value) =>
        database.transaction(async (tx) => {
          await tx.query('SELECT 1');
          await tx.query('INSERT INTO probe (value) VALUES (?)', [value]);
        }),
      ),
    );

    expect(await probeValues(database)).toEqual([1, 2, 3, 4]);
  });

  it('puts a query issued during a transaction inside that transaction', async () => {
    const database = openDatabase('joined.db');
    await createProbeTable(database);

    // What a pinned handle used to be asked for, without one. There is one
    // connection and `query` is deliberately not queued, so a statement issued
    // beside a running transaction still lands on the connection that
    // transaction is open on. The rollback is the proof: a statement genuinely
    // outside it would have survived.
    await expect(
      database.transaction(async (tx) => {
        await tx.query('INSERT INTO probe (value) VALUES (?)', [1]);
        await database.query('INSERT INTO probe (value) VALUES (?)', [2]);
        throw new Error('no');
      }),
    ).rejects.toThrow('no');

    expect(await probeValues(database)).toEqual([]);
  });

  it('copies an open database with backup, including uncommitted-then-committed rows', async () => {
    const source = openDatabase('source.db');
    await createProbeTable(source);
    await source.query('INSERT INTO probe (value) VALUES (?), (?)', [1, 2]);

    const pages = await source.backup(join(directory, 'copy.db'));
    expect(pages).toBeGreaterThan(0);

    const copy = openDatabase('copy.db');
    expect(await probeValues(copy)).toEqual([1, 2]);
  });

  it('refuses to query after close, and closes idempotently', async () => {
    const database = createSqliteDatabase(join(directory, 'closed.db'));
    await database.query('CREATE TABLE probe (value integer)');

    await database.close();
    await database.close();

    await expect(database.query('SELECT 1')).rejects.toThrow(/not open/);
  });
});
