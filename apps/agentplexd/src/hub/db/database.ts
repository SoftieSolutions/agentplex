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

export interface Database extends Queryable {
  /**
   * Runs `body` inside one transaction: committed when it returns, rolled back
   * when it throws. The handle is a `Queryable` and not a `Database`, because a
   * transaction cannot open a transaction or close the pool.
   */
  transaction<T>(body: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
