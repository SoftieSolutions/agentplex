import { z } from 'zod';
import type { NodeId, SessionRef } from '@agentplex/protocol';
import type { Clock, IdGenerator } from '@agentplex/node-shared';
import type { Database, Queryable } from '../../db/database.js';
import { findNode, findNodeKind, listAncestry, listChildren, listSubtree } from './reads.js';
import { COLUMNS, FOLDER_KIND, nodeNameSchema, nodeRowSchema, type TreeNode } from './rows.js';

/**
 * The node tree, written by the user.
 *
 * Everything that is several statements takes a `Database` and opens the
 * transaction itself, because the intermediate states -- a node deleted but
 * its removal not yet remembered, siblings half renumbered -- are states
 * nothing else knows how to read. Discovery's one write is in `discovery.ts`;
 * the rule that the user wins and keeps winning is argued in `rows.ts`.
 */

/**
 * Where a new sibling goes: after every sibling there is.
 *
 * `IS` rather than `=`, because the root's children have a NULL parent and
 * `= NULL` is never true. A `=` here would have counted the root's siblings as
 * none every time and stacked every discovered session at position 0.
 */
async function nextPosition(database: Queryable, parentId: NodeId | null): Promise<number> {
  const result = await database.query<{ next: number }>(
    'SELECT coalesce(max(position), -1) + 1 AS next FROM nodes WHERE parent_id IS ?',
    [parentId],
  );
  return z.number().int().parse(result.rows[0]?.next);
}

/**
 * Whether a node may hold children, refusing what SQL cannot.
 *
 * `null` is the root, which always may. A parent that does not exist and a
 * parent of a kind that holds nothing are two different errors, and both are
 * thrown rather than returned: a caller asking to put a folder inside a session
 * has a bug, not a situation.
 */
async function requireContainer(database: Queryable, parentId: NodeId | null): Promise<void> {
  if (parentId === null) return;
  const parent = await findNode(database, parentId);
  if (parent === null) throw new Error(`no node ${JSON.stringify(parentId)} to put this under`);
  const kind = await findNodeKind(database, parent.kind);
  if (kind === null || !kind.container) {
    throw new Error(`a ${String(parent.kind)} node cannot hold children`);
  }
}

export interface NewFolder {
  readonly parentId: NodeId | null;
  readonly name: string;
}

/**
 * Creates a folder the user asked for.
 *
 * `name_source` is `user` from the first millisecond: nobody discovered this
 * and nothing may rename it. Two statements -- the parent check and the insert
 * -- so it takes a `Database` and commits them together.
 */
export async function createFolder(
  database: Database,
  ids: IdGenerator,
  clock: Clock,
  folder: NewFolder,
): Promise<TreeNode> {
  const name = nodeNameSchema.parse(folder.name);
  return database.transaction(async (tx) => {
    await requireContainer(tx, folder.parentId);
    const result = await tx.query(
      `INSERT INTO nodes (id, parent_id, kind, position, name, name_source, created_at)
       VALUES (?, ?, ?, ?, ?, 'user', ?) RETURNING ${COLUMNS}`,
      [
        ids.newId(),
        folder.parentId,
        FOLDER_KIND,
        await nextPosition(tx, folder.parentId),
        name,
        clock.now(),
      ],
    );
    return nodeRowSchema.parse(result.rows[0]);
  });
}

/**
 * The user names a node, and that is the end of discovery's claim on the name.
 *
 * Permanent by design. A rename that lapsed the next time a provider retitled a
 * transcript would be an edit the user watched get undone, which is the same
 * failure as a removal that discovery writes back.
 *
 * `null` when there is no such node.
 */
export async function renameNode(
  database: Queryable,
  id: NodeId,
  name: string,
): Promise<TreeNode | null> {
  const parsed = nodeNameSchema.parse(name);
  const result = await database.query(
    `UPDATE nodes SET name = ?, name_source = 'user' WHERE id = ? RETURNING ${COLUMNS}`,
    [parsed, id],
  );
  const row = result.rows[0];
  return row === undefined ? null : nodeRowSchema.parse(row);
}

export interface NodePlacement {
  readonly parentId: NodeId | null;
  /**
   * Where among the new siblings, or omitted for last.
   *
   * Clamped rather than refused: a client that computed an index against a tree
   * that has since changed has asked for something reasonable, and refusing it
   * would make a stale-by-one-frame client unable to move anything.
   */
  readonly position?: number;
}

/**
 * The user moves a node, and that placement is theirs from then on.
 *
 * Discovery never writes `parent_id` again after creating a node, so there is
 * no flag here saying the user touched it: the protection is that nothing else
 * writes placement at all.
 *
 * Several statements -- the checks, the insert of this node among its new
 * siblings, and the renumbering of both parents -- so the whole move is one
 * transaction. A move seen half-applied is a node in two places or in none.
 */
