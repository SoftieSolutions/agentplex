import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Queryable } from './database.js';
import { createPostgresDatabase } from './postgres.js';
import { openTestDatabase } from './test-database.js';

/**
 * The driver's contract, against the server it drives.
 *
 * `session` is the reason this file exists. Nothing about a pool can be
 * asserted against a fake: the behaviour that matters — which backend a
 * statement lands on while other queries are returning clients to the pool — is
 * the pool's, and only a real one has it.
 *
 * Everything here lives in its own schema. On the `pnpm docker:test` path this
 * suite and the migration suite share one database, and that one resets itself
 * by dropping `public`.
 */
const testDatabase = await openTestDatabase();

const PROBE_SCHEMA = 'driver_probe';

async function backendPid(handle: Queryable): Promise<number> {
  const result = await handle.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return result.rows[0]?.pid ?? -1;
}

describe.skipIf(testDatabase === null)('createPostgresDatabase', () => {
  const database = createPostgresDatabase(testDatabase?.url ?? '', { maxConnections: 4 });

  beforeAll(async () => {
    await database.query(`CREATE SCHEMA IF NOT EXISTS ${PROBE_SCHEMA}`);
    await database.query(`CREATE TABLE IF NOT EXISTS ${PROBE_SCHEMA}.probe (value integer)`);
  });

  afterAll(async () => {
    await database.query(`DROP SCHEMA IF EXISTS ${PROBE_SCHEMA} CASCADE`);
    await database.close();
    await testDatabase?.stop();
  }, 60_000);

  it('spreads pooled queries over more than one backend', async () => {
    // The premise the next tests rest on: if the pool only ever used one
    // connection, pinning one would prove nothing.
    const pids = new Set<number>();
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        const result = await database.query<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid FROM pg_sleep(0.05)',
        );
        pids.add(result.rows[0]?.pid ?? -1);
      }),
    );

    expect(pids.size).toBeGreaterThan(1);
  });

  it('keeps a session on one backend while other queries churn the pool', async () => {
    const pids = new Set<number>();

    await database.session(async (session) => {
      for (let round = 0; round < 5; round += 1) {
        // Each of these checks a client out and releases it, which is what
        // moves the next pooled query onto a different backend.
        await database.query('SELECT 1');
        pids.add(await backendPid(session));
      }
    });

    expect(pids.size).toBe(1);
  });

  it('runs a transaction opened on a session on that session own backend', async () => {
    const pids = new Set<number>();

    await database.session(async (session) => {
      pids.add(await backendPid(session));
      await database.query('SELECT 1');
      await session.transaction(async (tx) => {
        pids.add(await backendPid(tx));
      });
      // Session-scoped state has to survive the transaction that committed on
      // it. That is the whole reason the migration runner needs a session and
      // not a transaction: the lock outlives each migration.
      pids.add(await backendPid(session));
    });

    expect(pids.size).toBe(1);
  });

  it('rolls a transaction back when its body throws', async () => {
    await database.query(`DELETE FROM ${PROBE_SCHEMA}.probe`);

    await expect(
      database.transaction(async (tx) => {
        await tx.query(`INSERT INTO ${PROBE_SCHEMA}.probe (value) VALUES (1)`);
        throw new Error('changed my mind');
      }),
    ).rejects.toThrow('changed my mind');

    const result = await database.query<{ written: number }>(
      `SELECT count(*)::int AS written FROM ${PROBE_SCHEMA}.probe`,
    );
    expect(result.rows[0]?.written).toBe(0);
  });
});
