import { z } from 'zod';
import type { Database, Queryable } from './database.js';
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

/** Guards this database against two hub processes migrating at once. */
const ADVISORY_LOCK_KEY = 8_675_309;

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

export interface MigrationOutcome {
  readonly applied: readonly Migration[];
  readonly alreadyApplied: number;
}

export async function migrate(
  database: Database,
  migrations: readonly Migration[],
  logger: Logger,
): Promise<MigrationOutcome> {
  const ordered = orderMigrations(migrations);

  await database.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
  try {
    await database.query(BOOKKEEPING_TABLE);
    const applied = await readApplied(database);

    reconcile(ordered, applied);

    const pending = ordered.filter((migration) => !applied.has(migration.version));
    for (const migration of pending) {
      await apply(database, migration);
      logger.info('migration applied', { version: migration.version, name: migration.name });
    }

    return { applied: pending, alreadyApplied: applied.size };
  } finally {
    await database.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
  }
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

async function readApplied(database: Database): Promise<ReadonlyMap<number, string>> {
  const result = await database.query('SELECT version, name FROM schema_migrations');
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
 */
async function apply(database: Database, migration: Migration): Promise<void> {
  try {
    await database.transaction(async (tx: Queryable) => {
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
