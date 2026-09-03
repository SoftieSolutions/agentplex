import { z } from 'zod';
import {
  sessionIdSchema,
  storeIdSchema,
  type SessionId,
  type SessionRef,
  type StoreId,
} from '@agentplex/protocol';
import type { Database, Queryable } from '../db/database.js';

/**
 * What both sweeps return. The removal sweep aliases its columns to these
 * names, so one parser reads the output of both statements rather than two
 * parsers that agree today.
 */
const deletedRefSchema = z
  .object({ anchor_store_id: storeIdSchema, anchor_session_id: sessionIdSchema })
  .transform((row) => ({ storeId: row.anchor_store_id, sessionId: row.anchor_session_id }));

/**
 * The sweep that takes out tree references to sessions that no longer exist.
 *
 * It exists because nothing else can. A node anchors `{ storeId, sessionId }`
 * and there is no sessions table for that to reference -- the hub persists no
 * sessions, deliberately -- so no foreign key and no cascade can notice that a
 * session went away. Somebody has to look, and this is that.
 *
 * The whole difficulty is in what counts as looking. A node's session being
 * absent from what the hub can currently see has two causes that are
 * indistinguishable from here:
 *
 *   * the session is gone -- its transcript was deleted;
 *   * nobody could reach the store it lives in -- a laptop is asleep, a token
 *     was revoked, a network is down.
 *
 * Deleting on the second is the over-claim this codebase refuses everywhere
 * else: absence of evidence is not evidence of absence, and the cost here is
 * not a stale label but the user's arrangement of their screen quietly
 * dismantling itself while their laptop is shut. So the sweep is driven by what
 * was actually *reached*, store by store, and never by what the hub failed to
 * find. A store nobody reached is not swept. A scan that reached nothing sweeps
 * nothing, which is the same rule and the case worth naming.
 *
 * The converse is what makes it a sweep at all: a store that *was* reached and
 * reported no sessions is evidence. An empty store is a fact a server can
 * establish, and its nodes go.
 */

/**
 * One store a server actually reached, and everything it saw in it.
 *
 * Reached is the load-bearing word, and it is the caller's to establish: this
 * takes the stores whose sessions were genuinely enumerated, not every store
 * the hub has heard of. Handing it an unreachable store's last-known -- or
 * empty -- session list is how the safeguard above gets spent by its caller.
 */
export interface StoreScan {
  readonly storeId: StoreId;
  /**
   * Every session that store holds, whole. Never a delta: what is absent from
   * this list is what the sweep will act on.
   */
  readonly sessions: readonly SessionId[];
}

export interface PruneOutcome {
  /** Nodes whose sessions a reached store no longer has. */
  readonly pruned: readonly SessionRef[];
  /**
   * Remembered removals dropped because their session is gone too.
   *
   * A removal exists to stop discovery re-creating a node. Once the session
   * itself is gone there is nothing left for it to suppress, and a memory that
   * can never be consulted again is a row that grows without bound and answers
   * no question.
   */
  readonly forgotten: readonly SessionRef[];
}

const NOTHING: PruneOutcome = { pruned: [], forgotten: [] };

/**
 * Sweeps the tree against what a scan actually reached.
 *
 * Removals are not recorded for what this deletes, and that is the difference
 * between a prune and a removal. A removal is the user saying "not this one",
 * and it must survive the session being discovered again. A prune is the hub
 * noticing the session is gone: there is nothing to remember, and remembering
 * it would mean that a store which came back -- restored from a backup,
 * re-attached after a rebuild -- had every one of its sessions permanently
 * suppressed by an outage.
 */
export async function pruneNodes(
  database: Database,
  scan: readonly StoreScan[],
): Promise<PruneOutcome> {
  // The named case, and it is already implied by the loop below: with no stores
  // reached there is nothing to sweep against. It is written out because it is
  // the case that matters -- every server unreachable, the hub seeing nothing --
  // and a rule that only holds as an emergent property of a loop is one a later
  // edit can lose without noticing.
  if (scan.length === 0) return NOTHING;

  return database.transaction(async (tx) => {
    const pruned: SessionRef[] = [];
    const forgotten: SessionRef[] = [];

    for (const store of scan) {
      pruned.push(...(await sweepNodes(tx, store)));
      forgotten.push(...(await sweepRemovals(tx, store)));
    }

    return { pruned, forgotten };
  });
}

/**
 * Deletes the anchored nodes of one reached store whose sessions it no longer
 * reports.
 *
 * Only anchored nodes: a folder's anchor columns are NULL, so `anchor_store_id
 * = ?` never matches one, and the user's containers survive a sweep even when
 * everything in them does not.
 */
async function sweepNodes(database: Queryable, store: StoreScan): Promise<readonly SessionRef[]> {
  const result = await database.query(
    `DELETE FROM nodes
      WHERE anchor_store_id = ?${notAmong('anchor_session_id', store.sessions)}
      RETURNING anchor_store_id, anchor_session_id`,
    [store.storeId, ...store.sessions],
  );
  return result.rows.map((row) => deletedRefSchema.parse(row));
}

async function sweepRemovals(
  database: Queryable,
  store: StoreScan,
): Promise<readonly SessionRef[]> {
  const result = await database.query(
    `DELETE FROM node_removals
      WHERE store_id = ?${notAmong('session_id', store.sessions)}
      RETURNING store_id AS anchor_store_id, session_id AS anchor_session_id`,
    [store.storeId, ...store.sessions],
  );
  return result.rows.map((row) => deletedRefSchema.parse(row));
}

/**
 * ` AND <column> NOT IN (?, ?, ...)`, or nothing at all when the list is empty.
 *
 * `NOT IN ()` is not valid SQL, and the empty case is not an edge here but the
 * meaningful one: a store that was reached and holds no sessions. Omitting the
 * clause is what says so -- every anchored node in that store goes, because a
 * server looked and there was nothing there.
 */
function notAmong(column: string, values: readonly SessionId[]): string {
  if (values.length === 0) return '';
  return ` AND ${column} NOT IN (${values.map(() => '?').join(', ')})`;
}
