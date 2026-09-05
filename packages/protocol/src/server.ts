import { z } from 'zod';
import { frameIdSchema, protocolErrorFrameSchema, refusalCodeSchema } from './frames.js';
import {
  hubIdSchema,
  providerSchema,
  serverIdSchema,
  sessionIdSchema,
  storeDescriptorSchema,
  storeIdSchema,
} from './identity.js';
import { frameParser } from './parse.js';
import { providerReadinessSchema } from './readiness.js';
import { sessionDescriptorSchema, sessionHoldSchema } from './session.js';

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
  /**
   * Run a session in one of this server's stores.
   *
   * The hub has already chosen this machine and already refused the start if
   * some other server holds the session; what arrives here is an instruction,
   * and the server checks it again anyway. One live process per session is
   * enforced where the processes actually are as well as where the fleet is
   * visible, because a hub with a view that is a second out of date must not be
   * able to talk a server into a second agent on one transcript.
   *
   * Every field is a name, and none of them is an argument. `storeId` is a
   * store this server said it had mounted, and the server turns it into a
   * directory out of its own configuration -- a `{ cwd }` field here would be a
   * remote code execution primitive wearing a path. `provider` selects a
   * registered adapter and the adapter builds the argv. There is no operation
   * name, no argv element and no environment variable on this frame, and the
   * registry is what makes that possible rather than merely current policy.
   */
  z.object({
    type: z.literal('session-start'),
    id: frameIdSchema,
    storeId: storeIdSchema,
    /** The session to resume, or `null` to start one the provider will name. */
    sessionId: sessionIdSchema.nullable(),
    provider: providerSchema,
    /** User content, placed by the adapter as one argv element. Never an option. */
    prompt: z.string().min(1).nullable(),
  }),
  /**
   * Kill the process running this session.
   *
   * The session is addressed and the process is not: the server looks up its
   * own terminal for `{ storeId, sessionId }`. A pid on this frame would be the
   * hub reaching across a machine boundary to name a process it cannot see, and
   * a pid is stale the moment it is read.
   */
  z.object({
    type: z.literal('session-stop'),
    id: frameIdSchema,
    storeId: storeIdSchema,
    sessionId: sessionIdSchema,
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
    /**
     * What this machine can actually start, resolved once at startup.
     *
     * Here rather than in a frame of its own, and required rather than
     * optional, because it answers the same question `stores` does -- what is
     * on this box -- and because the hub has to hold it before it can route the
     * first start. A server that reports nothing here reports that it can start
     * nothing, which is what a build with no adapters is; there is no shape in
     * which "it did not say" and "it has none" are the same value.
     *
     * It is a reading and not a promise. The state is as of boot, so a provider
     * uninstalled while the server runs is still listed as ready and the start
     * still fails -- worse than perfect and far better than the alternative,
     * which is probing a binary on the path of every session start. What this
     * buys is the failure that actually happens: a machine provisioned wrong,
     * or never provisioned, saying so before anybody taps start.
     */
    providers: z.array(providerReadinessSchema),
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
  /**
   * The session is running here. `sessionId` is `null` for a spawn, whose id
   * the provider has not written yet; the next report carries it.
   */
  z.object({
    type: z.literal('session-started'),
    replyTo: frameIdSchema,
    storeId: storeIdSchema,
    sessionId: sessionIdSchema.nullable(),
  }),
  z.object({
    type: z.literal('session-stopped'),
    replyTo: frameIdSchema,
    storeId: storeIdSchema,
    sessionId: sessionIdSchema,
  }),
  /**
   * The server said no, and to which frame.
   *
   * A refusal on this direction rather than a close, because the connection is
   * fine: the hub asked for something this machine will not do, and the next
   * instruction on the same socket may well be one it will. `handshake-rejected`
   * stays its own frame for the opposite reason -- a failed handshake ends the
   * connection, and merging the two would put a code that always closes into a
   * union with codes that never do.
   *
   * `hold` names the live process when that is why the answer was no, and
   * `null` otherwise, so that a hub whose view was a moment out of date learns
   * the fact it was missing rather than only that it was wrong.
   */
  z.object({
    type: z.literal('session-refused'),
    replyTo: frameIdSchema,
    code: refusalCodeSchema,
    message: z.string(),
    hold: sessionHoldSchema.nullable(),
  }),
  /**
   * Everything this server can see in one store, and what it is running there.
   *
   * Unsolicited and whole, for the reasons the machine state is: a report is
   * one server's entire view of one store as of one scan, and what is absent
   * from it is absent from that server's view. There is no delta form, so there
   * is no way for the hub to hold a subset of edits nothing can vouch for.
   *
   * `holding` is the half only this server can know. A transcript on disk says
   * nothing about which machine has a live agent attached to it, and the hub
   * cannot enforce one live process per session across servers unless each of
   * them says which sessions it holds.
   *
   * There is no timestamp on it. The hub stamps what it receives with its own
   * clock, because two servers' clocks disagree and a hub comparing readings
   * dated by the machines that made them is comparing two different times.
   */
  z.object({
    type: z.literal('store-report'),
    storeId: storeIdSchema,
    sessions: z.array(sessionDescriptorSchema),
    holding: z.array(sessionHoldSchema),
  }),
  protocolErrorFrameSchema,
]);
export type ServerToHubFrame = z.infer<typeof serverToHubFrameSchema>;

/** The one parser for everything a server reads from the hub. */
export const parseHubToServerFrame = frameParser(hubToServerFrameSchema);

/** The one parser for everything the hub reads from a server. */
export const parseServerToHubFrame = frameParser(serverToHubFrameSchema);