export async function moveNode(
  database: Database,
  id: NodeId,
  placement: NodePlacement,
): Promise<TreeNode | null> {
  return database.transaction(async (tx) => {
    const node = await findNode(tx, id);
    if (node === null) return null;
    await requireContainer(tx, placement.parentId);
    if (await wouldCycle(tx, id, placement.parentId)) {
      throw new Error('a node cannot be moved inside itself');
    }

    const from = node.parentId;
    // Taken out of its old parent first, so that the renumbering below sees the
    // siblings it will actually have rather than counting this node twice.
    const siblings = (await listChildren(tx, placement.parentId)).filter(
      (sibling) => sibling.id !== id,
    );
    const index = Math.max(0, Math.min(placement.position ?? siblings.length, siblings.length));
    const ordered = [...siblings.slice(0, index), node, ...siblings.slice(index)];

    // Dense ordinals, rewritten wholesale. There is no unique index on
    // (parent_id, position) to collide with mid-statement -- migration 0004
    // says why -- so this can simply say what the new order is.
    for (const [position, sibling] of ordered.entries()) {
      await tx.query('UPDATE nodes SET parent_id = ?, position = ? WHERE id = ?', [
        placement.parentId,
        position,
        sibling.id,
      ]);
    }
    if (from !== placement.parentId) await renumber(tx, from);

    return await findNode(tx, id);
  });
}

/** Closes the gaps a departure left, so positions stay dense. */
async function renumber(database: Queryable, parentId: NodeId | null): Promise<void> {
  const children = await listChildren(database, parentId);
  for (const [position, child] of children.entries()) {
    if (child.position === position) continue;
    await database.query('UPDATE nodes SET position = ? WHERE id = ?', [position, child.id]);
  }
}

/**
 * Whether a move would put a node inside its own subtree.
 *
 * The foreign key cannot see this: `a.parent = b` and `b.parent = a` are two
 * individually valid rows and together a ring that is part of no tree and that
 * a depth-first walk from the root would never reach.
 *
 * Exported because the refusal a client is answered with is decided in
 * `mutations.ts`, one layer up: a cycle reaches this file as a throw, which is
 * the right answer to a caller with a bug and the wrong one to a person who
 * dragged a folder onto its own child.
 */
export async function wouldCycle(
  database: Queryable,
  id: NodeId,
  parentId: NodeId | null,
): Promise<boolean> {
  return (await listAncestry(database, parentId)).some((ancestor) => ancestor.id === id);
}

export interface RemovedNode {
  /** The node that was removed, as it was. `null` when there was no such node. */
  readonly node: TreeNode | null;
  /**
   * Every session the hub will now decline to place, this node's and its
   * descendants'.
   *
   * A folder holding sessions is the case that makes this a list. Removing it
   * without remembering what was inside would delete the children by cascade
   * and have discovery put every one of them back at the root a few seconds
   * later -- the user's edit undone, plus their folder gone.
   */
  readonly remembered: readonly SessionRef[];
}

/**
 * Removes a node and remembers what discovery would otherwise put back.
 *
 * Either the removal is remembered or discovery restores the node, and there is
 * no third state. This is where that is made true: the delete and the remembering
 * commit together, so there is no instant at which the node is gone and the hub
 * has forgotten why.
 *
 * A folder is remembered by its contents rather than by itself, because
 * discovery cannot re-create a folder -- nothing on disk describes one. What it
 * can re-create is every session that was inside.
 */
export async function removeNode(
  database: Database,
  clock: Clock,
  id: NodeId,
): Promise<RemovedNode> {
  return database.transaction(async (tx) => {
    const node = await findNode(tx, id);
    if (node === null) return { node: null, remembered: [] };

    const anchors = await anchorsInSubtree(tx, node);

    // The delete cascades to the subtree; the remembering has to happen while
    // the rows are still there to read, which is why the anchors are collected
    // above rather than after.
    await tx.query('DELETE FROM nodes WHERE id = ?', [id]);

    const now = clock.now();
    for (const ref of anchors) {
      await tx.query(
        `INSERT INTO node_removals (store_id, session_id, removed_at)
         VALUES (?, ?, ?)
         ON CONFLICT (store_id, session_id) DO UPDATE SET removed_at = excluded.removed_at`,
        [ref.storeId, ref.sessionId, now],
      );
    }

    return { node, remembered: anchors };
  });
}

/** Every session anchored at or under one node, the node itself included. */
async function anchorsInSubtree(
  database: Queryable,
  node: TreeNode,
): Promise<readonly SessionRef[]> {
  const subtree = await listSubtree(database, node);
  return subtree.flatMap((member) => (member.anchor === null ? [] : [member.anchor]));
}

/**
 * Forgets a removal, so discovery may place that session again.
 *
 * The inverse of remembering, and the data layer would be incomplete without
 * it: a removal that could never be undone would make "remove" mean "never show
 * me this session again on this hub, forever", which is not what removing
 * something from a tree means anywhere else.
 *
 * Answers whether there was a removal to forget.
 */
export async function forgetRemoval(database: Queryable, ref: SessionRef): Promise<boolean> {
  const result = await database.query(
    'DELETE FROM node_removals WHERE store_id = ? AND session_id = ?',
    [ref.storeId, ref.sessionId],
  );
  return result.rowCount > 0;
}
