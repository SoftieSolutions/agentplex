/**
 * The database seam.
 *
 * Everything above this line talks to `Database`; exactly one module below it
 * (`postgres.ts`) names the driver. A test supplies its own implementation, and
 * swapping drivers touches one file.
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
 * One connection, held for as long as the body runs.
 *
 * This exists because Postgres has state that lives on a connection rather than
 * in the database: an advisory lock belongs to the backend that took it, and a
 * pool that hands out a different backend per query releases nothing. A session
 * can open transactions, and they run on the same connection, so a lock taken
 * before them is still held after they commit.
 */
export interface DatabaseSession extends Queryable {
  /**
   * Runs `body` inside one transaction on this connection: committed when it
   * returns, rolled back when it throws.
   */
  transaction<T>(body: (tx: Queryable) => Promise<T>): Promise<T>;
}

export interface Database extends Queryable {
  /**
   * Runs `body` inside one transaction: committed when it returns, rolled back
   * when it throws. The handle is a `Queryable` and not a `Database`, because a
   * transaction cannot open a transaction or close the pool.
   */
  transaction<T>(body: (tx: Queryable) => Promise<T>): Promise<T>;
  /**
   * Runs `body` against one connection pinned for its whole lifetime. The
   * handle is a `DatabaseSession` and not a `Database`: a session cannot close
   * the pool it was checked out of.
   */
  session<T>(body: (session: DatabaseSession) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
