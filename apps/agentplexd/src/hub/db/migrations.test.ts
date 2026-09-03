import { describe, expect, it } from 'vitest';
import { createFakeDatabase } from './fake-database.js';
import { MigrationError, migrate, orderMigrations, type Migration } from './migrations.js';
import { createLogger, type LogRecord } from '../../shared/logger.js';

function silentLogger(): { logger: ReturnType<typeof createLogger>; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { logger: createLogger('debug', (record) => records.push(record)), records };
}

function migration(version: number, name: string, sql = `CREATE TABLE t${version} ()`): Migration {
  return { version, name, sql };
}

describe('orderMigrations', () => {
  it('orders by version number, not by filename text', () => {
    const ordered = orderMigrations([migration(10, 'ten'), migration(2, 'two')]);
    expect(ordered.map((each) => each.version)).toEqual([2, 10]);
  });

  it('refuses two migrations claiming the same version', () => {
    expect(() => orderMigrations([migration(1, 'a'), migration(1, 'b')])).toThrow(MigrationError);
  });
});

describe('migrate', () => {
  it('applies every pending migration in order', async () => {
    const database = createFakeDatabase();
    const { logger } = silentLogger();

    const outcome = await migrate(
      database,
      [migration(2, 'second'), migration(1, 'first')],
      logger,
    );

    expect(outcome.applied.map((each) => each.version)).toEqual([1, 2]);
    expect(database.appliedVersions).toEqual([1, 2]);
  });

  it('applies nothing on a second run', async () => {
    const database = createFakeDatabase({ applied: new Map([[1, 'first']]) });
    const { logger } = silentLogger();

    const outcome = await migrate(database, [migration(1, 'first')], logger);

    expect(outcome.applied).toEqual([]);
    expect(outcome.alreadyApplied).toBe(1);
  });

  it('applies only what is missing', async () => {
    const database = createFakeDatabase({ applied: new Map([[1, 'first']]) });
    const { logger } = silentLogger();

    const outcome = await migrate(
      database,
      [migration(1, 'first'), migration(2, 'second')],
      logger,
    );

    expect(outcome.applied.map((each) => each.name)).toEqual(['second']);
  });

  it('throws rather than opening a database ahead of this build', async () => {
    const database = createFakeDatabase({
      applied: new Map([
        [1, 'first'],
        [2, 'from_a_newer_build'],
      ]),
    });
    const { logger } = silentLogger();

    await expect(migrate(database, [migration(1, 'first')], logger)).rejects.toMatchObject({
      code: 'database-ahead',
    });
  });

  it('throws when an applied migration was renamed or edited under it', async () => {
    const database = createFakeDatabase({ applied: new Map([[1, 'first']]) });
    const { logger } = silentLogger();

    await expect(migrate(database, [migration(1, 'first_renamed')], logger)).rejects.toMatchObject({
      code: 'history-edited',
    });
  });

  it('records nothing for a migration whose statements failed', async () => {
    const database = createFakeDatabase({ failOn: /CREATE TABLE t2/ });
    const { logger } = silentLogger();

    await expect(
      migrate(database, [migration(1, 'first'), migration(2, 'second')], logger),
    ).rejects.toMatchObject({ code: 'apply-failed' });

    expect(database.appliedVersions).toEqual([1]);
  });

  it('takes the advisory lock before touching the schema and releases it after', async () => {
    const database = createFakeDatabase();
    const { logger } = silentLogger();

    await migrate(database, [migration(1, 'first')], logger);

    expect(database.statements[0]).toContain('pg_try_advisory_lock');
    expect(database.statements.at(-1)).toContain('pg_advisory_unlock');
  });

  it('locks and unlocks on one connection, because a lock belongs to a backend', async () => {
    const database = createFakeDatabase();
    const { logger } = silentLogger();

    await migrate(database, [migration(1, 'first'), migration(2, 'second')], logger);

    // Not just lock and unlock: every statement in between, including each
    // migration's own transaction, has to be on the connection holding the lock
    // or the lock is guarding a connection that is doing nothing.
    const connections = new Set(database.issued.map((statement) => statement.connection));
    expect(connections.size).toBe(1);
  });

  it('gives up on a lock it cannot get rather than waiting forever', async () => {
    const database = createFakeDatabase({
      respondWith: [{ match: /pg_try_advisory_lock/, rows: [{ locked: false }] }],
    });
    const { logger } = silentLogger();
    const waits: number[] = [];

    await expect(
      migrate(database, [migration(1, 'first')], logger, {
        attempts: 3,
        retryDelayMs: 25,
        wait: async (ms) => void waits.push(ms),
      }),
    ).rejects.toMatchObject({ code: 'lock-timeout' });

    // Three attempts, two waits between them, and nothing applied.
    expect(waits).toEqual([25, 25]);
    expect(database.appliedVersions).toEqual([]);
  });

  it('unlocks nothing when it never got the lock', async () => {
    const database = createFakeDatabase({
      respondWith: [{ match: /pg_try_advisory_lock/, rows: [{ locked: false }] }],
    });
    const { logger } = silentLogger();

    await expect(
      migrate(database, [migration(1, 'first')], logger, { attempts: 1 }),
    ).rejects.toThrow();

    expect(database.statements.some((text) => text.includes('pg_advisory_unlock'))).toBe(false);
  });

  it('says it is waiting, so a slow start is not a silent one', async () => {
    const database = createFakeDatabase({
      respondWith: [{ match: /pg_try_advisory_lock/, rows: [{ locked: false }] }],
    });
    const { logger, records } = silentLogger();

    await expect(
      migrate(database, [migration(1, 'first')], logger, {
        attempts: 2,
        retryDelayMs: 1,
        wait: async () => {},
      }),
    ).rejects.toThrow();

    expect(records.map((record) => record.message)).toContainEqual(
      expect.stringContaining('waiting for the lock'),
    );
  });

  it('releases the advisory lock even when a migration fails', async () => {
    const database = createFakeDatabase({ failOn: /CREATE TABLE t1/ });
    const { logger } = silentLogger();

    await expect(migrate(database, [migration(1, 'first')], logger)).rejects.toThrow();

    expect(database.statements.at(-1)).toContain('pg_advisory_unlock');
  });

  it('says which migrations it applied, so a deploy log shows the schema change', async () => {
    const database = createFakeDatabase();
    const { logger, records } = silentLogger();

    await migrate(database, [migration(1, 'first')], logger);

    expect(records.map((record) => record.fields)).toContainEqual({ version: 1, name: 'first' });
  });
});
