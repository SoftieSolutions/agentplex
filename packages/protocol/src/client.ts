import { z } from 'zod';
import { directoryListingFrameSchema, directorySchema } from './directory.js';
import { frameIdSchema, protocolErrorFrameSchema, refusalCodeSchema } from './frames.js';
import {
  hubIdSchema,
  providerSchema,
  serverRegistrationIdSchema,
  sessionIdSchema,
  storeIdSchema,
} from './identity.js';
import { layoutSchema } from './layout.js';
import { machineStateSchema, sessionHolderSchema } from './machine-state.js';
import {
  SERVER_ADDRESS_MAX_CHARS,
  SERVER_LABEL_MAX_CHARS,
  SERVER_TOKEN_MAX_CHARS,
} from './pairing.js';
import { frameParser } from './parse.js';
import {
  sessionSubscribeFrameSchema,
  sessionSubscribedFrameSchema,
  sessionUnsubscribeFrameSchema,
  sessionUnsubscribedFrameSchema,
  terminalInputFrameSchema,
  terminalOutputFrameSchema,
  terminalResizeFrameSchema,
} from './terminal.js';

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
 * Terminal frames are the third kind, and they break the second rule on
 * purpose: `terminal-output` is unsolicited like `machine-state` but goes to
 * the clients watching that session rather than to all of them, because a
 * client that is not looking at a terminal has no use for its bytes. They are
 * defined in `terminal.ts` and shared with the server direction unchanged --
 * a terminal frame is relayed, not answered, and one shape for both legs is
 * what keeps the relay from being two shapes that drift.
 */

/**
 * The pane layout as it crosses the wire: characters the hub never parses.
 *
 * The split-pane arrangement is a client concern from end to end — what a
 * pane is, how a split divides, what a ratio means. Those rules live in the
 * web app's own parser, and the hub stores and answers the characters
 * verbatim, so a new pane type is a client release and never a service one.
 * The one thing the protocol does state is a bound: a blob this size is not a
 * layout anybody arranged by hand, and an unbounded column filled by a bug
 * would grow without anything ever objecting.
 */
