/**
 * The database seam.
 *
 * Everything above this line talks to `Database`; exactly one module below it
 * (`sqlite.ts`) names the driver `main` opens. A test supplies its own
 * implementation, and swapping drivers touches one file.
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
 * There is deliberately no third verb for a connection pinned across a body.
 * One file means one connection, so a pinned handle is what every handle
 * already is and the verb would distinguish nothing. The migration runner is
 * the only caller that would reach for one, and it serializes on
 * `BEGIN IMMEDIATE` instead. An interface that promises a guarantee it cannot
 * describe is worse than one that does not offer it: the next reader would
 * take such a verb for a lock and rely on it.
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
