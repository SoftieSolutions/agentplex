import { type Layout, type NodeId, type NodeKind, type SessionRef } from '@agentplex/protocol';
import type { Queryable } from '../../db/database.js';
import {
  COLUMNS,
  nodeKindRowSchema,
  nodeRowSchema,
  PROJECT_KIND,
  removalRowSchema,
  type NodeKindRow,
  type RememberedRemoval,
  type TreeNode,
} from './rows.js';

/**
 * The node tree, read.
 *
 * Everything here is one statement and takes a `Queryable`, so a caller can put
 * several in one transaction. `rows.ts` says what a row is; `writes.ts` is the
 * other half.
 */

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
 * The project one session is filed under, or `null` for one filed nowhere.
 *
 * The nearest project above the session's node, and not the node's parent. The
 * difference is somebody tidying a session into a folder inside a project,
 * which the tree allows and which a lookup that only read the parent would
 * answer `null` for -- and the first caller of this is the standing policy, so
 * that answer would quietly leave every tidied session with no policy at all.
 *
 * `null` for a session with no node as well, which is the ordinary case for one
 * discovered since the last time the tree was brought into line. It has no
 * placement yet, so nothing has been decided about it, so it is asked about.
 *
 * The walk is `listAncestry`'s, which stops on a ring rather than spinning.
 */
export async function findProjectFor(database: Queryable, ref: SessionRef): Promise<NodeId | null> {
  const node = await findNodeForSession(database, ref);
  if (node === null) return null;
  for (const above of await listAncestry(database, node.parentId)) {
    if (above.kind === PROJECT_KIND) return above.id;
  }
  return null;
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

export async function listChildren(
  database: Queryable,
  parentId: NodeId | null,
): Promise<readonly TreeNode[]> {
  const result = await database.query(
    `SELECT ${COLUMNS} FROM nodes WHERE parent_id IS ? ORDER BY position, id`,
    [parentId],
  );
  return result.rows.map((row) => nodeRowSchema.parse(row));
}

/**
 * The node at `from` and every node above it, nearest first.
 *
 * `from` is a parent id rather than a node's own id, because both callers ask
 * about a place rather than about a node: a move asks what is above where it
 * is going, and `null` -- the root -- is above everything and is not a node.
 *
 * Stops on a ring rather than spinning. Nothing in this module can write one
 * (a move refuses a cycle and the foreign key refuses a missing parent), and a
 * walk that would hang if one existed anyway is a walk that turns a bad row
 * into a hung request.
 */
export async function listAncestry(
  database: Queryable,
  from: NodeId | null,
): Promise<readonly TreeNode[]> {
  const chain: TreeNode[] = [];
  const seen = new Set<NodeId>();
  let walking = from;
  while (walking !== null) {
    if (seen.has(walking)) return chain;
    seen.add(walking);
    const node: TreeNode | null = await findNode(database, walking);
    if (node === null) return chain;
    chain.push(node);
    walking = node.parentId;
  }
  return chain;
}

/**
 * One node and everything under it, the node first and then breadth-first.
 *
 * Rows rather than a recursive CTE, for the reason `orderDepthFirst` sorts in
 * TypeScript: one user's tree is small, and a walk a test can read is worth
 * more than a walk the database does. Every caller is about the subtree as a
 * whole -- what a removal must remember, what a move would carry with it --
 * and both of those are questions that must not miss a descendant.
 */
export async function listSubtree(
  database: Queryable,
  node: TreeNode,
): Promise<readonly TreeNode[]> {
  const subtree: TreeNode[] = [node];
  const seen = new Set<NodeId>([node.id]);
  let frontier: readonly NodeId[] = [node.id];
  while (frontier.length > 0) {
    const next: NodeId[] = [];
    for (const parentId of frontier) {
      for (const child of await listChildren(database, parentId)) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        subtree.push(child);
        next.push(child.id);
      }
    }
    frontier = next;
  }
  return subtree;
}

/** Every removal this hub remembers, oldest first. */
export async function listRemovals(database: Queryable): Promise<readonly RememberedRemoval[]> {
  const result = await database.query(
    'SELECT store_id, session_id, removed_at FROM node_removals ORDER BY removed_at, store_id, session_id',
  );
  return result.rows.map((row) => removalRowSchema.parse(row));
}
