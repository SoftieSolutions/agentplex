import { z } from 'zod';
import { storeIdSchema, type StoreId } from '@agentplex/protocol';
import type { Queryable } from '../db/database.js';
import type { Clock } from '../../shared/clock.js';

/**
 * The stores this hub has been told about, keyed by the id in the store's own
 * `agentplex-store.json`.
 *
 * A store row is an anchor and almost nothing else: a session is
 * `{ storeId, sessionId }`, so the hub needs somewhere durable for the store
 * half of that to point, and it needs it to be the same row no matter which
 * server reported the store or where that server has it mounted. What a store
 * is *called*, what is *in* it, and who has it mounted are all facts that live
 * elsewhere; see the migration for why the mount path is not here.
 */

/** Epoch milliseconds in the column and on the protocol; parsed, not assumed. */
const timestampSchema = z.number().int();

const storeRecordSchema = z
  .object({
    store_id: storeIdSchema,
    first_seen_at: timestampSchema,
    last_seen_at: timestampSchema,
  })
  .transform((row) => ({
    storeId: row.store_id,
    firstSeenAt: row.first_seen_at,
    /**
     * When a server last reported this store. Not "the store is there now":
     * the whole reason both timestamps are kept is so a listing can say how
     * old what it knows is rather than implying it is current.
     */
    lastSeenAt: row.last_seen_at,
  }));
export type StoreRecord = z.infer<typeof storeRecordSchema>;

const COLUMNS = 'store_id, first_seen_at, last_seen_at';

/**
 * Upserts the stores a server just reported, and answers with the rows as they
 * now stand.
 *
 * One statement for the whole set, because this runs on every handshake and a
 * server can have a dozen stores mounted. `first_seen_at` is deliberately not
 * touched on conflict: a store the hub met last year is not new because a
 * server reconnected this morning, and the moment that column starts moving it
 * stops answering the only question it exists to answer.
 */
export async function recordStores(
  database: Queryable,
  clock: Clock,
  storeIds: readonly StoreId[],
): Promise<readonly StoreRecord[]> {
  // Deduping is load-bearing, and more so here than against Postgres. Postgres
  // refused an ON CONFLICT DO UPDATE that touched one row twice in a
  // statement, so a server reporting a store under two mounts failed the whole
  // batch and said so. SQLite accepts it and returns that row once per
  // mention, so the same input would hand the caller a list with one store in
  // it twice -- a wrong answer instead of an error, which is the direction
  // that hides. The premise is unchanged: two mounts of one store are one
  // store, which is why the key is the id on the volume.
  const unique = [...new Set(storeIds)];
  if (unique.length === 0) return [];

  // Still one statement for the whole set, with the row list built here rather
  // than by a loop of round trips. `excluded` is the row this statement tried
  // to insert, which is where the new `last_seen_at` comes from;
  // `first_seen_at` is absent from the DO UPDATE, so a store the hub met last
  // year keeps the date it actually met it.
  const now = clock.now();
  const values = unique.map(() => '(?, ?, ?)').join(', ');
  const result = await database.query(
    `INSERT INTO stores (store_id, first_seen_at, last_seen_at)
     VALUES ${values}
     ON CONFLICT (store_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
     RETURNING ${COLUMNS}`,
    unique.flatMap((storeId) => [storeId, now, now]),
  );
  return result.rows.map((row) => storeRecordSchema.parse(row));
}

/** Every store the hub knows of, first seen first. */
export async function listStores(database: Queryable): Promise<readonly StoreRecord[]> {
  const result = await database.query(
    `SELECT ${COLUMNS} FROM stores ORDER BY first_seen_at, store_id`,
  );
  return result.rows.map((row) => storeRecordSchema.parse(row));
}

/** One store by its id, or `null` when this hub has never been told about it. */
export async function findStore(
  database: Queryable,
  storeId: StoreId,
): Promise<StoreRecord | null> {
  const result = await database.query(`SELECT ${COLUMNS} FROM stores WHERE store_id = ?`, [
    storeId,
  ]);
  const row = result.rows[0];
  return row === undefined ? null : storeRecordSchema.parse(row);
}
