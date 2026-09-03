import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Database, DatabaseSession, Queryable } from './database.js';
import type { Logger } from '../../shared/logger.js';

/**
 * Forward-only, append-only migrations.
 *
 * Three rules, each of which exists because the alternative fails quietly:
 *
 * - Forward only. There is no `down`. A rollback script is written when the
 *   schema is understood and run when it is not.
 * - Append only. An applied migration is history. Editing one leaves every
 *   database that already ran it disagreeing with every one that has not, and
 *   nothing says so.
 * - A database ahead of the running build throws rather than opening. An older
 *   binary meeting a newer schema is a rollback in progress; serving from it
 *   writes rows the new schema will have to explain.
 */

export interface Migration {
  /** From the filename prefix. Unique, and ordered by the integer, not the text. */
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export type MigrationErrorCode =
  | 'database-ahead'
  | 'history-edited'
  | 'duplicate-version'
  | 'bad-filename'
  | 'apply-failed'
  | 'lock-timeout';

export class MigrationError extends Error {
  constructor(
    readonly code: MigrationErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

/**
 * Guards this database against two hub processes migrating at once.
 *
 * Exported so the integration suite can hold the same lock from a second
 * connection rather than repeating the number and testing a different one.
 */
export const ADVISORY_LOCK_KEY = 8_675_309;

/**
 * How long to wait for another process to finish migrating before giving up.
 *
 * `pg_advisory_lock` waits forever and says nothing while it does. Because
 * migrating happens before the hub listens, that turns a stuck lock into a
 * container that never goes healthy, with no log line naming the reason. A
 * bounded number of `pg_try_advisory_lock` attempts turns the same situation
 * into an error an operator can read.
 */
const LOCK_ATTEMPTS = 60;
const LOCK_RETRY_DELAY_MS = 500;

export interface MigrationLockOptions {
  /** Tries this many times before giving up. At least one. */
  readonly attempts?: number;
  readonly retryDelayMs?: number;
  /** The delay seam: a test waits for nothing rather than for real seconds. */
  readonly wait?: (ms: number) => Promise<void>;
}

const BOOKKEEPING_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    integer     PRIMARY KEY,
    name       text        NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`;

const appliedRowSchema = z.object({
  version: z.coerce.number().int(),
  name: z.string(),
});

/** `pg_try_advisory_lock` answers whether it got the lock; it never waits. */
const lockAttemptRowSchema = z.object({ locked: z.boolean() });

export interface MigrationOutcome {
  readonly applied: readonly Migration[];
  readonly alreadyApplied: number;
}

/**
 * The whole run happens inside one `session`, and that is the point.
 *
 * An advisory lock belongs to the backend that took it. Run through a pool, the
 * lock and the unlock can land on different connections: the unlock returns
 * false, the lock stays held by an idle client, and the next process to migrate
 * waits on a lock nobody is using. Pinning the connection is what makes the
 * unlock reach the backend that holds it.
 */
export async function migrate(
  database: Database,
  migrations: readonly Migration[],
  logger: Logger,
  lock: MigrationLockOptions = {},
): Promise<MigrationOutcome> {
  const ordered = orderMigrations(migrations);

  return database.session(async (session) => {
    await takeAdvisoryLock(session, logger, lock);
    try {
      await session.query(BOOKKEEPING_TABLE);
      const applied = await readApplied(session);

      reconcile(ordered, applied);

      const pending = ordered.filter((migration) => !applied.has(migration.version));
      for (const migration of pending) {
        await apply(session, migration);
        logger.info('migration applied', { version: migration.version, name: migration.name });
      }

      return { applied: pending, alreadyApplied: applied.size };
    } finally {
      await session.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    }
  });
}

/** Sorts by version and refuses a set that has the same version twice. */
export function orderMigrations(migrations: readonly Migration[]): readonly Migration[] {
  const ordered = [...migrations].sort((left, right) => left.version - right.version);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous !== undefined && current !== undefined && previous.version === current.version) {
      throw new MigrationError(
        'duplicate-version',
        `two migrations claim version ${current.version}: ${previous.name} and ${current.name}`,
      );
    }
  }
  return ordered;
}

async function takeAdvisoryLock(
  session: DatabaseSession,
  logger: Logger,
  options: MigrationLockOptions,
): Promise<void> {
  const attempts = Math.max(1, options.attempts ?? LOCK_ATTEMPTS);
  const retryDelayMs = options.retryDelayMs ?? LOCK_RETRY_DELAY_MS;
  const wait = options.wait ?? ((ms: number) => delay(ms));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await session.query('SELECT pg_try_advisory_lock($1) AS locked', [
      ADVISORY_LOCK_KEY,
    ]);
    // The answer is a row read back off a connection, so it is parsed like any
    // other claim rather than trusted to be a boolean.
    if (lockAttemptRowSchema.parse(result.rows[0]).locked) return;

    if (attempt === 1) {
      logger.warn('another process is migrating this database; waiting for the lock', {
        attempts,
        retryDelayMs,
      });
    }
    if (attempt < attempts) await wait(retryDelayMs);
  }

  throw new MigrationError(
    'lock-timeout',
    `another process still holds the migration lock after ${attempts} attempts ` +
      `${retryDelayMs}ms apart. Either a migration is genuinely still running, or a ` +
      'connection died holding the lock and its backend has not been reaped yet.',
  );
}

async function readApplied(session: Queryable): Promise<ReadonlyMap<number, string>> {
  const result = await session.query('SELECT version, name FROM schema_migrations');
  const applied = new Map<number, string>();
  for (const row of result.rows) {
    // Rows are read back as claims, not as the shape we assume we wrote.
    const parsed = appliedRowSchema.parse(row);
    applied.set(parsed.version, parsed.name);
  }
  return applied;
}

function reconcile(ordered: readonly Migration[], applied: ReadonlyMap<number, string>): void {
  const known = new Map(ordered.map((migration) => [migration.version, migration.name]));

  for (const [version, name] of applied) {
    const shipped = known.get(version);
    if (shipped === undefined) {
      throw new MigrationError(
        'database-ahead',
        `the database has run migration ${version} (${name}), which this build does not ship. ` +
          'Run a build that includes it rather than serving from a schema this one cannot explain.',
      );
    }
    if (shipped !== name) {
      throw new MigrationError(
        'history-edited',
        `migration ${version} ran as ${JSON.stringify(name)} but this build calls it ` +
          `${JSON.stringify(shipped)}. Applied migrations are history: add a new one instead.`,
      );
    }
  }
}

/**
 * One migration, one transaction, including its bookkeeping row: a migration
 * that half-ran and was recorded is worse than one that did not run at all.
 *
 * The transaction is opened on the session that holds the lock, so committing
 * it does not hand the lock back: an advisory lock outlives the transactions
 * taken on its connection.
 */
async function apply(session: DatabaseSession, migration: Migration): Promise<void> {
  try {
    await session.transaction(async (tx: Queryable) => {
      await tx.query(migration.sql);
      await tx.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
        migration.version,
        migration.name,
      ]);
    });
  } catch (error) {
    throw new MigrationError(
      'apply-failed',
      `migration ${migration.version} (${migration.name}) failed and was rolled back`,
      { cause: error },
    );
  }
}
