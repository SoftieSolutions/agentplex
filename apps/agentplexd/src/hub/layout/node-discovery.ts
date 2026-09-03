import type { SessionRef } from '@agentplex/protocol';
import type { Database, Queryable } from '../db/database.js';
import type { Clock } from '../../shared/clock.js';
import type { IdGenerator } from '../../shared/ids.js';
import { findNodeForSession, SESSION_KIND, type TreeNode } from './node-tree.js';

/**
 * Discovery, as it touches the tree: a session a server reported gets a place.
 *
 * This is the only writer that is not the user, and the whole design is about
 * what it may not do. It creates a node once, in a default place, and follows
 * the transcript title. It never moves a node, never renames one the user has
 * renamed, and never re-creates one the user removed. Every one of those would
 * be the user watching an edit of theirs get undone by a background scan with
 * nothing on screen to explain it, which is the failure the whole node-tree
 * design is arranged against.
 *
 * The default place is the root. Not a folder minted per store: that would have
 * discovery creating containers the user never asked for, and then removing one
 * would mean remembering the removal of a thing nothing on disk describes. The
 * root is somewhere, the user moves it, and the move sticks forever after.
 */

/** One session a scan found, and what its transcript calls it. */
export interface DiscoveredSession {
  readonly ref: SessionRef;
  /** The provider's title, or `null` when it names its sessions nothing. */
  readonly title: string | null;
}

export interface DiscoveryOutcome {
  /** Nodes placed for sessions that had none. */
  readonly created: readonly TreeNode[];
  /** Nodes whose name followed a changed transcript title. */
  readonly retitled: readonly TreeNode[];
  /**
   * Sessions the hub declined to place because their removal is remembered.
   *
   * Reported rather than silent: it is the count that tells an operator the
   * difference between "discovery found nothing" and "discovery found things it
   * has been told not to show".
   */
  readonly suppressed: readonly SessionRef[];
}

/**
 * Places what is new, retitles what still follows its title, restores nothing.
 *
 * One transaction for the batch. A scan is one reading of one store, and half
 * of it committed is a tree that agrees with no scan that ever happened.
 */
export async function discoverNodes(
  database: Database,
  ids: IdGenerator,
  clock: Clock,
  sessions: readonly DiscoveredSession[],
): Promise<DiscoveryOutcome> {
  if (sessions.length === 0) return { created: [], retitled: [], suppressed: [] };

  return database.transaction(async (tx) => {
    const created: TreeNode[] = [];
    const retitled: TreeNode[] = [];
    const suppressed: SessionRef[] = [];

    for (const session of sessions) {
      const existing = await findNodeForSession(tx, session.ref);

      if (existing !== null) {
        // The node is here, so its placement is settled -- by the user if they
        // moved it, by the creation below if they did not, and either way not
        // by this scan. The only column discovery may still write is the name,
        // and only while the name is still following the title.
        const followed = await followTitle(tx, existing, session.title);
        if (followed !== null) retitled.push(followed);
        continue;
      }

      const placed = await placeSession(tx, ids, clock, session);
      if (placed === null) suppressed.push(session.ref);
      else created.push(placed);
    }

    return { created, retitled, suppressed };
  });
}

/**
 * A name follows the transcript title until the user renames it.
 *
 * `name_source = 'user'` in the WHERE clause rather than in a branch above it,
 * so the check and the write are one statement. A rename landing between a read
 * and an update would otherwise be a rename this scan overwrites, which is
 * exactly the promise being made here and the hardest way to break it.
 *
 * Answers the node when this actually changed the name, and `null` otherwise --
 * which covers both "the user owns this name" and "the title has not moved".
 */
async function followTitle(
  database: Queryable,
  node: TreeNode,
  title: string | null,
): Promise<TreeNode | null> {
  if (node.named) return null;
  if (node.name === title) return null;
  const result = await database.query(
    `UPDATE nodes SET name = ? WHERE id = ? AND name_source = 'discovered'`,
    [title, node.id],
  );
  if (result.rowCount === 0) return null;
  return findNodeForSession(database, nonNullAnchor(node));
}

/** A session node always has an anchor; the parser is what guarantees it. */
function nonNullAnchor(node: TreeNode): SessionRef {
  if (node.anchor === null) throw new Error(`node ${String(node.id)} anchors no session`);
  return node.anchor;
}

/**
 * Places one session at the root, unless its removal is remembered.
 *
 * The removal check is in the INSERT rather than before it, and that is what
 * makes "either the removal is remembered or discovery restores the node" true
 * rather than usually true: a removal committed between a read and an insert
 * would otherwise lose to this scan, and the user would watch the session they
 * just removed come straight back.
 *
 * It is a HAVING and not a WHERE, and the difference is the whole behaviour.
 * The SELECT aggregates -- it reads the last root position -- and an aggregate
 * with no GROUP BY returns exactly one row however many rows the WHERE let
 * through. A `WHERE NOT EXISTS` therefore filters the rows being counted and
 * not the row being inserted: verified at the origin, it inserts the suppressed
 * session anyway, with position 0. HAVING filters the aggregate row itself,
 * which is the one this statement writes.
 *
 * `null` means the insert wrote nothing, which here has exactly one cause.
 */
async function placeSession(
  database: Queryable,
  ids: IdGenerator,
  clock: Clock,
  session: DiscoveredSession,
): Promise<TreeNode | null> {
  const result = await database.query(
    `INSERT INTO nodes
       (id, parent_id, kind, position, name, name_source, anchor_store_id, anchor_session_id, created_at)
     SELECT ?, NULL, ?, coalesce(max(position), -1) + 1, ?, 'discovered', ?, ?, ?
       FROM nodes WHERE parent_id IS NULL
     HAVING NOT EXISTS (
        SELECT 1 FROM node_removals WHERE store_id = ? AND session_id = ?
      )`,
    [
      ids.newId(),
      SESSION_KIND,
      session.title,
      session.ref.storeId,
      session.ref.sessionId,
      clock.now(),
      session.ref.storeId,
      session.ref.sessionId,
    ],
  );
  if (result.rowCount === 0) return null;
  return findNodeForSession(database, session.ref);
}
