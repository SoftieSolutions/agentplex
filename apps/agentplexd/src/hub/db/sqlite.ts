import { backup as backUpTo, DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { z } from 'zod';
import type { Database, DatabaseSession, Queryable, QueryResult } from './database.js';

/**
 * The one module that names the SQLite driver.
 *
 * There is one connection, because there is one file and one process writing
 * to it. `DatabaseSync` is synchronous, so every call below occupies the event
 * loop for the whole statement and nothing else in this process runs meanwhile:
 * the hub's queries are small listings and whole-row writes, and they have to
 * stay that way. A query that scans is not slow here, it is a stalled server.
 */

/**
 * How long a statement waits for the write lock before giving up, in ms.
 *
 * SQLite serializes writes, and the hub writes whole snapshots from one
 * supervisor per paired server. Those writes overlap in wall-clock time and
 * must not overlap in the database; without a busy timeout the loser of that
 * race gets SQLITE_BUSY immediately and the hub reports a failure that is
 * nothing but two machines having reported at once.
 *
 * Five seconds is chosen as three orders of magnitude above a snapshot write,
 * which is a handful of statements against a few hundred rows, and still short
 * enough that a writer genuinely stuck — a checkpoint against a slow disk, a
 * second process nobody meant to start — surfaces as an error somebody can
 * read rather than as a hub that has quietly stopped answering.
 */
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export interface SqliteOptions {
  /** How long a statement waits for the write lock before failing, in ms. */
  readonly busyTimeoutMs?: number;
}

/**
 * `Database`, plus the one verb that only a single-file database has.
 *
 * Backup is operational rather than part of the seam: nothing above the seam
 * calls it, and nothing above the seam should learn that it exists.
 */
export interface SqliteDatabase extends Database {
  /**
   * Copies this database to `destination` while it is open and being written,
   * and resolves with the number of pages copied. An existing file there is
   * overwritten.
   */
  backup(destination: string): Promise<number>;
}

export function createSqliteDatabase(path: string, options: SqliteOptions = {}): SqliteDatabase {
  const connection = new DatabaseSync(path, {
    timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
  });
  enableWriteAheadLog(connection);

  /**
   * Statements run one at a time because there is one connection, and the
   * statements themselves are synchronous, so a query cannot interleave with
   * anything. A transaction can: its body awaits, and a second `BEGIN` on this
   * connection is an error rather than a queue. This chain is that queue.
   */
  let pending: Promise<unknown> = Promise.resolve();
  const exclusively = <T>(body: () => Promise<T>): Promise<T> => {
    const result = pending.then(body);
    // Swallowed, so one failed transaction does not reject the next one.
    pending = result.then(ignore, ignore);
    return result;
  };

  const query = async <Row>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> =>
    execute<Row>(connection, text, values);

  const queryable: Queryable = { query };

  const runTransaction = async <T>(body: (tx: Queryable) => Promise<T>): Promise<T> => {
    // IMMEDIATE takes the write lock now rather than at the first write. A
    // deferred transaction that reads and then writes has to upgrade its lock,
    // and SQLite will not make another connection give way for that: the
    // upgrade fails at once with SQLITE_BUSY whatever the busy timeout says.
    // Taking the lock up front is what puts the timeout back in play.
    connection.exec('BEGIN IMMEDIATE');
    try {
      const value = await body(queryable);
      connection.exec('COMMIT');
      return value;
    } catch (error) {
      // A rollback can itself fail, on a connection SQLite has already rolled
      // back for us. The body's error is the one worth reporting.
      try {
        connection.exec('ROLLBACK');
      } catch {
        // Nothing to add: the transaction is gone either way.
      }
      throw error;
    }
  };

  let closed = false;

  return {
    /**
     * Deliberately not queued. A statement is synchronous, so it needs no turn
     * of its own, and queueing it would deadlock the first caller that ran a
     * query from inside a transaction body.
     *
     * That caller gets a different answer here than it got from a pool: the
     * statement runs on the connection the transaction is open on, so it is
     * inside that transaction rather than beside it.
     */
    query,

    transaction: (body) => exclusively(() => runTransaction(body)),

    /**
     * One connection means a session is the whole database held still: the
     * pinned-connection idea this interface was shaped around belongs to a
     * pool, and there is no pool. The interface is narrowed where it is
     * declared, not worked around here.
     */
    session: (body) =>
      exclusively(() => body({ query, transaction: runTransaction } satisfies DatabaseSession)),

    backup: (destination) => exclusively(() => backUpTo(connection, destination)),

    close: () =>
      exclusively(async () => {
        // Idempotent, because shutdown paths converge and a second
        // `DatabaseSync.close()` throws.
        if (closed) return;
        closed = true;
        connection.close();
      }),
  };
}

function ignore(): void {}

/** What `PRAGMA journal_mode` reports back, which is a row like any other. */
const journalModeSchema = z.object({ journal_mode: z.string() });

/**
 * WAL, or refuse to open.
 *
 * WAL is what lets the hub read while a snapshot write is in flight, so it is
 * a requirement and not a preference. SQLite does not fail a journal mode it
 * cannot honour — a filesystem without working shared memory, a network mount
 * — it leaves the old mode in place and reports it. Checking the answer is the
 * difference between knowing WAL is on and having asked for it.
 *
 * An in-memory database is the one place where not-WAL is correct: it has no
 * file to journal, reports `memory`, and is a legitimate thing to open.
 */
function enableWriteAheadLog(connection: DatabaseSync): void {
  const reported = journalModeSchema.safeParse(
    connection.prepare('PRAGMA journal_mode = WAL').get(),
  );
  const mode = reported.success ? reported.data.journal_mode.toLowerCase() : null;
  if (mode === 'wal' || connection.location() === null) return;

  const location = connection.location();
  connection.close();
  throw new Error(
    `${String(location)} would not open in WAL mode: SQLite reports ${JSON.stringify(mode)}`,
  );
}

function execute<Row>(
  connection: DatabaseSync,
  text: string,
  values: readonly unknown[] = [],
): QueryResult<Row> {
  const statement = connection.prepare(text);
  const parameters = values.map(bindable);

  // `prepare` compiles the first statement in the text and silently ignores
  // whatever follows it, which is how a migration file with a table and its
  // indexes in it would apply the table and quietly skip the indexes. Anything
  // left over means this is a script, and a script goes to `exec`, which runs
  // all of it. `sourceSQL` is the prefix SQLite consumed, so the remainder is
  // what it did not.
  //
  // A script reports no rows and no row count, rather than the counts of
  // whichever of its statements ran last: what a caller would do with that
  // number is guess. A script with parameters is refused outright — the values
  // could only bind to its first statement, which is not what anybody writing
  // one would mean.
  if (text.slice(statement.sourceSQL.length).trim().length > 0) {
    if (parameters.length > 0) {
      throw new TypeError('a multi-statement script cannot take bound parameters');
    }
    connection.exec(text);
    return { rows: [], rowCount: 0 };
  }

  // Which of the two ways to run a statement is not a guess: a statement with
  // no result columns is a write or a DDL statement, `all()` would run it and
  // report nothing about what it changed, and `run()` on a SELECT stops after
  // the first row. `columns()` is the only thing here that knows which is which.
  if (statement.columns().length === 0) {
    const { changes } = statement.run(...parameters);
    return { rows: [], rowCount: Number(changes) };
  }

  const rows = statement.all(...parameters) as Row[];
  return { rows, rowCount: rows.length };
}

/**
 * What SQLite can store, out of what a caller passed.
 *
 * A boolean is the one translation: SQLite has no boolean type, the schema
 * keeps flags as integers, and binding `true` therefore means 1. Nothing
 * converts back — a 1 read out of a row is a 1, and only the column knows
 * whether it meant a flag.
 *
 * Everything else is refused rather than coerced, blobs included: the hub
 * schema stores none, and the day one arrives it should arrive with somebody
 * deciding how. A `Date` is the refusal that matters, because `node:sqlite`
 * would take one. The hub deals in epoch milliseconds throughout, and a driver
 * that quietly accepted a `Date` would be choosing a storage format for time
 * in the one place nobody would look for that choice.
 */
function bindable(value: unknown, index: number): SQLInputValue {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (
    value === null ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'string'
  ) {
    return value;
  }
  throw new TypeError(
    `parameter ${index + 1} is of type ${typeof value}, which SQLite has no column type for`,
  );
}
