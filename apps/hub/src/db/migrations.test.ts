import { describe, expect, it } from 'vitest';
import { createFakeDatabase } from './fake-database.js';
import { MigrationError, migrate, orderMigrations, type Migration } from './migrations.js';
import { createLogger, type LogRecord } from '@agentplex/node-shared';

function silentLogger(): { logger: ReturnType<typeof createLogger>; records: LogRecord[] } {
  const records: LogRecord[] = [];
  return { logger: createLogger('debug', (record) => records.push(record)), records };
}

function migration(version: number, name: string, sql = `CREATE TABLE t${version} (x integer)`) {
  return { version, name, sql } satisfies Migration;
}

const clock = { now: () => 1_756_000_000_000 };

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
      clock,
    );

    expect(outcome.applied.map((each) => each.version)).toEqual([1, 2]);
    expect(database.appliedVersions).toEqual([1, 2]);
  });

  it('applies nothing on a second run', async () => {
    const database = createFakeDatabase({ applied: new Map([[1, 'first']]) });
    const { logger } = silentLogger();

    const outcome = await migrate(database, [migration(1, 'first')], logger, clock);

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
      clock,
    );

    expect(outcome.applied.map((each) => each.name)).toEqual(['second']);
  });

  it('applies a migration that arrives after a higher-numbered one has run', async () => {
    // What makes a reserved number safe to leave a gap for. Two branches in
    // flight take 10 and 16; the second lands first, and a hub that has run 16
    // then meets 10. Pending is "not applied" and nothing else -- the gap is
    // not read as history, and the lower number is not skipped for having been
    // overtaken. Editing 16 to renumber it is the alternative, and that is the
    // one thing an applied migration may never be.
    const database = createFakeDatabase({ applied: new Map([[16, 'later_branch']]) });
    const { logger } = silentLogger();

    const outcome = await migrate(
      database,
      [migration(10, 'earlier_branch'), migration(16, 'later_branch')],
      logger,
      clock,
    );

    expect(outcome.applied.map((each) => each.version)).toEqual([10]);
  });

  it('throws rather than opening a database ahead of this build', async () => {
    const database = createFakeDatabase({
      applied: new Map([
        [1, 'first'],
        [2, 'from_a_newer_build'],
      ]),
    });
    const { logger } = silentLogger();

    await expect(migrate(database, [migration(1, 'first')], logger, clock)).rejects.toMatchObject({
      code: 'database-ahead',
    });
  });

  it('throws when an applied migration was renamed or edited under it', async () => {
    const database = createFakeDatabase({ applied: new Map([[1, 'first']]) });
    const { logger } = silentLogger();

    await expect(
      migrate(database, [migration(1, 'first_renamed')], logger, clock),
    ).rejects.toMatchObject({ code: 'history-edited' });
  });

  it('rolls the whole run back when one migration fails, rather than half a schema', async () => {
    const database = createFakeDatabase({ failOn: /CREATE TABLE t2/ });
    const { logger } = silentLogger();

    await expect(
      migrate(database, [migration(1, 'first'), migration(2, 'second')], logger, clock),
    ).rejects.toMatchObject({ code: 'apply-failed' });

    // One transaction for the run means the migration that did apply goes back
    // too. The next start applies the same list again, which is a state that
    // was written down, unlike a run that stopped halfway.
    expect(database.appliedVersions).toEqual([]);
  });

  it('issues every statement of the run inside one transaction', async () => {
    const database = createFakeDatabase();
    const { logger } = silentLogger();

    await migrate(database, [migration(1, 'first'), migration(2, 'second')], logger, clock);

    // Reconciling outside the transaction it writes in would mean reading a
    // schema this run is not the one changing, and a statement outside it would
    // survive the rollback the run relies on. There is nothing else to assert
    // about serialization here: the write lock the run holds belongs to the
    // driver, and `migrations.integration.test` is where a second connection
    // meets it.
    const transactions = new Set(database.issued.map((statement) => statement.transaction));
    expect(transactions).toEqual(new Set([1]));
  });

  it('says which migrations it applied, so a deploy log shows the schema change', async () => {
    const database = createFakeDatabase();
    const { logger, records } = silentLogger();

    await migrate(database, [migration(1, 'first')], logger, clock);

    expect(records.map((record) => record.fields)).toContainEqual({ version: 1, name: 'first' });
  });
});
