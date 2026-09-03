import { z } from 'zod';
import {
  nodeIdSchema,
  nodeKindSchema,
  sessionIdSchema,
  storeIdSchema,
  type Layout,
  type NodeId,
  type NodeKind,
  type SessionRef,
} from '@agentplex/protocol';
import type { Database, Queryable } from '../db/database.js';
import type { Clock } from '../../shared/clock.js';
import type { IdGenerator } from '../../shared/ids.js';

/**
 * The node tree, as rows.
 *
 * The tree is the user's arrangement of their own screen: what is in it, where,
 * and what it is called. Disk owns what a session *is*; this owns where the user
 * put it. Two consequences run through every function here.
 *
 * The first is that a node's anchor is a pointer nothing can enforce. The hub
 * persists no sessions, so `{ storeId, sessionId }` on a node names something
 * only a server's next scan can confirm. There is no foreign key to add and
 * adding one would mean a sessions table, which the reducer explains at length
 * why the hub must not have. `node-prune.ts` is the other half of that decision.
 *
 * The second is who may write what. Discovery creates a node and then follows
 * its transcript title; the user moves it and renames it. Those two writers
 * meet on one row, and the rule is that the user wins and keeps winning: a
 * rename is permanent, and discovery writes placement exactly once, at creation.
 *
 * Everything that is one statement takes a `Queryable`, so a caller can put
 * several in one transaction. Everything that is several statements takes a
 * `Database` and opens the transaction itself, because the intermediate states
 * -- a node deleted but its removal not yet remembered, siblings half
 * renumbered -- are states nothing else knows how to read.
 */

/** Epoch milliseconds in the column and on the clock; parsed, not assumed. */
const timestampSchema = z.number().int();

/**
 * SQLite has no boolean, the driver binds `true` as 1, and this is where a 1
 * read back out of a column becomes a boolean again. Only the column knows
 * which integers meant flags, so the conversion is written per column here
 * rather than guessed by the driver.
 */
const flagSchema = z.union([z.literal(0), z.literal(1)]).transform((value) => value === 1);

/**
 * What a kind is allowed to be, read back from the lookup table.
 *
 * The data layer enforces what SQL cannot: a CHECK constraint cannot consult
 * another table's row, so "a folder may hold children and a session may not" is
 * stated by `node_kinds` and applied by the functions below.
 */
const nodeKindRowSchema = z
  .object({
    kind: nodeKindSchema,
    container: flagSchema,
    anchors_session: flagSchema,
  })
  .transform((row) => ({
    kind: row.kind,
    /** Whether this kind may hold children. */
    container: row.container,
    /** Whether a node of this kind must name a session. */
    anchorsSession: row.anchors_session,
  }));
export type NodeKindRow = z.infer<typeof nodeKindRowSchema>;

/**
 * The name and where it came from, as one parsed fact.
 *
 * `named` rather than the column's word, because the only question anything
 * asks is whether the user chose it: discovery asks so it knows to stop
 * writing, and a client asks so it can show a chosen name differently from one
 * that is following a title.
 */
const nameSourceSchema = z.enum(['discovered', 'user']);

const nodeRowSchema = z
  .object({
    id: nodeIdSchema,
    parent_id: nodeIdSchema.nullable(),
    kind: nodeKindSchema,
    position: z.number().int(),
    name: z.string().min(1).nullable(),
    name_source: nameSourceSchema,
    anchor_store_id: storeIdSchema.nullable(),
    anchor_session_id: sessionIdSchema.nullable(),
    created_at: timestampSchema,
  })
  .transform((row) => ({
    id: row.id,
    parentId: row.parent_id,
    kind: row.kind,
    position: row.position,
    name: row.name,
    named: row.name_source === 'user',
    /**
     * Both halves or neither. The `nodes_anchor_is_whole` constraint is the
     * other side of this: a half anchor cannot be written, and if one appeared
     * anyway this parser refuses the row rather than handing back a session
     * reference with a hole in it.
     */
    anchor:
      row.anchor_store_id === null || row.anchor_session_id === null
        ? null
        : { storeId: row.anchor_store_id, sessionId: row.anchor_session_id },
    createdAt: row.created_at,
  }));

/** One node, parsed. A superset of what goes on the wire: `createdAt` stays here. */
export type TreeNode = z.infer<typeof nodeRowSchema>;

const COLUMNS =
  'id, parent_id, kind, position, name, name_source, anchor_store_id, anchor_session_id, created_at';

/** The kind a discovered session gets. Seeded by migration 0004, not by this. */
export const SESSION_KIND: NodeKind = nodeKindSchema.parse('session');
/** The kind the user's containers get. */
export const FOLDER_KIND: NodeKind = nodeKindSchema.parse('folder');

/** What a node may be called. Trimmed, because a name of spaces is not a name. */
export const nodeNameSchema = z.string().trim().min(1).max(200);

/**
 * Every kind this database knows about.
 *
 * The list is data, which is the ticket: a build meeting a database with a kind
 * it has never heard of reads it here rather than failing to parse an enum.
 */
export async function listNodeKinds(database: Queryable): Promise<readonly NodeKindRow[]> {
  const result = await database.query(
    'SELECT kind, container, anchors_session FROM node_kinds ORDER BY kind',
  );
  return result.rows.map((row) => nodeKindRowSchema.parse(row));
}

/** One kind, or `null` when this database has no such row. */
export async function findNodeKind(
  database: Queryable,
  kind: NodeKind,
): Promise<NodeKindRow | null> {
  const result = await database.query(
    'SELECT kind, container, anchors_session FROM node_kinds WHERE kind = ?',
    [kind],
  );
  const row = result.rows[0];
  return row === undefined ? null : nodeKindRowSchema.parse(row);
}

