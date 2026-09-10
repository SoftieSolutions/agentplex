import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from './database.js';
import { openMigratedSchema, type MigratedSchema } from '../pairing/test-migrated-schema.js';

/**
 * Rules about the shape of the schema, asserted by reading the schema back.
 *
 * These are not tests of any one function. They are the two design rules the
 * node tree is built on, written so that a future migration which breaks one
 * fails CI rather than being noticed a year later by whoever is debugging why
 * the tree deleted itself:
 *
 *   * a session-keyed table holds no foreign key into `nodes`;
 *   * a new node kind is an INSERT, never a schema change.
 *
 * They read `sqlite_schema` and `PRAGMA foreign_key_list` rather than the
 * migration text, so a violation introduced by any means at all is caught --
 * including by a migration that does it through a table rebuild.
 */

let migrated: MigratedSchema | null = null;

function db(): Database {
  if (migrated === null) throw new Error('no database: beforeAll did not run');
  return migrated.database;
}

const tableSchema = z.object({ name: z.string() });

/** Every table in the migrated schema, SQLite's own bookkeeping excluded. */
async function tables(): Promise<readonly string[]> {
  const result = await db().query(
    `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  );
  return result.rows.map((row) => tableSchema.parse(row).name);
}

const columnSchema = z.object({ name: z.string() });

async function columnsOf(table: string): Promise<readonly string[]> {
  // The table name cannot be bound: PRAGMA takes an identifier, not a value.
  // It comes from `sqlite_schema` in this same database rather than from any
  // input, which is what makes the interpolation safe here and nowhere else.
  const result = await db().query(`PRAGMA table_info(${table})`);
  return result.rows.map((row) => columnSchema.parse(row).name);
}

const foreignKeySchema = z.object({ table: z.string(), from: z.string() });

async function foreignKeysOf(table: string): Promise<readonly { table: string; from: string }[]> {
  const result = await db().query(`PRAGMA foreign_key_list(${table})`);
  return result.rows.map((row) => foreignKeySchema.parse(row));
}

describe('the schema, read back', () => {
  beforeAll(async () => {
    migrated = await openMigratedSchema('schema-invariants-probe');
  });

  afterAll(async () => {
    await migrated?.close();
  });

  /**
   * The rule the ticket exists to make permanent.
   *
   * A session-keyed row is about a session, and a session outlives any node
   * that happened to point at it: the node can be removed, pruned, or moved
   * while the session sits on disk untouched. A foreign key into `nodes` is
   * precisely the promise that it will not outlive the node -- and with a
   * cascade it is a promise that removing a node silently deletes the row that
   * was supposed to remember the removal, which is the bug this whole design is
   * arranged against.
   *
   * `node_removals` is the table that would be most tempted, and it is the
   * reason this is a test and not a sentence in a comment.
   */
  it('gives no session-keyed table a foreign key into nodes', async () => {
    const sessionKeyed: string[] = [];
    for (const table of await tables()) {
      if ((await columnsOf(table)).includes('session_id')) sessionKeyed.push(table);
    }

    // If this ever finds nothing, the assertion below is vacuous and the rule
    // is unguarded. `node_removals` is session-keyed today; a rename that lost
    // it should fail here rather than turn the test into a no-op.
    expect(sessionKeyed).toContain('node_removals');

    for (const table of sessionKeyed) {
      const intoNodes = (await foreignKeysOf(table)).filter((key) => key.table === 'nodes');
      expect(intoNodes, `${table} must hold no foreign key into nodes`).toEqual([]);
    }
  });

  /**
   * The other half: `nodes` points at `node_kinds`, which is what makes a kind
   * a row rather than a constraint. Asserted so that a migration replacing the
   * lookup table with a CHECK -- the tempting simplification -- fails here.
   */
  it('keys a node to its kind by foreign key', async () => {
    const kindKey = (await foreignKeysOf('nodes')).find((key) => key.from === 'kind');
    expect(kindKey?.table).toBe('node_kinds');
  });

  it('refuses a node whose kind is not a row in the lookup table', async () => {
    await expect(
      db().query(
        `INSERT INTO nodes (id, kind, position, created_at) VALUES ('n1', 'saved-search', 0, 1)`,
      ),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  /**
   * The ticket's headline, as an executable claim: adding a kind costs an
   * INSERT.
   *
   * The statements below are the whole cost of a new node kind. No ALTER, no
   * table rebuild, no change to `nodes`, and every node written before it keeps
   * its meaning. Held as a CHECK instead, this test would have to run a
   * four-statement table rebuild against live data to say the same thing.
   */
  it('takes a new node kind as an INSERT, with no change to any table', async () => {
    const before = await tables();

    await db().query(
      `INSERT INTO node_kinds (kind, container, anchors_session) VALUES ('saved-search', 0, 0)`,
    );
    await db().query(
      `INSERT INTO nodes (id, kind, position, name, name_source, created_at)
       VALUES ('n-search', 'saved-search', 0, 'needs me', 'user', 1)`,
    );

    const stored = await db().query(`SELECT kind FROM nodes WHERE id = 'n-search'`);
    expect(stored.rows[0]).toEqual({ kind: 'saved-search' });
    expect(await tables()).toEqual(before);
    expect(await columnsOf('nodes')).toContain('kind');

    await db().query(`DELETE FROM nodes WHERE id = 'n-search'`);
    await db().query(`DELETE FROM node_kinds WHERE kind = 'saved-search'`);
  });

  it('seeds the two kinds v2 ships, so nothing has to insert them at startup', async () => {
    const result = await db().query(
      'SELECT kind, container, anchors_session FROM node_kinds ORDER BY kind',
    );
    expect(result.rows).toEqual([
      { kind: 'folder', container: 1, anchors_session: 0 },
      { kind: 'session', container: 0, anchors_session: 1 },
    ]);
  });

  /**
   * A node's anchor is deliberately unenforced, and that is worth asserting
   * rather than leaving as the absence of a constraint somebody might helpfully
   * add. The hub stores no sessions, so there is nothing for an anchor to
   * reference; the prune is what notices a session has gone.
   */
  it('leaves a node anchor pointing at nothing the database can check', async () => {
    const anchors = (await foreignKeysOf('nodes')).filter((key) => key.from.startsWith('anchor_'));
    expect(anchors).toEqual([]);
  });

  it('refuses half an anchor, since a session id without its store names nothing', async () => {
    await expect(
      db().query(
        `INSERT INTO nodes (id, kind, position, anchor_session_id, created_at)
         VALUES ('n-half', 'session', 0, 's1', 1)`,
      ),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});
