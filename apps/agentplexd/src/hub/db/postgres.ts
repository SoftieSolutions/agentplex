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

export function createPostgresDatabase(url: string, options: PostgresOptions = {}): Database {
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

  return {
    query: queryOn(pool),

    async transaction<T>(body: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const value = await body({ query: queryOn(client) });
        await client.query('COMMIT');
        return value;
      } catch (error) {
        // A rollback can itself fail on a broken connection. The original error
        // is the one worth reporting; discarding the client cleans up the rest.
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
