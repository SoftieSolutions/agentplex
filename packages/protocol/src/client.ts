import { z } from 'zod';
import { frameIdSchema, protocolErrorFrameSchema, refusalCodeSchema } from './frames.js';
import { hubIdSchema } from './identity.js';
import { machineStateSchema } from './machine-state.js';
import { frameParser } from './parse.js';

/**
 * The client-facing half of the protocol: browser (or MCP caller) to hub.
 *
 * Two kinds of frame travel from the hub, and the difference is the whole
 * design of this direction:
 *
 *   * `machine-state` is unsolicited and goes to every client, whole. It has no
 *     `replyTo` because nobody asked for it, and no delta form because two
 *     clients holding different subsets of an edit stream disagree.
 *   * everything else is a reply, carrying the id of the frame it answers, and
 *     goes to the one client that asked. A refusal in particular is never
 *     broadcast: the other clients did not ask, and nothing about the world
 *     changed because one of them was told no.
 *
 * Terminal frames arrive with the milestone that implements them.
 */

export const clientFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    id: frameIdSchema,
    protocolVersion: z.int(),
  }),
  z.object({
    type: z.literal('ping'),
    id: frameIdSchema,
  }),
  /**
   * Asks for the layout this hub has stored for the user.
   *
   * It carries nothing but its id: there is one stored layout and the asking is
   * the whole request. The answer is a reply to the asking client and to nobody
   * else -- a layout is one person's arrangement of their own screen, and
   * broadcasting it would rearrange everybody's.
   *
   * The hub refuses this today, because nothing stores a layout yet: the node
   * tree the layout is a view of is AGX-28's, and inventing a payload shape
   * here would commit the wire to a schema written by something that has not
   * been designed. The request exists now so that the routing it needs is built
   * and tested rather than asserted; AGX-28 adds the answer frame beside it.
   */
  z.object({
    type: z.literal('layout-request'),
    id: frameIdSchema,
  }),
  /** A client reads hub frames too, and can meet one it cannot parse. */
  protocolErrorFrameSchema,
]);
export type ClientFrame = z.infer<typeof clientFrameSchema>;

export const hubFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('welcome'),
    replyTo: frameIdSchema,
    protocolVersion: z.int(),
    hubId: hubIdSchema,
  }),
  z.object({
    type: z.literal('pong'),
    replyTo: frameIdSchema,
  }),
  /**
   * The whole of what the hub believes, sent to every client on every change.
   *
   * No `replyTo`, because it is nobody's reply: a client is sent one the moment
   * it is established and one after every change thereafter, whether or not it
   * ever asks for anything. No delta form, ever -- see `machine-state.ts` for
   * why the state is a snapshot rather than a stream of edits.
   *
   * Nested under `state` rather than spread across the frame so that the
   * envelope and the state stay separable: the hub encodes one state once and
   * hands the same bytes to every socket, which is the strongest available form
   * of "two clients cannot disagree".
   */
  z.object({
    type: z.literal('machine-state'),
    state: machineStateSchema,
  }),
  /**
   * A refusal is a reply to the client that asked, never a broadcast: the other
   * clients did not ask and their view of the world has not changed. Which is
   * why it cannot carry a frame that failed to parse — see `protocol-error`.
   */
  z.object({
    type: z.literal('refusal'),
    replyTo: frameIdSchema,
    code: refusalCodeSchema,
    message: z.string(),
  }),
  protocolErrorFrameSchema,
]);
export type HubFrame = z.infer<typeof hubFrameSchema>;

/** The one parser for everything the hub reads from a client. */
export const parseClientFrame = frameParser(clientFrameSchema);

/** The one parser for everything a client reads from the hub. */
export const parseHubFrame = frameParser(hubFrameSchema);
