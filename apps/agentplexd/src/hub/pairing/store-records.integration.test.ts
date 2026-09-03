import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { storeIdSchema, type StoreId } from '@agentplex/protocol';
import type { Database } from '../db/database.js';
import { findStore, listStores, recordStores } from './store-records.js';
import { openMigratedSchema, type MigratedSchema } from './test-migrated-schema.js';

/**
 * Store rows against a real SQLite database.
 *
 * The interesting behaviour is the upsert's, and an upsert is a thing the
 * engine does rather than a thing this code does: that a repeat report moves
 * `last_seen_at` without disturbing `first_seen_at`, and that a batch naming
 * the same store twice yields one row rather than two.
 *
 * That second one changed meaning with the dialect and is worth the sentence.
 * Postgres refused such a batch outright, so the dedupe in `recordStores` was
 * keeping an error away; SQLite accepts it and reports the row once per
 * mention, so the dedupe is now keeping a duplicate out of the answer. The
 * assertion is the same, and what it protects against is worse.
 *
 * The database is a file in a temporary directory, so this suite never skips
 * and never starts a container.
 */

let migrated: MigratedSchema | null = null;

/** The clock the schema no longer has, fixed so a stored millisecond is checkable. */
const NOW = 1_756_000_000_000;
const clock = { now: () => NOW };

function db(): Database {
  if (migrated === null) throw new Error('no database: beforeAll did not run');
  return migrated.database;
}

function store(value: string): StoreId {
  return storeIdSchema.parse(value);
}

/**
 * Backdates a store's timestamps by a day.
 *
 * Asserting that `last_seen_at` moved needs a gap, and waiting for one would be
 * a slow test that is still occasionally wrong. With the clock injected and the
 * column a plain integer, the arithmetic that was `now() - interval '1 day'`
 * is now subtraction a reader can check.
 */
const A_DAY = 24 * 60 * 60 * 1000;

async function backdateByADay(storeId: StoreId): Promise<void> {
  await db().query(
    `UPDATE stores
     SET first_seen_at = ?, last_seen_at = ?
     WHERE store_id = ?`,
    [NOW - A_DAY, NOW - A_DAY, storeId],
  );
}

describe('store records', () => {
  beforeAll(async () => {
    migrated = await openMigratedSchema('pairing-stores-probe');
  });

  afterAll(async () => {
    await migrated?.close();
  });

  beforeEach(async () => {
    // SQLite has no TRUNCATE; an unqualified DELETE is its equivalent.
    await db().query('DELETE FROM stores');
  });

  it('records a store under the id from its own agentplex-store.json', async () => {
    const [recorded] = await recordStores(db(), clock, [store('store-alpha')]);

    expect(recorded?.storeId).toBe('store-alpha');
    expect(recorded?.firstSeenAt).toBeGreaterThan(0);
    expect(recorded?.lastSeenAt).toBeGreaterThanOrEqual(recorded?.firstSeenAt ?? 0);
    expect((await findStore(db(), store('store-alpha')))?.storeId).toBe('store-alpha');
  });

  it('records a whole report in one call', async () => {
    const recorded = await recordStores(db(), clock, [
      store('store-alpha'),
      store('store-beta'),
      store('store-gamma'),
    ]);

    expect(recorded).toHaveLength(3);
    expect((await listStores(db())).map((row) => row.storeId).sort()).toEqual([
      'store-alpha',
      'store-beta',
      'store-gamma',
    ]);
  });

  it('moves last seen without disturbing first seen when a store is reported again', async () => {
    await recordStores(db(), clock, [store('store-alpha')]);
    await backdateByADay(store('store-alpha'));
    const before = await findStore(db(), store('store-alpha'));

    const [after] = await recordStores(db(), clock, [store('store-alpha')]);

    expect(after?.firstSeenAt).toBe(before?.firstSeenAt);
    expect(after?.lastSeenAt).toBeGreaterThan(before?.lastSeenAt ?? 0);
    expect(await listStores(db())).toHaveLength(1);
  });

  it('treats one store reported under two mounts as one store', async () => {
    // Two mounts of one volume are one store -- that is the entire premise of
    // keying by the id on the volume -- and Postgres refuses an upsert that
    // would touch the same row twice in one statement, so this would otherwise
    // fail the whole report rather than the duplicate.
    const recorded = await recordStores(db(), clock, [
      store('store-alpha'),
      store('store-alpha'),
      store('store-beta'),
    ]);

    expect(recorded).toHaveLength(2);
    expect(await listStores(db())).toHaveLength(2);
  });

  it('answers nothing for a server that reported no stores at all', async () => {
    expect(await recordStores(db(), clock, [])).toEqual([]);
    expect(await listStores(db())).toEqual([]);
  });

  it('keeps a store it has already met when a later report omits it', async () => {
    // A server going offline is not a store ceasing to exist, and the hub
    // holds sessions filed under this id.
    await recordStores(db(), clock, [store('store-alpha'), store('store-beta')]);

    await recordStores(db(), clock, [store('store-alpha')]);

    expect(await listStores(db())).toHaveLength(2);
  });

  it('answers nothing for a store id nobody has reported', async () => {
    expect(await findStore(db(), store('store-unknown'))).toBeNull();
  });
});
