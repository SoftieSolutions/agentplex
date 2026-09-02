import type { Database, Queryable, QueryResult } from './database.js';

/**
 * An in-memory stand-in for Postgres, understanding only the statements the
 * migration runner issues.
 *
 * It exists so the runner's control flow — locking, reconciling, one
 * transaction per migration, rolling back a failure — is testable without a
 * database. The SQL itself is not exercised here; `migrations.integration.test`
 * runs that against a real Postgres.
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

export interface FakeDatabase extends Database {
  /** Every statement issued, in order, for asserting on lock and commit order. */
  readonly statements: readonly string[];
  readonly appliedVersions: readonly number[];
  readonly closed: boolean;
}

export function createFakeDatabase(options: FakeDatabaseOptions = {}): FakeDatabase {
  const applied = new Map(options.applied ?? []);
  const statements: string[] = [];
  let closed = false;

  const run = async <Row>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> => {
    statements.push(text.trim());

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
    query: run,

    async transaction<T>(body: (tx: Queryable) => Promise<T>): Promise<T> {
      // The snapshot is the rollback: a body that throws leaves no trace.
      const snapshot = new Map(applied);
      try {
        return await body({ query: run });
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
      return statements;
    },
    get appliedVersions() {
      return [...applied.keys()].sort((left, right) => left - right);
    },
    get closed() {
      return closed;
    },
  };
}
