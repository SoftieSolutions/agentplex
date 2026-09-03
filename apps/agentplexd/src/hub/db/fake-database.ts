import type { Database, DatabaseSession, Queryable, QueryResult } from './database.js';

/**
 * An in-memory stand-in for the database, understanding only the statements the
 * migration runner issues.
 *
 * It exists so the runner's control flow — reconciling, applying what is
 * missing, rolling the run back when one migration fails — is testable without
 * a database. The SQL itself is not exercised here; `migrations.integration.test`
 * runs that against a real SQLite file.
 *
 * It models connections as well as statements, because a run that reconciles on
 * one connection and writes on another has read a schema it is not the one
 * changing.
 */
export interface FakeDatabaseOptions {
  /** Migrations already recorded as applied, as `version -> name`. */
  readonly applied?: ReadonlyMap<number, string>;
  /** Statements matching this fail, to stand in for a migration that is wrong. */
  readonly failOn?: RegExp;
  /** Scripted answers for statements the fake has no built-in behaviour for. */
  readonly respondWith?: readonly ScriptedResponse[];
}

export interface ScriptedResponse {
  readonly match: RegExp;
  readonly rows: readonly unknown[];
}

/** A statement and the connection it ran on. */
export interface IssuedStatement {
  readonly text: string;
  readonly connection: number;
}

export interface FakeDatabase extends Database {
  /** Every statement issued, in order, for asserting on lock and commit order. */
  readonly statements: readonly string[];
  /** The same statements, each with the connection that ran it. */
  readonly issued: readonly IssuedStatement[];
  readonly appliedVersions: readonly number[];
  readonly closed: boolean;
}

export function createFakeDatabase(options: FakeDatabaseOptions = {}): FakeDatabase {
  const applied = new Map(options.applied ?? []);
  const issued: IssuedStatement[] = [];
  let closed = false;
  let nextConnection = 0;

  const runOn =
    (connection: number) =>
    async <Row>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> => {
      issued.push({ text: text.trim(), connection });

      if (options.failOn?.test(text) === true) {
        throw new Error(`fake database refused: ${text.trim()}`);
      }

      const scripted = options.respondWith?.find((response) => response.match.test(text));
      if (scripted !== undefined) {
        return { rows: scripted.rows as Row[], rowCount: scripted.rows.length };
      }

      if (text.includes('SELECT version, name FROM schema_migrations')) {
        const rows = [...applied].map(([version, name]) => ({ version, name }));
        return { rows: rows as Row[], rowCount: rows.length };
      }

      if (text.includes('INSERT INTO schema_migrations')) {
        const [version, name] = values ?? [];
        applied.set(Number(version), String(name));
        return { rows: [], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    };

  const transactionOn = (connection: number) => {
    return async <T>(body: (tx: Queryable) => Promise<T>): Promise<T> => {
      // The snapshot is the rollback: a body that throws leaves no trace.
      const snapshot = new Map(applied);
      try {
        return await body({ query: runOn(connection) });
      } catch (error) {
        applied.clear();
        for (const [version, name] of snapshot) applied.set(version, name);
        throw error;
      }
    };
  };

  const session = async <T>(body: (handle: DatabaseSession) => Promise<T>): Promise<T> => {
    // One connection for the whole body, the way a checked-out pool client is.
    const connection = (nextConnection += 1);
    return body({ query: runOn(connection), transaction: transactionOn(connection) });
  };

  return {
    // A pool hands out whichever connection is free, so every statement issued
    // outside a session is modelled as landing on a different one.
    query: (text, values) => runOn((nextConnection += 1))(text, values),

    transaction: (body) => session((handle) => handle.transaction(body)),

    session,

    async close() {
      closed = true;
    },

    get statements() {
      return issued.map((statement) => statement.text);
    },
    get issued() {
      return issued;
    },
    get appliedVersions() {
      return [...applied.keys()].sort((left, right) => left - right);
    },
    get closed() {
      return closed;
    },
  };
}
