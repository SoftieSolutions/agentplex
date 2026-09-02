import { z } from 'zod';
import { frameIdSchema } from './frames.js';
import { serverIdSchema, storeDescriptorSchema } from './identity.js';
import { frameParser } from './parse.js';

/**
 * The server-facing half of the protocol: hub to paired server.
 *
 * The hub dials; a server dials out to nothing. So the handshake is the hub
 * presenting that server's token, and the server answering with who it is,
 * which protocol it speaks, and what it has mounted.
 */

export const hubToServerFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('handshake'),
    id: frameIdSchema,
    protocolVersion: z.int(),
    /** The token the user typed into the hub for this server, and only this one. */
    token: z.string().min(1),
  }),
  z.object({
    type: z.literal('ping'),
    id: frameIdSchema,
  }),
]);
export type HubToServerFrame = z.infer<typeof hubToServerFrameSchema>;

export const serverToHubFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('handshake-accepted'),
    replyTo: frameIdSchema,
    protocolVersion: z.int(),
    serverId: serverIdSchema,
    stores: z.array(storeDescriptorSchema),
  }),
  /**
   * Says that the handshake failed, and no more. A rejection that explained
   * which half of the credential was wrong would be a probing oracle.
   */
  z.object({
    type: z.literal('handshake-rejected'),
    replyTo: frameIdSchema,
    reason: z.enum(['unauthorized', 'protocol-version']),
  }),
  z.object({
    type: z.literal('pong'),
    replyTo: frameIdSchema,
  }),
]);
export type ServerToHubFrame = z.infer<typeof serverToHubFrameSchema>;

/** The one parser for everything a server reads from the hub. */
export const parseHubToServerFrame = frameParser(hubToServerFrameSchema);

/** The one parser for everything the hub reads from a server. */
export const parseServerToHubFrame = frameParser(serverToHubFrameSchema);
