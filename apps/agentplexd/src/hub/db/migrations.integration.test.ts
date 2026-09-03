import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresDatabase } from './postgres.js';
import { loadMigrations } from './migration-files.js';
import { nodeMigrationFileSystem } from './node-migration-files.js';
import { ADVISORY_LOCK_KEY, migrate } from './migrations.js';
import { openTestDatabase } from './test-database.js';
import { ensureHubIdentity } from '../hub-identity.js';
import type { Database, Queryable, QueryResult } from './database.js';
import { createLogger } from '../../shared/logger.js';
import { randomIdGenerator } from '../../shared/ids.js';

/**
 * The migrations run against a real Postgres.
 *
 * The fake in `migrations.test.ts` covers the runner's control flow; only a
 * real server can say whether the SQL is valid, and only a real pool can show
 * what happens to a session-scoped lock taken through one. `pnpm docker:test`
 * supplies the database; failing that, testcontainers starts one. With neither,
 * the suite skips itself and says so rather than passing quietly.
 */
const testDatabase = await openTestDatabase();

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../../../migrations', import.meta.url));

/**
 * Any advisory lock at all, on a database no other program is using. Counting
 * them from a separate query is the point: a lock the migration runner failed
 * to release is still visible here, held by an idle pooled connection.
 */
async function advisoryLocksHeld(database: Database): Promise<number> {
  const result = await database.query<{ held: number }>(
    "SELECT count(*)::int AS held FROM pg_locks WHERE locktype = 'advisory'",
  );
  return result.rows[0]?.held ?? -1;
}

/**
 * A database that starts one long query on the pool the instant the migration
 * lock is taken, and keeps it in flight until the runner is done.
 *
 * This is the accident the old runner depended on not happening. Taken through
 * a pool, `pg_advisory_lock` runs on whichever client was free, and the client
 * is handed straight back; one query in flight then takes that client, the
 * unlock is issued on a new one, and it releases nothing. Nothing raises: the
 * unlock simply answers false, the lock stays held by an idle connection, and
 * the next process to migrate waits on it. Migrating happens before the hub
 * listens today, but the hub is not the only thing that will hold this pool by
 * milestone 3, and a lock that is only correct while nothing else runs is not
 * one anybody can reason about.
 */
function withTrafficDuringTheLock(database: Database): {
  readonly database: Database;
  settled(): Promise<void>;
} {
  let inFlight: Promise<unknown> = Promise.resolve();
  let started = false;

  const takeAConnection = (text: string): void => {
    if (started || !text.includes('advisory_lock(')) return;
    started = true;
    inFlight = database.query('SELECT pg_sleep(1)');
  };

  const watch =
    (handle: Queryable): Queryable['query'] =>
    async <Row>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> => {
      const result = await handle.query<Row>(text, values);
      takeAConnection(text);
      return result;
    };

  return {
    database: {
      query: watch(database),
      transaction: (body) => database.transaction(body),
      session: (body) =>
        database.session((session) =>
          body({ query: watch(session), transaction: (inner) => session.transaction(inner) }),
        ),
      close: () => database.close(),
    },
    settled: async () => void (await inFlight),
  };
}

describe.skipIf(testDatabase === null)('migrations against Postgres', () => {
  const database = createPostgresDatabase(testDatabase?.url ?? '');
  const logger = createLogger('error', () => {});

  afterAll(async () => {
    await database.close();
    await testDatabase?.stop();
  }, 60_000);

  beforeEach(async () => {
    // Each test starts from nothing, so "applies from empty" means it.
    await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  });

  it('applies every shipped migration to an empty database', async () => {
    const migrations = await loadMigrations(MIGRATIONS_DIRECTORY, nodeMigrationFileSystem);
    expect(migrations.length).toBeGreaterThan(0);

    const outcome = await migrate(database, migrations, logger);

    expect(outcome.applied).toHaveLength(migrations.length);
  });

  it('is idempotent: a second run applies nothing', async () => {
    const migrations = await loadMigrations(MIGRATIONS_DIRECTORY, nodeMigrationFileSystem);
    await migrate(database, migrations, logger);

    const second = await migrate(database, migrations, logger);

    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toBe(migrations.length);
  });

  it('refuses to open a database that has run a migration this build does not ship', async () => {
    const migrations = await loadMigrations(MIGRATIONS_DIRECTORY, nodeMigrationFileSystem);
    await migrate(database, migrations, logger);
    await database.query('INSERT INTO schema_migrations (version, name) VALUES (9999, $1)', [
      'from_a_newer_build',
    ]);

    await expect(migrate(database, migrations, logger)).rejects.toMatchObject({
      code: 'database-ahead',
    });
  });

  it('mints one hub id and returns the same one on every later start', async () => {
    const migrations = await loadMigrations(MIGRATIONS_DIRECTORY, nodeMigrationFileSystem);

    await migrate(database, migrations, logger);

    const first = await ensureHubIdentity(database, randomIdGenerator);
    const second = await ensureHubIdentity(database, randomIdGenerator);

    expect(second).toBe(first);
  });

  it('releases the advisory lock even while another query holds a connection', async () => {
    const migrations = await loadMigrations(MIGRATIONS_DIRECTORY, nodeMigrationFileSystem);
    const traffic = withTrafficDuringTheLock(database);

    await migrate(traffic.database, migrations, logger);
    await traffic.settled();

    expect(await advisoryLocksHeld(database)).toBe(0);
  });

  it('gives up on a lock another connection holds rather than waiting forever', async () => {
    const migrations = await loadMigrations(MIGRATIONS_DIRECTORY, nodeMigrationFileSystem);

    // A second connection stands in for a second hub process, holding the lock
    // for the whole attempt. `pg_advisory_lock` would block here with no
    // timeout and no log line; the bounded retry produces an error instead.
    const holder = createPostgresDatabase(testDatabase?.url ?? '');
    try {
      await holder.session(async (session) => {
        await session.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);

        await expect(
          migrate(database, migrations, logger, { attempts: 2, retryDelayMs: 10 }),
        ).rejects.toMatchObject({ code: 'lock-timeout' });
      });
    } finally {
      await holder.close();
    }
  });
});
