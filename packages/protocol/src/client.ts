import { z } from 'zod';
import { directoryListingFrameSchema, directorySchema } from './directory.js';
import { docContentSchema, docNameSchema } from './doc.js';
import { frameIdSchema, protocolErrorFrameSchema, refusalCodeSchema } from './frames.js';
import {
  hubIdSchema,
  nodeIdSchema,
  providerSchema,
  serverRegistrationIdSchema,
  sessionIdSchema,
  storeIdSchema,
} from './identity.js';
import { layoutSchema, nodeNameTextSchema } from './layout.js';
import { machineStateSchema, sessionHolderSchema } from './machine-state.js';
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
    /**
     * The project to start in, or `null` for the store's own directory.
     *
     * A node id and not a directory, which is the difference between this and
     * `directory-list` above. A project is a row this hub owns: the client
     * names it, the hub resolves the directory out of its own database, and the
     * directory that reaches a server is one that was chosen by browsing that
     * server's roots rather than typed into a frame. A client that could put
     * the path here would be a client choosing the cwd, which is the surface
     * the rule exists to keep shut -- so the field that crosses is an id, and
     * the only party that turns one into a path is the party holding the rows.
     *
     * `null` is what a start has always been: the server resolves the store's
     * own directory and spawns there. Both remain, because a session that
     * belongs to no project is the ordinary case and not a degraded one.
     */
    project: nodeIdSchema.nullable(),
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
  /**
   * Makes a project: a name, and a directory on some machine.
   *
   * No server is named, and that is the decision rather than an omission. A
   * project is a directory, and a directory is a path -- more than one machine
   * may have the same checkout at the same path, and a laptop that is asleep
   * when the project is made is a machine that may run it tomorrow. Binding a
   * project to the machine its directory happened to be browsed on would make
   * the project as reachable as that one box, which is not what the user chose.
   *
   * So the directory is not checked against any server's roots here. It cannot
   * be: no server is named, and the hub does not hold anybody else's root list
   * -- that list is the server operator's and a copy of it here would be a
   * second answer to a question only one machine can answer. The check happens
   * where it can, at the moment a session is actually started in the project,
   * on the machine that is about to spawn.
   *
   * `directory` is parsed by `directorySchema` like every other one on this
   * wire: absolute, no NUL. The hub normalises it before storing, so that one
   * directory is one project however it was spelled.
   */
  z.object({
    type: z.literal('project-create'),
    id: frameIdSchema,
    name: nodeNameTextSchema,
    directory: directorySchema,
  }),
  /**
   * Renames a project, and nothing else about it.
   *
   * The directory is not here and never will be. A project's directory is what
   * the project *is* -- the sessions under it are the ones reported from it,
   * and the file store on the server is keyed by it -- so changing it would not
   * be an edit to a project but a different project wearing the old one's
   * children. Making another is the honest way to say that, and it is one
   * frame away.
   *
   * It is answered with `node-renamed`, which names no kind: renaming is one
   * act on the tree whatever the node is, and AGX-239's generic node mutations
   * reuse this reply rather than minting a second word for the same yes.
   */
  z.object({
    type: z.literal('project-rename'),
    id: frameIdSchema,
    nodeId: nodeIdSchema,
    name: nodeNameTextSchema,
  }),
  /**
   * Makes a document in a project, on one machine, with its first content.
   *
   * Three of the fields are the decision. `projectId` is a node id and never a
   * directory, for the reason a start's `project` is one: the client names a
   * row, the hub turns it into a path out of its own database, and no client
   * can choose where a write lands. `server` is named by the user and is not
   * the hub's to choose, like a browse and unlike a start -- a document is a
   * file on one machine's disk, and the hub holds no copy to serve from a
   * second one. `name` and `content` are the server leg's own schemas, reused
   * rather than restated: what the hub may forward is exactly what a server
   * will accept, so a name this hub takes and that server refuses is a state
   * neither end can reach.
   *
   * There is no `doc-remove` and no `doc-rename` here. Both are the
   * catalogue's frames over a node once AGX-239 lands, and minting a second
   * word for either would be a second answer to what removing a node means.
   */
  z.object({
    type: z.literal('doc-create'),
    id: frameIdSchema,
    projectId: nodeIdSchema,
    server: serverRegistrationIdSchema,
    name: docNameSchema,
    content: docContentSchema,
  }),
  /**
   * Replaces a document's content, whole.
   *
   * The node is the whole address: which project, which machine and what the
   * file is called are the hub's rows, and a client that could restate any of
   * them would be a client that could redirect a write. There is no patch
   * form, for the reason the server leg has none -- a write that lands is the
   * document, and no version the hub never saw whole can be half-applied.
   */
  z.object({
    type: z.literal('doc-save'),
    id: frameIdSchema,
    nodeId: nodeIdSchema,
    content: docContentSchema,
  }),
  /**
   * Reads a document back.
   *
   * It carries no content bound and no range, because the hub holds no copy to
   * serve part of: the file is on the machine that wrote it, the whole of it
   * comes back or a refusal does, and a document on a machine that is not
   * connected is that refusal with the machine named in it. That is the cost
   * of content never being in the hub's database, taken deliberately -- an
   * index the hub can list while the machine is away, and content only the
   * machine that has it can answer for.
   */
  z.object({
    type: z.literal('doc-open'),
    id: frameIdSchema,
    nodeId: nodeIdSchema,
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
  /**
   * The project exists, and this is the node it is.
   *
   * The id is carried rather than left to be found in the next layout, because
   * it is the one thing the client cannot work out for itself: a project is
   * named by a node id from here on -- a start names one -- and a client that
   * had to match its own project back out of a tree by name would be matching
   * on the one field the user is free to change.
   */
  z.object({
    type: z.literal('project-created'),
    replyTo: frameIdSchema,
    nodeId: nodeIdSchema,
  }),
  /**
   * The node is now called what was asked, and there is nothing else to say.
   *
   * It carries no name, because the client sent it and the hub stored exactly
   * that; and no kind, because a rename is one act on the tree whatever the
   * node is. AGX-239 answers its own renames with this frame rather than a
   * second one, which is why it is named for the act and not for the caller.
   */
  z.object({
    type: z.literal('node-renamed'),
    replyTo: frameIdSchema,
  }),
  /**
   * The document exists, and this is the node it is.
   *
   * The id is carried for the reason `project-created` carries one: every
   * later frame about this document names the node, and a client that had to
   * find its own back out of a tree would be matching on a name the user is
   * free to change.
   */
  z.object({
    type: z.literal('doc-created'),
    replyTo: frameIdSchema,
    nodeId: nodeIdSchema,
  }),
  /**
   * The document was written, and this is when the machine that holds it says
   * it was.
   *
   * Carried rather than left for the client to stamp, and it is the server's
   * clock rather than the hub's: "edited two minutes ago" is a fact about a
   * file, and the hub's receipt time would be the wrong answer by however long
   * the write took to cross two machines.
   */
  z.object({
    type: z.literal('doc-saved'),
    replyTo: frameIdSchema,
    updatedAt: z.int().nonnegative(),
  }),
  /**
   * A document, whole, with the write time the machine holding it reported.
   *
   * The same name as the server leg's reply and the same two fields, because
   * it is the same answer relayed: the hub reads no document and rewrites
   * none, so a second shape here would be a second thing to keep in step for
   * no gain. A refusal travels as `refusal` with `holder: null`, like every
   * other no on this direction.
   */
  z.object({
    type: z.literal('doc-content'),
    replyTo: frameIdSchema,
    content: docContentSchema,
    updatedAt: z.int().nonnegative(),
  }),
  protocolErrorFrameSchema,
]);
export type HubFrame = z.infer<typeof hubFrameSchema>;

/** The one parser for everything the hub reads from a client. */
export const parseClientFrame = frameParser(clientFrameSchema);

/** The one parser for everything a client reads from the hub. */
export const parseHubFrame = frameParser(hubFrameSchema);
