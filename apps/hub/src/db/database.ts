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
 * `transaction` already is one: while a body runs, its `tx` is the only handle
 * that reaches the connection, and every top-level `query` waits for the body
 * to settle. The migration runner is the only caller that would reach for a
 * pinned handle, and it serializes on `BEGIN IMMEDIATE` instead. An interface
 * that promises a guarantee it cannot describe is worse than one that does not
 * offer it: the next reader would take such a verb for a lock and rely on it.
 *
 * The same queue is why a body must use `tx` and nothing else. A top-level
 * query awaited from inside a body waits on the body that is waiting on it.
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