/**
 * Every node, in no particular order.
 *
 * The tree order is applied by `orderDepthFirst` rather than by the database:
 * a depth-first order is a recursive CTE with a lexicographically sortable path
 * built out of `printf`-padded positions, and the padding width is a silent
 * upper bound on how many siblings a folder may have before the order goes
 * wrong. One user's tree is small; sorting it where a test can read the rule is
 * worth more than sorting it in SQL.
 */
export async function listNodes(database: Queryable): Promise<readonly TreeNode[]> {
  const result = await database.query(`SELECT ${COLUMNS} FROM nodes ORDER BY position, id`);
  return result.rows.map((row) => nodeRowSchema.parse(row));
}

/** One node by id, or `null`. */
export async function findNode(database: Queryable, id: NodeId): Promise<TreeNode | null> {
  const result = await database.query(`SELECT ${COLUMNS} FROM nodes WHERE id = ?`, [id]);
  const row = result.rows[0];
  return row === undefined ? null : nodeRowSchema.parse(row);
}

/** The node pointing at one session, or `null` when nothing does. */
export async function findNodeForSession(
  database: Queryable,
  ref: SessionRef,
): Promise<TreeNode | null> {
  const result = await database.query(
    `SELECT ${COLUMNS} FROM nodes WHERE anchor_store_id = ? AND anchor_session_id = ?`,
    [ref.storeId, ref.sessionId],
  );
  const row = result.rows[0];
  return row === undefined ? null : nodeRowSchema.parse(row);
}

/**
 * Parents before children, siblings in order, and nothing dropped.
 *
 * Reachability from the root is what a tree means, and this walks from there.
 * A node that the walk never reaches has an ancestry that does not terminate at
 * the root, which nothing in this module can write: `moveNode` refuses a cycle
 * and the foreign key refuses a missing parent. If one appears anyway it is
 * appended rather than discarded -- an unreadable item in a listing costs
 * itself, not the listing, and a tree that silently lost a subtree is a bug
 * nobody can see.
 */
export function orderDepthFirst(nodes: readonly TreeNode[]): readonly TreeNode[] {
  const children = new Map<NodeId | null, TreeNode[]>();
  for (const node of nodes) {
    const siblings = children.get(node.parentId);
    if (siblings === undefined) children.set(node.parentId, [node]);
    else siblings.push(node);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => left.position - right.position || compare(left.id, right.id));
  }

  const ordered: TreeNode[] = [];
  const seen = new Set<NodeId>();
  const visit = (parentId: NodeId | null): void => {
    for (const node of children.get(parentId) ?? []) {
      // A cycle cannot be written through this module; if one exists anyway,
      // this is what stops the walk rather than recursing forever.
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      ordered.push(node);
      visit(node.id);
    }
  };
  visit(null);

  const unreachable = nodes.filter((node) => !seen.has(node.id));
  unreachable.sort((left, right) => compare(left.id, right.id));
  return [...ordered, ...unreachable];
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The tree as a client reads it: ordered, with what only the hub needs dropped. */
export async function readLayout(database: Queryable): Promise<Layout> {
  return orderDepthFirst(await listNodes(database)).map((node) => ({
    id: node.id,
    parentId: node.parentId,
    kind: node.kind,
    position: node.position,
    name: node.name,
    named: node.named,
    anchor: node.anchor,
  }));
}

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

async function listChildren(
  database: Queryable,
  parentId: NodeId | null,
): Promise<readonly TreeNode[]> {
  const result = await database.query(
    `SELECT ${COLUMNS} FROM nodes WHERE parent_id IS ? ORDER BY position, id`,
    [parentId],
  );
  return result.rows.map((row) => nodeRowSchema.parse(row));
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
 */
async function wouldCycle(
  database: Queryable,
  id: NodeId,
  parentId: NodeId | null,
): Promise<boolean> {
  let walking = parentId;
  const seen = new Set<NodeId>();
  while (walking !== null) {
    if (walking === id) return true;
    // Only reachable if a ring already exists; stops rather than spins.
    if (seen.has(walking)) return true;
    seen.add(walking);
    const ancestor: TreeNode | null = await findNode(database, walking);
    if (ancestor === null) return false;
    walking = ancestor.parentId;
  }
  return false;
}

const removalRowSchema = z
  .object({
    store_id: storeIdSchema,
    session_id: sessionIdSchema,
    removed_at: timestampSchema,
  })
  .transform((row) => ({
    ref: { storeId: row.store_id, sessionId: row.session_id },
    removedAt: row.removed_at,
  }));
export type RememberedRemoval = z.infer<typeof removalRowSchema>;

/** Every removal this hub remembers, oldest first. */
export async function listRemovals(database: Queryable): Promise<readonly RememberedRemoval[]> {
  const result = await database.query(
    'SELECT store_id, session_id, removed_at FROM node_removals ORDER BY removed_at, store_id, session_id',
  );
  return result.rows.map((row) => removalRowSchema.parse(row));
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
  const anchors: SessionRef[] = [];
  if (node.anchor !== null) anchors.push(node.anchor);

  // Breadth-first over the rows rather than a recursive CTE: the walk is the
  // same either way and this one is readable from the test that exercises it.
  let frontier: readonly NodeId[] = [node.id];
  const seen = new Set<NodeId>([node.id]);
  while (frontier.length > 0) {
    const next: NodeId[] = [];
    for (const parentId of frontier) {
      for (const child of await listChildren(database, parentId)) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        if (child.anchor !== null) anchors.push(child.anchor);
        next.push(child.id);
      }
    }
    frontier = next;
  }
  return anchors;
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
