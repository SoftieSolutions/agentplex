import { z } from 'zod';
import type { Database, DatabaseSession, Queryable } from './database.js';
import type { Clock } from '../../shared/clock.js';
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
  'database-ahead' | 'history-edited' | 'duplicate-version' | 'bad-filename' | 'apply-failed';

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
 * `applied_at` is epoch milliseconds and carries no default.
 *
 * SQLite has no `now()` that means what `timestamptz DEFAULT now()` meant, and
 * the substitutes it does have — `unixepoch()`, `CURRENT_TIMESTAMP` — would be
 * the one clock in this codebase that a test cannot set. Everything above the
 * database already takes its time from an injected clock, so this row does too:
 * the caller passes the millisecond it means, and the schema states the unit.
 */
const BOOKKEEPING_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    integer PRIMARY KEY,
    name       text    NOT NULL,
    applied_at integer NOT NULL
  )
`;

const appliedRowSchema = z.object({
  version: z.coerce.number().int(),
  name: z.string(),
});

export interface MigrationOutcome {
  readonly applied: readonly Migration[];
  readonly alreadyApplied: number;
}

/**
 * The whole run is one transaction, and that is what serializes it.
 *
 * There is no advisory lock to take: a single-file database has no second
 * process to take one from, and SQLite already has the primitive this needs.
 * `BEGIN IMMEDIATE` — which is what the driver opens a transaction with — takes
 * the database's write lock at the first statement rather than at the first
 * write, so a second hub process starting against the same file waits on the
 * driver's busy timeout and then fails, instead of interleaving its DDL with
 * this one's.
 *
 * One transaction for the run rather than one per migration is a change of
 * shape that SQLite makes and Postgres did not force. It keeps the property
 * that mattered — a migration is never recorded as applied unless every one of
 * its statements ran — and strengthens it: a run that fails halfway leaves the
 * schema exactly where it started, so the next start applies the same list
 * again rather than resuming into a state nobody wrote down. Holding the write
 * lock across the whole run is affordable because migrating happens before the
 * hub listens, so nothing else is asking for it yet.
 *
 * It still runs inside a `session`, so every statement — the bookkeeping table,
 * the reconciliation read, each migration — lands on one connection.
 */
export async function migrate(
  database: Database,
  migrations: readonly Migration[],
  logger: Logger,
  clock: Clock,
): Promise<MigrationOutcome> {
  const ordered = orderMigrations(migrations);

  return database.session((session: DatabaseSession) =>
    session.transaction(async (tx: Queryable) => {
      await tx.query(BOOKKEEPING_TABLE);
      const applied = await readApplied(tx);

      reconcile(ordered, applied);

      const pending = ordered.filter((migration) => !applied.has(migration.version));
      for (const migration of pending) {
        await apply(tx, migration, clock);
        logger.info('migration applied', { version: migration.version, name: migration.name });
      }

      return { applied: pending, alreadyApplied: applied.size };
    }),
  );
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
 * One migration and its bookkeeping row, on the transaction the run holds.
 *
 * The failure is wrapped here rather than at the call site so the message names
 * the migration that failed; the rollback that follows is the run's, and it
 * takes every migration this run had applied with it.
 */
async function apply(tx: Queryable, migration: Migration, clock: Clock): Promise<void> {
  try {
    await tx.query(migration.sql);
    await tx.query('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
      migration.version,
      migration.name,
      clock.now(),
    ]);
  } catch (error) {
    throw new MigrationError(
      'apply-failed',
      `migration ${migration.version} (${migration.name}) failed and was rolled back`,
      { cause: error },
    );
  }
}
