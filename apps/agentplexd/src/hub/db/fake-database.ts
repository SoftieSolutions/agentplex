import type { Database, Queryable, QueryResult } from './database.js';

/**
 * An in-memory stand-in for the database, understanding only the statements the
 * migration runner issues.
 *
 * It exists so the runner's control flow — reconciling, applying what is
 * missing, rolling the run back when one migration fails — is testable without
 * a database. The SQL itself is not exercised here; `migrations.integration.test`
 * runs that against a real SQLite file.
 *
 * It labels each statement with the transaction it ran in, because a run that
 * reconciles outside the transaction it writes in has read a schema it is not
 * the one changing. With one file there is one connection, so the only
 * distinction worth labelling is inside the transaction or beside it.
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

/** A statement and the transaction it ran in, or `null` when it ran outside one. */
export interface IssuedStatement {
  readonly text: string;
  readonly transaction: number | null;
}

export interface FakeDatabase extends Database {
  /** Every statement issued, in order, for asserting on what a run did and when. */
  readonly statements: readonly string[];
  /** The same statements, each with the transaction that ran it. */
  readonly issued: readonly IssuedStatement[];
  readonly appliedVersions: readonly number[];
  readonly closed: boolean;
}

export function createFakeDatabase(options: FakeDatabaseOptions = {}): FakeDatabase {
  const applied = new Map(options.applied ?? []);
  const issued: IssuedStatement[] = [];
  let closed = false;
  let nextTransaction = 0;

  const runIn =
    (transaction: number | null) =>
    async <Row>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> => {
      issued.push({ text: text.trim(), transaction });

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

  return {
    query: (text, values) => runIn(null)(text, values),

    async transaction<T>(body: (tx: Queryable) => Promise<T>): Promise<T> {
      const transaction = (nextTransaction += 1);
      // The snapshot is the rollback: a body that throws leaves no trace.
      const snapshot = new Map(applied);
      try {
        return await body({ query: runIn(transaction) });
      } catch (error) {
        applied.clear();
        for (const [version, name] of snapshot) applied.set(version, name);
        throw error;
      }
    },

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
