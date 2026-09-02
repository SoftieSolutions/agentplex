import { z } from 'zod';
import { frameIdSchema, refusalCodeSchema } from './frames.js';
import { hubIdSchema } from './identity.js';
import { frameParser } from './parse.js';

/**
 * The client-facing half of the protocol: browser (or MCP caller) to hub.
 *
 * v0 carries only what milestone 1 can honestly demonstrate — a versioned
 * greeting and a liveness check. Session, layout and terminal frames arrive
 * with the milestones that implement them.
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
   * A refusal is a reply to the client that asked, never a broadcast: the other
   * clients did not ask and their view of the world has not changed.
   */
  z.object({
    type: z.literal('refusal'),
    replyTo: frameIdSchema,
    code: refusalCodeSchema,
    message: z.string(),
  }),
]);
export type HubFrame = z.infer<typeof hubFrameSchema>;

/** The one parser for everything the hub reads from a client. */
export const parseClientFrame = frameParser(clientFrameSchema);

/** The one parser for everything a client reads from the hub. */
export const parseHubFrame = frameParser(hubFrameSchema);
