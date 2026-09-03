import { z } from 'zod';
import { nodeIdSchema, nodeKindSchema, sessionRefSchema } from './identity.js';

/**
 * The user's arrangement of their own screen, as a client reads it.
 *
 * Published flat rather than nested, and the reason is the same one that keeps
 * `machine-state` flat: a nested tree can contradict itself. Depth in JSON is a
 * second encoding of the parent relation, so a frame could carry a node in one
 * branch whose `parentId` names another, and nothing could say which half was
 * right. A flat list with `parentId` on each row has one encoding of the
 * relation, and a client builds the tree from it.
 *
 * Unlike `machine-state`, this is a reply and goes to the client that asked. A
 * layout is one person's arrangement, and broadcasting it would rearrange
 * everybody's.
 */

/** One node, whole. Nothing here is assembled from two rows. */
export const layoutNodeSchema = z.object({
  id: nodeIdSchema,
  /** `null` is the root, which is not a node: see migration 0004 for why. */
  parentId: nodeIdSchema.nullable(),
  kind: nodeKindSchema,
  /** Order among siblings. Ties break on `id`, so the order is total. */
  position: z.int().nonnegative(),
  /**
   * What the tree calls it, or `null` when nothing has named it — a discovered
   * session whose provider gave its transcript no title. `null` rather than a
   * placeholder minted hub-side: a client showing the session's own id is
   * showing something true, and a hub inventing "Untitled session" would be
   * inventing a name the user could then not tell from one they chose.
   */
  name: z.string().min(1).nullable(),
  /**
   * Whether that name came from the user. A client shows a follow-the-title
   * name and a chosen one differently, and it cannot tell them apart from the
   * text alone.
   */
  named: z.boolean(),
  /**
   * The session this node points at, or `null` for a node that points at
   * nothing, such as a folder.
   *
   * A pointer and not a join: the hub persists no sessions, so this names a
   * session that only a server's next scan can confirm still exists. A client
   * that finds no session for it in `machine-state` is looking at a node whose
   * session is unreachable or gone, which is a thing to label rather than a
   * frame to distrust.
   */
  anchor: sessionRefSchema.nullable(),
});
export type LayoutNode = z.infer<typeof layoutNodeSchema>;

/**
 * Every node, parents before children and siblings in order.
 *
 * The order is part of the answer rather than something a client re-derives:
 * the hub already sorts to read the rows, and two clients sorting a set by
 * their own rules is how two screens come to disagree about one tree.
 */
export const layoutSchema = z.array(layoutNodeSchema);
export type Layout = z.infer<typeof layoutSchema>;
