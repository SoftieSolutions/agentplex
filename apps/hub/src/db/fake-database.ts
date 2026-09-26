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
  /**
   * Migrations already recorded as applied, by version. A digest of `null` is
   * a row from before digests were kept. Passing any rows starts the fake
   * without the digest column, as a database migrated by an older build.
   */
  readonly applied?: ReadonlyMap<number, AppliedRow>;
  /** Statements matching this fail, to stand in for a migration that is wrong. */
  readonly failOn?: RegExp;
  /** Scripted answers for statements the fake has no built-in behaviour for. */
  readonly respondWith?: readonly ScriptedResponse[];
}

export interface ScriptedResponse {
  readonly match: RegExp;
  readonly rows: readonly unknown[];
}

/** A bookkeeping row as the fake holds it: what `schema_migrations` records. */
export interface AppliedRow {
  readonly name: string;
  readonly digest: string | null;
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
  /**
   * The bookkeeping rows, digests included. `issued` records no bound values,
   * so this is where a test reads what a backfill or an apply wrote.
   */
  readonly appliedRows: ReadonlyMap<number, AppliedRow>;
  readonly closed: boolean;
}

export function createFakeDatabase(options: FakeDatabaseOptions = {}): FakeDatabase {
  const applied = new Map(options.applied ?? []);
  // Named as the runner reads it back from `PRAGMA table_info`.
  const bookkeepingColumns = ['version', 'name', 'applied_at'];
  let digestColumn = false;
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

      if (text.includes('PRAGMA table_info(schema_migrations)')) {
        const names = digestColumn ? [...bookkeepingColumns, 'sql_sha256'] : bookkeepingColumns;
        const rows = names.map((name) => ({ name }));
        return { rows: rows as Row[], rowCount: rows.length };
      }

      if (text.includes('ALTER TABLE schema_migrations ADD COLUMN sql_sha256')) {
        digestColumn = true;
        return { rows: [], rowCount: 0 };
      }

      if (text.includes('SELECT version, name, sql_sha256 FROM schema_migrations')) {
        const rows = [...applied].map(([version, row]) => ({
          version,
          name: row.name,
          sql_sha256: row.digest,
        }));
        return { rows: rows as Row[], rowCount: rows.length };
      }

      if (text.includes('UPDATE schema_migrations SET sql_sha256 = ? WHERE version = ?')) {
        const [digest, version] = values ?? [];
        const existing = applied.get(Number(version));
        if (existing === undefined) return { rows: [], rowCount: 0 };
        // A new object, never a mutation: the rollback snapshot shares rows.
        applied.set(Number(version), { name: existing.name, digest: String(digest) });
        return { rows: [], rowCount: 1 };
      }

      if (text.includes('INSERT INTO schema_migrations (version, name, applied_at, sql_sha256)')) {
        const [version, name, , digest] = values ?? [];
        applied.set(Number(version), { name: String(name), digest: String(digest) });
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
      const digestColumnBefore = digestColumn;
      try {
        return await body({ query: runIn(transaction) });
      } catch (error) {
        applied.clear();
        for (const [version, row] of snapshot) applied.set(version, row);
        digestColumn = digestColumnBefore;
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
    get appliedRows() {
      return new Map(applied);
    },
    get closed() {
      return closed;
    },
  };
}
