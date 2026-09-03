import { z } from 'zod';
import { frameIdSchema, protocolErrorFrameSchema } from './frames.js';
import { hubIdSchema, serverIdSchema, storeDescriptorSchema } from './identity.js';
import { frameParser } from './parse.js';

/**
 * The server-facing half of the protocol: hub to paired server.
 *
 * The hub dials; a server dials out to nothing. So the handshake is the hub
 * saying which hub it is and presenting that server's token, and the server
 * answering with who it is, which protocol it speaks, and what it has mounted.
 */

export const hubToServerFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('handshake'),
    id: frameIdSchema,
    protocolVersion: z.int(),
    /**
     * Which hub is dialling. `identity.ts` says a hub id distinguishes two hubs
     * to one paired server, and a server can only tell them apart if the
     * handshake says so: it dials out to nothing, so this frame is all it gets.
     * A server mounted by two hubs sees two of these on two connections.
     */
    hubId: hubIdSchema,
    /** The token the user typed into the hub for this server, and only this one. */
    token: z.string().min(1),
  }),
  z.object({
    type: z.literal('ping'),
    id: frameIdSchema,
  }),
  protocolErrorFrameSchema,
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
  protocolErrorFrameSchema,
]);
export type ServerToHubFrame = z.infer<typeof serverToHubFrameSchema>;

/** The one parser for everything a server reads from the hub. */
export const parseHubToServerFrame = frameParser(hubToServerFrameSchema);

/** The one parser for everything the hub reads from a server. */
export const parseServerToHubFrame = frameParser(serverToHubFrameSchema);
