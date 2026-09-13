import { z } from 'zod';
import {
  directoryListFrameSchema,
  directoryListingFrameSchema,
  directorySchema,
} from './directory.js';
import { docContentSchema, docDirectorySchema, docEntrySchema, docNameSchema } from './doc.js';
import { frameIdSchema, protocolErrorFrameSchema, refusalCodeSchema } from './frames.js';
import {
  hubIdSchema,
  providerSchema,
  serverIdSchema,
  sessionIdSchema,
  sessionRefSchema,
  startIdSchema,
  storeDescriptorSchema,
  storeIdSchema,
} from './identity.js';
import { machineLoadSchema } from './machine-state.js';
import { frameParser } from './parse.js';
import { providerReadinessSchema } from './readiness.js';
import { sessionDescriptorSchema, sessionHoldSchema, sessionStartTagSchema } from './session.js';
import { serverTerminalFrames } from './terminal.js';

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
   * Every field but one is a name, and none of them is an argument. `storeId`
   * is a store this server said it had mounted, and the server turns it into a
   * directory out of its own configuration. `provider` selects a registered
   * adapter and the adapter builds the argv. There is no operation name, no
   * argv element and no environment variable on this frame, and the registry is
   * what makes that possible rather than merely current policy.
   *
   * The one exception is `directory`, and it is the amended rule rather than a
   * hole in the old one. `directory.ts` carries the argument; what makes this
   * field not the `{ cwd }` the rule forbade is that it is parsed by
   * `directorySchema`, that this server refuses it unless its real path sits
   * under a root its own operator configured -- a list nothing on this wire can
   * add to, empty by default -- and that the only spawn field it may ever reach
   * is `cwd`, on a spawn the operation registry still builds with `shell:
   * false` and an argv this process wrote.
   */
  z.object({
    type: z.literal('session-start'),
    id: frameIdSchema,
    /**
     * The hub's own name for this act of starting, minted before the frame is
     * sent and carried so the server can tag the terminal it forks with it.
     *
     * Beside `id` rather than instead of it, because they answer different
     * questions and outlive each other by different amounts. `id` correlates
     * this frame with its reply on this socket and is spent the moment the
     * reply arrives. This names the start itself: the server reports it back
     * until the provider has written a session id, and a hub that redialled in
     * between still recognises it -- which the frame id, unique only within a
     * connection, could not survive.
     *
     * It is on every start and not only on a spawn. A resume already has a
     * session id and needs no other name, but a frame whose fields depend on
     * which kind of start it is would be a frame every reader has to branch on,
     * to save minting one id.
     */
    startId: startIdSchema,
    storeId: storeIdSchema,
    /** The session to resume, or `null` to start one the provider will name. */
    sessionId: sessionIdSchema.nullable(),
    provider: providerSchema,
    /** User content, placed by the adapter as one argv element. Never an option. */
    prompt: z.string().min(1).nullable(),
    /**
     * Where to spawn, when the hub is starting this session in a project, and
     * `null` for the start that has always existed -- the store's own path, as
     * this server resolved it at boot.
     *
     * Only a spawn may carry one. A resume's directory is whatever the provider
     * itself recorded in the transcript, and nobody gets to choose it: a
     * session resumed elsewhere is a different session that happens to share a
     * history. This server refuses the pair rather than quietly preferring one.
     *
     * `null` rather than an absent property, so that every start has one shape
     * and no reader has to remember which kind carries a directory.
     */
    directory: directorySchema.nullable(),
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
  /**
   * Watching a session, feeding it, and telling it how big the screen is.
   *
   * Defined in `terminal.ts` and instantiated for this leg, because these are
   * relayed rather than answered: what a client sends the hub about a terminal
   * is what the hub sends the server, with the one field that cannot be the
   * same on both legs -- the start handle, a `StartId` here and a client's own
   * frame id there -- swapped. See that file for why, and for why output is
   * base64 in a JSON frame while input is text.
   *
   * They address a session or a start handle and never a terminal, so nothing
   * here can name a process on this machine. What a subscription buys the peer
   * is output from a session it could already stop.
   */
  serverTerminalFrames.subscribe,
  serverTerminalFrames.unsubscribe,
  serverTerminalFrames.input,
  serverTerminalFrames.resize,
  /**
   * List a directory on this machine, for a user browsing for a project.
   *
   * The one instruction on this direction that carries a path, and the only
   * one that ever will without amending the rule again: `directory.ts` holds
   * the amendment and the argument for it. What arrives here is a claim like
   * any other -- the server checks it against the browse roots its own
   * operator configured, which is a list nothing on this wire can add to, and
   * refuses anything else.
   *
   * Which server is not on it. The hub chose this connection before the frame
   * was written, and a field naming the machine would be the hub telling a
   * server which server it is.
   */
  directoryListFrameSchema,
  /**
   * A project's documents: replace one whole, read one back, list them.
   *
   * `directory` is the working tree the project is keyed by, and it is a key
   * and not a cwd. The server derives a folder name from it by the one-way
   * function `project-files.ts` describes and joins `name` -- one path segment
   * from a closed list of extensions, see `doc.ts` -- onto that folder under
   * its own data root. Nothing on these frames is handed to a process: a
   * document write is a file the server writes on its own account, not a
   * spawn, and it goes through no operation registry because there is no
   * operation. The rule that no frame carries a cwd is about what reaches a
   * child, and the test beside the server's handler holds that nothing here
   * does.
   *
   * A write replaces the whole document. There is no patch form, so there is
   * no way for the hub to hold a version the server never saw whole, and a
   * write that lands is the document. The folder is made on the first write
   * and never on a read: reading a project nobody has written to is an empty
   * listing or a refusal, not a directory.
   */
  z.object({
    type: z.literal('doc-write'),
    id: frameIdSchema,
    directory: docDirectorySchema,
    name: docNameSchema,
    content: docContentSchema,
  }),
  z.object({
    type: z.literal('doc-read'),
    id: frameIdSchema,
    directory: docDirectorySchema,
    name: docNameSchema,
  }),
  z.object({
    type: z.literal('doc-list'),
    id: frameIdSchema,
    directory: docDirectorySchema,
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
    /**
     * What this machine's cpus were doing when it answered, or `null` when it
     * could not tell.
     *
     * On the heartbeat rather than on a frame of its own or on a ticker of this
     * server's, and that is the whole of the cadence argument. A machine's load
     * is the one fact in the panel that goes stale in seconds, and the obvious
     * way to keep it fresh is to send it every second whether or not anyone is
     * looking -- which is the unbounded reporting the terminal path already had
     * to grow a cap and a drop counter for, rebuilt somewhere new and cheaper
     * to overlook.
     *
     * The heartbeat is already the right cadence and already has the right
     * bounds. It runs while a hub is connected and not otherwise, so a server
     * nobody is watching samples nothing; its interval is the hub's to choose,
     * so a fleet that wants this less often changes one number at the end that
     * pays for it; and it is the very round trip the hub times its latency
     * over, so the two live facts of the machine block arrive together and are
     * true of the same instant.
     *
     * Sampling happens when the ping arrives, not on a schedule of this
     * server's -- there is no timer here to have got stuck, and no reading held
     * from before the hub asked.
     */
    load: machineLoadSchema.nullable(),
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
    /**
     * Which of this connection's starts produced which session, for as long as
     * that is not obvious.
     *
     * `holding` cannot carry it: a hold is keyed by session id, and the whole
     * difficulty is the stretch of time in which a spawned terminal has no
     * session id to be keyed by. So a freshly spawned terminal appears here,
     * under the start handle that asked for it, and appears here once more
     * when discovery names its session -- after which the hub has the pair it
     * needs and the tag is dropped.
     *
     * Present and empty rather than absent on a report with nothing to say, so
     * that every report has one shape.
     *
     * The handles are the hub's own `StartId`s, so this list is the same across
     * every connection one hub makes -- which is the point: a hub that dropped
     * and redialled between the fork and the first scan is told here what it
     * started, rather than losing the only name that spawn had. It is *not* the
     * same across two hubs. A start id is minted by one hub and means nothing
     * to another, so a start is reported only to the connections holding the
     * grant it was made under; another hub sees an empty list where this one
     * sees its own starts, and sees the session itself as soon as the provider
     * names it, like any other session in the store.
     */
    starts: z.array(sessionStartTagSchema),
  }),
  /**
   * This server is shutting down, and is waiting for the turns it holds to end
   * before it closes them.
   *
   * Unsolicited, sent once, and the last thing a hub hears from a server that
   * is going down on purpose. Without it a drain is indistinguishable from a
   * machine that stopped answering: the sessions simply stop being reported,
   * and a client has to decide between showing them as running and showing
   * nothing. With it there is a third reading, which is the true one -- these
   * sessions are closing, this is how long it will take at the outside.
   *
   * `graceMs` is a duration and not a deadline, for the reason `store-report`
   * carries no timestamp: two machines' clocks disagree, and the hub stamps
   * what it receives with its own.
   *
   * `sessions` is what this server is holding as it starts to drain, named
   * rather than left to be inferred from the last `holding` the hub was sent --
   * a report can be older than this frame, and the sessions that are about to
   * close are exactly the ones a client is looking at. A terminal the provider
   * has not named yet cannot appear here and is not invented: it is absent,
   * which is the honest shape of "this server cannot tell you which session
   * that is".
   *
   * It promises nothing about what happens next. A server may close a session
   * the moment it reaches a boundary, or kill it when the grace runs out, and
   * either way the connection ends without a second frame -- because a server
   * that is exiting cannot promise to send one.
   */
  z.object({
    type: z.literal('server-draining'),
    /** How long this server will wait for a turn to end before it kills it. */
    graceMs: z.int().nonnegative(),
    /** The sessions it holds as the drain starts. Empty is a server with none. */
    sessions: z.array(sessionRefSchema),
  }),
  /** The other half of the relay. See `terminal.ts`. */
  serverTerminalFrames.subscribed,
  serverTerminalFrames.unsubscribed,
  serverTerminalFrames.output,
  /** What is in that directory. The same shape the hub answers a client with. */
  directoryListingFrameSchema,
  /**
   * The server will not list that directory, and why.
   *
   * Its own frame rather than a second use of `session-refused`, and the
   * difference is `hold`. A session refusal carries the live process when
   * there is one, because "it is running over here" is an answer that leads
   * somewhere; a directory has no process to name, so the field would be
   * present, always null, and every reader would have to learn which refusals
   * it means anything on. A frame that carries only what it can say is one
   * fewer thing to check.
   *
   * The codes are the shared set. `refused` is the rule speaking -- no roots
   * are configured, that path is not under one, that path is not a directory
   * -- and retrying changes nothing. `internal` is this machine failing on its
   * own side, a directory inside a root that it could not read, where a fixed
   * permission makes the same request work.
   */
  z.object({
    type: z.literal('directory-refused'),
    replyTo: frameIdSchema,
    code: refusalCodeSchema,
    message: z.string(),
  }),
  /**
   * The answers to the document frames.
   *
   * `updatedAt` on each is the write time the server's filesystem recorded,
   * in milliseconds since the epoch on that machine's clock. It is carried
   * rather than stamped by the hub, unlike a store report, because it is a
   * fact about a file rather than about when a message arrived: a client
   * showing "edited three minutes ago" is showing this number, and the hub's
   * receipt time would be the wrong answer by however long the doc had been
   * sitting there before anybody asked.
   *
   * A refusal on any of the three is `session-refused` with `hold: null`.
   * That frame's contract is "the server said no, and to which frame", and
   * the terminal frames already answer through it with no session in hand;
   * its name predates this direction carrying anything but session
   * instructions, and renaming it is a change to every peer for a word.
   */
  z.object({
    type: z.literal('doc-written'),
    replyTo: frameIdSchema,
    updatedAt: z.int().nonnegative(),
  }),
  z.object({
    type: z.literal('doc-content'),
    replyTo: frameIdSchema,
    content: docContentSchema,
    updatedAt: z.int().nonnegative(),
  }),
  /**
   * Every document in the project's folder, whole. A file in the folder whose
   * name the name parser would refuse is not a document and is not listed;
   * one that could not be read costs itself and not the listing.
   */
  z.object({
    type: z.literal('doc-listing'),
    replyTo: frameIdSchema,
    entries: z.array(docEntrySchema),
  }),
  protocolErrorFrameSchema,
]);
export type ServerToHubFrame = z.infer<typeof serverToHubFrameSchema>;

/** The one parser for everything a server reads from the hub. */
export const parseHubToServerFrame = frameParser(hubToServerFrameSchema);

/** The one parser for everything the hub reads from a server. */
export const parseServerToHubFrame = frameParser(serverToHubFrameSchema);
