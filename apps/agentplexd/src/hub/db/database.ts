/**
 * The database seam.
 *
 * Everything above this line talks to `Database`; exactly one module below it
 * (`sqlite.ts`) names the driver `main` opens. A test supplies its own
 * implementation, and swapping drivers touches one file — which is what is
 * happening now: `postgres.ts` is the driver being replaced, no longer reached
 * by anything but its own suite, and it goes in its own ticket.
 */
export interface QueryResult<Row> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export interface Queryable {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

/**
 * A database, which is a `Queryable` that can also group statements and close.
 *
 * There was a third verb here — `session`, a connection pinned for the length
 * of a body — and it is worth saying why it is gone rather than leaving the
 * next reader to wonder. It existed for one Postgres fact: an advisory lock
 * belongs to the backend that took it, and a pool that hands out a different
 * backend per query releases the lock as soon as it releases the client. The
 * migration runner was the only caller, and the lock was the only reason.
 * SQLite has neither: one file, one connection, and `BEGIN IMMEDIATE` in place
 * of the advisory lock. A pinned handle is what every handle already is, so the
 * verb no longer distinguishes anything, and an interface that promises a
 * guarantee it cannot describe is worse than one that does not offer it — the
 * next reader would take `session` for a lock and reach for it.
 */
export interface Database extends Queryable {
  /**
   * Runs `body` inside one transaction: committed when it returns, rolled back
   * when it throws. The handle is a `Queryable` and not a `Database`, because a
   * transaction cannot open a transaction or close the database under itself.
   */
  transaction<T>(body: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
