import pg from 'pg';
import type { Database, Queryable, QueryResult } from './database.js';

/**
 * The one module that names the Postgres driver.
 *
 * The hub is the single writer to this database, so the pool exists to overlap
 * requests, not to coordinate writers.
 */

export interface PostgresOptions {
  /** Upper bound on concurrent connections. */
  readonly maxConnections?: number;
  /** How long to wait for a connection before failing the query, in ms. */
  readonly connectionTimeoutMs?: number;
}

/**
 * One connection out of the pool, held for as long as the body runs.
 *
 * This used to sit on `Database`, and it came back here when the seam was
 * narrowed: pinning a connection is a thing a pool can do and a single-file
 * database cannot say. The reason it ever existed is Postgres state that lives
 * on a connection rather than in the database — an advisory lock belongs to the
 * backend that took it, and a pool that hands out a different backend per query
 * releases nothing. A session can open transactions, and they run on the same
 * connection, so a lock taken before them is still held after they commit.
 *
 * Nothing above the seam calls this any more; it stays only as long as the
 * driver does, which is until this file is deleted.
 */
export interface PostgresSession extends Queryable {
  /**
   * Runs `body` inside one transaction on this connection: committed when it
   * returns, rolled back when it throws.
   */
  transaction<T>(body: (tx: Queryable) => Promise<T>): Promise<T>;
}

export interface PostgresDatabase extends Database {
  /**
   * Runs `body` against one connection pinned for its whole lifetime. The
   * handle is a `PostgresSession` and not a `Database`: a session cannot close
   * the pool it was checked out of.
   */
  session<T>(body: (session: PostgresSession) => Promise<T>): Promise<T>;
}

export function createPostgresDatabase(
  url: string,
  options: PostgresOptions = {},
): PostgresDatabase {
  const pool = new pg.Pool({
    connectionString: url,
    max: options.maxConnections ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 10_000,
  });

  // A pool that emits an unhandled 'error' takes the process down. An idle
  // client dropped by the server is normal; the pool discards it and moves on.
  pool.on('error', () => {});

  const queryOn =
    (executor: pg.Pool | pg.PoolClient) =>
    async <Row>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> => {
      const result = await executor.query(text, values as unknown[] | undefined);
      return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
    };

  const transactionOn =
    (client: pg.PoolClient) =>
    async <T>(body: (tx: Queryable) => Promise<T>): Promise<T> => {
      await client.query('BEGIN');
      try {
        const value = await body({ query: queryOn(client) });
        await client.query('COMMIT');
        return value;
      } catch (error) {
        // A rollback can itself fail on a broken connection. The original error
        // is the one worth reporting; discarding the client cleans up the rest.
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    };

  const session = async <T>(body: (handle: PostgresSession) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      return await body({ query: queryOn(client), transaction: transactionOn(client) });
    } finally {
      client.release();
    }
  };

  return {
    query: queryOn(pool),

    // A transaction is a session that runs one statement group: both need a
    // connection held across several statements, so expressing one in terms of
    // the other leaves a single place where a client is checked out and freed.
    transaction: (body) => session((handle) => handle.transaction(body)),

    session,

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
