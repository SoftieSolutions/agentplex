import type { NodeId, SessionRef } from '@agentplex/protocol';
import type { Queryable } from '../db/database.js';
import type { Clock, IdGenerator } from '@agentplex/node-shared';
import type { DiscoveredSession, DiscoveryOutcome } from './catalogue.js';
import { findNodeForSession } from './reads.js';
import { SESSION_KIND, type TreeNode } from './rows.js';

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
 *
 * ## Projects, and why there is still no `placed_by`
 *
 * A session whose reported `cwd` is a project's directory is created inside
 * that project rather than at the root. That is a different default place, not
 * a new power: it is still decided once, at creation, and this still never
 * moves a node afterwards.
 *
 * Migration 0004 argued that `nodes` needs no `placed_by` column to sit beside
 * `name_source`, because discovery writes placement exactly once and a name
 * repeatedly -- so the name needs somewhere to learn it must stop and the
 * placement does not. Projects do not change that argument, they lean on it.
 * The parent is resolved at the moment the row is written and never consulted
 * again; a node that already exists takes the branch above and is left exactly
 * where it is, whoever put it there.
 *
 * The visible consequence, which is the honest cost of keeping the rule: a
 * session discovered *before* its project was made stays at the root, and
 * making the project does not gather it up. Moving it would mean this deciding
 * that a node at the root is there by default rather than by choice -- and
 * nothing in the schema can tell those apart, which is exactly what a
 * `placed_by` column would have had to record. The tree already has a move for
 * the user to make, and a scan that rearranged yesterday's sessions the moment
 * somebody typed a name would be the edit-undone-by-a-background-job failure
 * this whole design is arranged against.
 */

/**
 * Places what is new, retitles what still follows its title, restores nothing.
 *
 * A `Queryable` and not a `Database`, so the transaction is the caller's. A
 * scan is one reading of one store and half of it committed is a tree that
 * agrees with no scan that ever happened -- and the sweep that follows it in
 * `catalogue.ts` is the other half of the same reading, so the batch that has
 * to commit whole is larger than this function can see. `catalogue.ts` opens
 * the one transaction both of them run in.
 */
export async function discoverNodes(
  database: Queryable,
  ids: IdGenerator,
  clock: Clock,
  sessions: readonly DiscoveredSession[],
  placements: SessionPlacements = new Map(),
): Promise<DiscoveryOutcome> {
  const created: TreeNode[] = [];
  const retitled: TreeNode[] = [];
  const suppressed: SessionRef[] = [];

  for (const session of sessions) {
    const existing = await findNodeForSession(database, session.ref);

    if (existing !== null) {
      // The node is here, so its placement is settled -- by the user if they
      // moved it, by the creation below if they did not, and either way not
      // by this scan. The only column discovery may still write is the name,
      // and only while the name is still following the title.
      const followed = await followTitle(database, existing, session.title);
      if (followed !== null) retitled.push(followed);
      continue;
    }

    const placed = await placeSession(
      database,
      ids,
      clock,
      session,
      placements.get(session.ref.sessionId) ?? null,
    );
    if (placed === null) suppressed.push(session.ref);
    else created.push(placed);
  }

  return { created, retitled, suppressed };
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
 * Where a new node goes, by the session it anchors: the project whose directory
 * that session ran in, or absent for the root.
 *
 * Keyed by session id and not by ref, because a pass is one store's reading and
 * a session id is unique within its store -- the same narrowing `bringInLine`
 * already makes when it files a descriptor under the store that was read.
 *
 * Resolved by the caller rather than looked up here, because the lookup is the
 * projects feature's and this function is inside somebody else's transaction.
 */
export type SessionPlacements = ReadonlyMap<SessionRef['sessionId'], NodeId>;

/**
 * Places one session, unless its removal is remembered.
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
 * `parent` is the project this session belongs in, or `null` for the root. It
 * is bound into both halves of the statement -- the row being written and the
 * siblings whose last position is being read -- so a project's first session
 * goes to position 0 inside it rather than after everything at the root. `IS`
 * rather than `=`, because the root's children have a NULL parent and
 * `= NULL` is never true.
 *
 * `null` means the insert wrote nothing, which here has exactly one cause.
 */
async function placeSession(
  database: Queryable,
  ids: IdGenerator,
  clock: Clock,
  session: DiscoveredSession,
  parent: NodeId | null,
): Promise<TreeNode | null> {
  const result = await database.query(
    `INSERT INTO nodes
       (id, parent_id, kind, position, name, name_source, anchor_store_id, anchor_session_id, created_at)
     SELECT ?, ?, ?, coalesce(max(position), -1) + 1, ?, 'discovered', ?, ?, ?
       FROM nodes WHERE parent_id IS ?
     HAVING NOT EXISTS (
        SELECT 1 FROM node_removals WHERE store_id = ? AND session_id = ?
      )`,
    [
      ids.newId(),
      parent,
      SESSION_KIND,
      session.title,
      session.ref.storeId,
      session.ref.sessionId,
      clock.now(),
      parent,
      session.ref.storeId,
      session.ref.sessionId,
    ],
  );
  if (result.rowCount === 0) return null;
  return findNodeForSession(database, session.ref);
}