export const PANE_LAYOUT_MAX_CHARS = 65_536;
export const paneLayoutTextSchema = z.string().max(PANE_LAYOUT_MAX_CHARS);

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
   * The answer is a `layout` frame. It was a refusal until the node tree
   * existed to read one out of; the routing was built and tested first, and the
   * answer replaced the refusal on exactly that path.
   */
  z.object({
    type: z.literal('layout-request'),
    id: frameIdSchema,
  }),
  /**
   * Asks for the stored pane layout: the split-pane arrangement of the screen,
   * as distinct from the node tree `layout-request` asks for.
   *
   * Like the node tree, it carries nothing but its id — there is one stored
   * pane layout and the asking is the whole request — and the answer is a
   * reply to the asking client alone.
   */
  z.object({
    type: z.literal('pane-layout-request'),
    id: frameIdSchema,
  }),
  /**
   * Stores the pane layout, replacing whatever was stored.
   *
   * Whole, never a delta: the client that saves owns the entire arrangement it
   * is looking at, and a hub merging edits into characters it does not parse
   * would be editing something it cannot read. The hub's part is to keep the
   * characters and answer them back; every shape rule lives in the client (see
   * `paneLayoutTextSchema` above), so this frame changes when the bound
   * changes and for no other reason.
   */
  z.object({
    type: z.literal('pane-layout-save'),
    id: frameIdSchema,
    layout: paneLayoutTextSchema,
  }),
  /**
   * Asks the hub to run a session, in a store.
   *
   * A start names a store and never a machine. Which server runs it is the
   * hub's to decide -- it is the only thing that can see every server attached
   * to a volume -- and `server` is the user overriding that decision, not the
   * ordinary way to ask. `null` means "you choose", which is what a client
   * sends unless somebody picked a machine off a menu.
   *
   * What this frame cannot say is the whole point of it. There is no operation
   * name, no argv element, no environment variable and no working directory
   * here, and there is nowhere to put one. The server owns the spawn: it turns
   * a store id into a directory it resolved from its own configuration, and a
   * provider name into the adapter that builds the argv, `shell: false`. A
   * generic `{ command }` frame is exactly the failure this shape exists to
   * make unrepresentable.
   *
   * `prompt` is the exception that proves it, and it is user content rather
   * than an option: the adapter places it as one argv element and no shell ever
   * sees it. `null` leaves the provider at its own prompt.
   */
  z.object({
    type: z.literal('session-start'),
    id: frameIdSchema,
    storeId: storeIdSchema,
    /**
     * The session to resume, or `null` to start a new one.
     *
     * A new session has no id to name: the provider mints its own and writes
     * it, and agentplex naming it up front would mean `--session-id`, the flag
     * family that splits a history in two. The id arrives from the next scan.
     */
    sessionId: sessionIdSchema.nullable(),
    provider: providerSchema,
    prompt: z.string().min(1).nullable(),
    /** The user's choice of machine, or `null` to let the hub schedule it. */
    server: serverRegistrationIdSchema.nullable(),
  }),
  /**
   * Asks the hub to stop a session.
   *
   * It addresses `{ storeId, sessionId }` and nothing else. The hub resolves
   * which server holds it and that server resolves its own terminal, so no pid
   * and no terminal handle ever crosses a wire -- a client that could name a
   * process would be a client that could name any process.
   */
  z.object({
    type: z.literal('session-stop'),
    id: frameIdSchema,
    storeId: storeIdSchema,
    sessionId: sessionIdSchema,
  }),
  /**
   * Watching a session, typing into it, and saying how big the screen is.
   *
   * A subscription is standing interest and is replayed on reconnection, which
   * is why it is a frame with a partner rather than something implied by
   * opening a pane: the thing it moves is a count the server evicts by, and a
   * client that closes a tab has to be able to give it back.
   *
   * Selection, copy and scroll are deliberately not here. Selection and copy
   * happen entirely in the browser's emulator and this protocol has no notion
   * of a selection; paste is `terminal-input` and nothing more, because the
   * bytes a user pastes are the bytes a user typed; scroll is scrollback,
   * which is its own ticket. Resize is the one that genuinely crosses.
   */
  sessionSubscribeFrameSchema,
  sessionUnsubscribeFrameSchema,
  terminalInputFrameSchema,
  terminalResizeFrameSchema,
  /**
   * Pairs a server: dial this address, with this token, and call it this.
   *
   * The token is the only credential a client frame ever carries, and this is
   * the one direction it may travel. The hub stores it and never says it
   * again: no reply carries it, no `machine-state` row has a field for it, and
   * no log line here names it. A frame that echoed a token back would put a
   * secret into every client's copy of the state to answer a question the
   * client that typed it already knows the answer to.
   *
   * The three fields are bounded and otherwise unparsed, which is deliberate
   * and is the opposite of what the rest of this file does. Every content rule
   * -- `wss://` only, no credentials in the URL, a label with something in it,
   * a token that is not empty -- lives in `pairing.ts` and is applied by the
   * hub's handler, because the answer to a typed address that is not an
   * address has to be a refusal the person reads. A schema strict enough to
   * reject it here would make the answer a `protocol-error` and a closed
   * socket: the client would be disconnected for a typo, with the words for it
   * in a frame that names no request. The bounds stay because they are about
   * what a socket may carry rather than about what a pairing may say.
   */
  z.object({
    type: z.literal('server-pair'),
    id: frameIdSchema,
    label: z.string().max(SERVER_LABEL_MAX_CHARS),
    address: z.string().max(SERVER_ADDRESS_MAX_CHARS),
    token: z.string().max(SERVER_TOKEN_MAX_CHARS),
  }),
  /**
   * Revokes one pairing, by the hub's own name for it.
   *
   * `registrationId` and not an address or a `ServerId`: the registration is
   * the unit an operator revokes, it is the key every row on the settings
   * screen already carries, and it is the only one of the three that names one
   * pairing rather than possibly two. A server paired with two hubs holds two
   * tokens, and revoking by machine would be an instruction nobody could aim.
   */
  z.object({
    type: z.literal('server-unpair'),
    id: frameIdSchema,
    registrationId: serverRegistrationIdSchema,
  }),
  /**
   * Asks what is in a directory on one paired server, so that the user can
   * pick one by browsing.
   *
   * This is the first client frame to carry a directory, and `directory.ts`
   * holds the amended rule that lets it. What makes this not the `{ cwd }`
   * field the old rule forbade is not that a directory is harmless: it is that
   * the value is parsed by `directorySchema`, refused by the server unless it
   * sits under a root that server's operator configured, and reaches no spawn
   * field but `cwd` on a spawn the operation registry still builds.
   *
   * `server` is named and is not the hub's to choose, which is the one place
   * this differs from a start. A start names a store, because a store is a
   * volume more than one machine may have mounted and which of them runs a
   * session is the hub's decision; a directory is a fact about one machine's
   * disk, and "browse somewhere" is not a question the hub could answer for
   * the user.
   *
   * `null` lists the roots, which is how a browse begins: the client does not
   * know what that machine will allow, and must not have to guess.
   */
  z.object({
    type: z.literal('directory-list'),
    id: frameIdSchema,
    server: serverRegistrationIdSchema,
    directory: directorySchema.nullable(),
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
   * The stored layout, answered to the client that asked for it and to nobody
   * else.
   *
   * A reply and never a broadcast, which is the whole difference between this
   * and `machine-state`. The machine state is one shared fact about the world
   * and every client gets the same bytes; a layout is one person's arrangement
   * of their own screen, and pushing it unasked would rearrange every other tab
   * the moment one of them looked.
   *
   * Whole, for the reason nothing here is ever a delta: a client holding a
   * subset of edits to a tree has a tree nobody can vouch for.
   */
  z.object({
    type: z.literal('layout'),
    replyTo: frameIdSchema,
    nodes: layoutSchema,
  }),
  /**
   * The stored pane layout, answered to the client that asked and to nobody
   * else, for the reason the node tree is: one person's arrangement of one
   * screen, and pushing it unasked would rearrange every other tab.
   *
   * `layout` is exactly the characters the last save carried — the hub reads
   * nothing out of them — or `null` when nothing has ever been saved. `null`
   * rather than an empty string, because "no layout has been arranged" is an
   * answer the client renders as its default, and an empty string would be a
   * blob that fails the client's parser and reads as damage.
   */
  z.object({
    type: z.literal('pane-layout'),
    replyTo: frameIdSchema,
    layout: paneLayoutTextSchema.nullable(),
  }),
  /** The pane layout was stored. Nothing to carry: the client sent the bytes. */
  z.object({
    type: z.literal('pane-layout-saved'),
    replyTo: frameIdSchema,
  }),
  /**
   * A session is running, and here is where it landed.
   *
   * `server` is the answer to the scheduling question the client did not ask:
   * a start names a store, and the client is owed the name of the machine the
   * hub picked, whether or not it overrode the choice.
   *
   * `sessionId` is `null` for a session that has just been spawned, and that is
   * honest rather than incomplete: the provider mints its own id and writes it,
   * and the hub learns it from the next report rather than inventing one to
   * fill the field. A resume answers with the id it was given.
   */
  z.object({
    type: z.literal('session-started'),
    replyTo: frameIdSchema,
    storeId: storeIdSchema,
    sessionId: sessionIdSchema.nullable(),
    server: serverRegistrationIdSchema,
  }),
  /** A session's process has been killed. Its transcript is untouched. */
  z.object({
    type: z.literal('session-stopped'),
    replyTo: frameIdSchema,
    storeId: storeIdSchema,
    sessionId: sessionIdSchema,
    /** Which server it was resolved to, hub-side. The client never named it. */
    server: serverRegistrationIdSchema,
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
    /**
     * The server already running the session, when that is why the answer was
     * no, and `null` for every other refusal.
     *
     * Named rather than merely refused, because "it is running over here" is a
     * different answer from "no" and leads somewhere: the way out is stopping
     * the holder, and a client cannot offer that without knowing which machine
     * to aim at. `stoppable` on the holder is what decides whether it offers
     * the button at all.
     *
     * `null` rather than an absent property, so that every refusal has one
     * shape and no reader has to remember which kinds carry a holder.
     */
    holder: sessionHolderSchema.nullable(),
  }),
  /**
   * The terminal's own frames, relayed from the server that holds the session.
   *
   * `session-subscribed` is a reply and reaches the client that asked;
   * `terminal-output` is unsolicited and reaches every client subscribed to
   * that session, which is the one thing here that is neither a broadcast to
   * everybody nor an answer to one asker.
   */
  sessionSubscribedFrameSchema,
  sessionUnsubscribedFrameSchema,
  terminalOutputFrameSchema,
  /**
   * The pairing was recorded, and here is the hub's name for it.
   *
   * `registrationId` is the whole of the answer, and it is what the client
   * needs: it is the key the row arriving in the next `machine-state` is drawn
   * under, so a client that wants to follow what it just paired has the id
   * before the state carrying it lands.
   *
   * What this does not carry is the label, the address or the token. The first
   * two the client sent and already has; the third it sent and must never be
   * told again -- a reply that echoed it would spread a secret to answer
   * nothing. Nothing about the connection is claimed here either: recording a
   * pairing is not reaching the machine, and whether the hub can is the row's
   * `phase` to say a moment later.
   */
  z.object({
    type: z.literal('server-paired'),
    replyTo: frameIdSchema,
    registrationId: serverRegistrationIdSchema,
  }),
  /**
   * The pairing is revoked: its token is gone and the hub has stopped dialling.
   *
   * Nothing to carry. The client named the registration, the row leaves the
   * next `machine-state`, and an answer that restated the id would be a second
   * copy of what the request said.
   */
  z.object({
    type: z.literal('server-unpaired'),
    replyTo: frameIdSchema,
  }),
  /**
   * What is in that directory, relayed from the server that holds the disk.
   *
   * A reply to the client that asked and to nobody else, for the reason a
   * layout is: what one person is browsing on one machine is not a fact about
   * the fleet, and pushing it unasked would be answering a question nobody
   * else had open. The same shape the server answered the hub with, unchanged
   * -- see `directory.ts` for why one shape serves both legs.
   *
   * A refusal travels as `refusal` with `holder: null`, like every other no on
   * this direction: a directory has no live process to name, and the client
   * renders the sentence.
   */
  directoryListingFrameSchema,
  protocolErrorFrameSchema,
]);
export type HubFrame = z.infer<typeof hubFrameSchema>;

/** The one parser for everything the hub reads from a client. */
export const parseClientFrame = frameParser(clientFrameSchema);

/** The one parser for everything a client reads from the hub. */
export const parseHubFrame = frameParser(hubFrameSchema);
