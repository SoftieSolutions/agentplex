import { z } from 'zod';
import {
  NODE_NAME_MAX_CHARS,
  nodeIdSchema,
  nodeKindSchema,
  sessionIdSchema,
  storeIdSchema,
  type NodeKind,
} from '@agentplex/protocol';

/**
 * The node tree, as rows: the parsers every read and write in this folder
 * shares, and the two kinds the migration seeded.
 *
 * The tree is the user's arrangement of their own screen: what is in it, where,
 * and what it is called. Disk owns what a session *is*; this owns where the user
 * put it. Two consequences run through every function here.
 *
 * The first is that a node's anchor is a pointer nothing can enforce. The hub
 * persists no sessions, so `{ storeId, sessionId }` on a node names something
 * only a server's next scan can confirm. There is no foreign key to add and
 * adding one would mean a sessions table, which the reducer explains at length
 * why the hub must not have. `prune.ts` is the other half of that decision.
 *
 * The second is who may write what. Discovery creates a node and then follows
 * its transcript title; the user moves it and renames it. Those two writers
 * meet on one row, and the rule is that the user wins and keeps winning: a
 * rename is permanent, and discovery writes placement exactly once, at creation.
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
export const nodeKindRowSchema = z
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

export const nodeRowSchema = z
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

export const COLUMNS =
  'id, parent_id, kind, position, name, name_source, anchor_store_id, anchor_session_id, created_at';

/** The kind a discovered session gets. Seeded by migration 0004, not by this. */
export const SESSION_KIND: NodeKind = nodeKindSchema.parse('session');
/** The kind the user's containers get. */
export const FOLDER_KIND: NodeKind = nodeKindSchema.parse('folder');
/**
 * The kind a project node gets. Seeded by migration 0006, not by this.
 *
 * Named here because one rule about the tree's shape is about projects and
 * could not be about anything else: a project may not sit inside another. A
 * session is filed under the project whose directory its `cwd` is, and "the
 * project" has to be a definite article -- nested projects would make a
 * placement a choice between two right answers. The projects feature owns what
 * a project *is*; what this folder owns is where one may go.
 */
export const PROJECT_KIND: NodeKind = nodeKindSchema.parse('project');

/**
 * What a node may be called. Trimmed, because a name of spaces is not a name.
 *
 * The bound is the protocol's, so that the wire and the column agree about how
 * long a name may be; the trim and the minimum are this side's, because they
 * are a judgement and a frame's parser refusing one would be a closed socket
 * rather than a sentence. `layout.ts` in the protocol carries that argument.
 */
export const nodeNameSchema = z.string().trim().min(1).max(NODE_NAME_MAX_CHARS);

export const removalRowSchema = z
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
