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

/**
 * How long a name a client may put on a node.
 *
 * A bound and not a judgement, which is the whole of why this schema is not the
 * one the hub stores through. `paneLayoutTextSchema` above it makes the same
 * split for the same reason: what the protocol states about a name is that it
 * is text and that it is not a novel, so that an unbounded column filled by a
 * bug has something to object to. Whether a particular name is *usable* -- a
 * name of nothing but spaces is not -- is a judgement, and a judgement belongs
 * where it can be answered in a sentence.
 *
 * The difference is what happens to a client that sends a blank name. A schema
 * that refused one would refuse the *frame*, and an unparseable frame is a
 * `protocol-error` and a closed socket: the hub cannot reply to a frame whose
 * id it could not read. "You left the name blank" is a thing to say to a
 * person, not to hang up over, so it is a `refusal` the hub writes and the
 * form renders, and this schema lets the frame through to be refused.
 */
export const NODE_NAME_MAX_CHARS = 200;
export const nodeNameTextSchema = z.string().max(NODE_NAME_MAX_CHARS);
