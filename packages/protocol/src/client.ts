import { z } from 'zod';
import {
  APPROVAL_POLICY_RULES_MAX,
  approvalAnsweredBySchema,
  approvalDecisionSchema,
  approvalIdSchema,
  approvalOutcomeSchema,
  approvalPolicyRecordSchema,
  approvalPolicyRuleIdSchema,
  approvalPolicyRuleSchema,
} from './approval.js';
import {
  catalogueCursorSchema,
  catalogueFilterSchema,
  catalogueGroupBySchema,
  catalogueItemSchema,
  catalogueSortSchema,
  catalogueViewSchema,
} from './catalogue.js';
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
import { sessionPauseSchema } from './session.js';
import {
  SERVER_ADDRESS_MAX_CHARS,
  SERVER_LABEL_MAX_CHARS,
  SERVER_TOKEN_MAX_CHARS,
} from './pairing.js';
import { frameParser } from './parse.js';
import { pushEndpointSchema, pushKeySchema, pushSubscriptionSchema } from './push.js';
import { clientTerminalFrames, subscriptionEndedFrameSchema } from './terminal.js';
import { transcriptActivitiesSchema, transcriptCountSchema } from './transcript.js';

/**
 * The client-facing half of the protocol: browser (or MCP caller) to hub.
 *
 * Two kinds of frame travel from the hub, and the difference is the whole
 * design of this direction:
 *
 *   * `machine-state` is unsolicited and goes to every client, whole. It has no
 *     `replyTo` because nobody asked for it, and no delta form because two
 *     clients holding different subsets of an edit stream disagree.
 *     `catalogue-changed` is the other one, and it is the odd member: it goes
 *     to everybody unasked, like the state, but carries nothing except a
 *     version -- because the thing that changed is answered per client, and a
 *     client that is not looking at the tree has no use for it.
 *   * everything else is a reply, carrying the id of the frame it answers, and
 *     goes to the one client that asked. A refusal in particular is never
 *     broadcast: the other clients did not ask, and nothing about the world
 *     changed because one of them was told no.
 *
 * Terminal frames are the third kind, and they break the second rule on
 * purpose: `terminal-output` is unsolicited like `machine-state` but goes to
 * the clients watching that session rather than to all of them, because a
 * client that is not looking at a terminal has no use for its bytes. They are
 * defined in `terminal.ts`, written once for both legs and instantiated here
 * with this leg's start handle -- a terminal frame is relayed, not answered,
 * and one definition for both legs is what keeps the relay from being two
 * shapes that drift. On this leg a start handle is the client's own
 * `session-start` frame id; see `terminal.ts` for why the server leg's is not.
 *
 * `session-subscription-ended` is the one exception on that list and is
 * written for this leg alone, because it is not relayed from anywhere: it is
 * what the hub says about a subscription it was holding when the machine
 * feeding it went away, which is precisely the moment there is nothing on the
 * other leg to pass through.
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
   * Asks the hub to pause a session at its next turn boundary, or to resume
   * one it paused. Neither kills anything; `session.ts` carries the argument.
   * Addressed like a stop, routed like a stop, and answered by the holder.
   */
  z.object({
    type: z.literal('session-pause'),
    id: frameIdSchema,
    storeId: storeIdSchema,
    sessionId: sessionIdSchema,
  }),
  z.object({
    type: z.literal('session-resume'),
    id: frameIdSchema,
    storeId: storeIdSchema,
    sessionId: sessionIdSchema,
  }),
  /**
   * Asks the hub for the tail of one session's transcript, as activities.
   *
   * It addresses `{ storeId, sessionId }` and nothing else, like a stop: which
   * machine holds the file and which provider wrote it are the hub's rows to
   * read, and a client that could name either would be a client choosing where
   * a read lands. What comes back is the vocabulary of `activity.ts` and never
   * transcript lines -- the provider's format is parsed on the machine that has
   * the file, so a browser never sees a prompt, a tool's output or anything
   * else a transcript happens to contain.
   *
   * `count` is a bound the asker sets, capped by `transcript.ts`, because the
   * hub holds no copy to page through: the whole answer comes back in one frame
   * or a refusal does, and the frame has to fit the socket. The answer says
   * whether there is more behind it rather than offering a cursor into a file
   * another process is still appending to.
   *
   * Nothing is stored anywhere as a result of this. A transcript is a fact
   * about a file on one machine, and the hub relays it without keeping a copy,
   * which is the same rule a document read follows.
   */
  z.object({
    type: z.literal('session-transcript'),
    id: frameIdSchema,
    storeId: storeIdSchema,
    sessionId: sessionIdSchema,
    count: transcriptCountSchema,
  }),
  /**
   * Says the prompt this session is sitting on has been seen.
   *
   * It carries no timestamp, and that is the frame's whole design. The hub
   * records the session's own `updatedAt` as it sees it at that moment, which
   * is a number a *provider* wrote and therefore one the next such number can
   * honestly be compared with. Neither the client's clock nor the hub's comes
   * into it: a client-supplied value would be a claim about a clock nothing
   * here can check, and a hub-stamped one would put the hub's clock on one
   * side of a comparison whose other side is a provider's.
   *
   * It addresses `{ storeId, sessionId }` like a stop, and unlike a stop it
   * reaches no machine at all: an acknowledgement is a row in this hub's
   * database about a session, and nothing on any server learns it happened.
   * A session this hub has never heard of is refused rather than recorded --
   * not because a stray row would hurt, but because an acknowledgement of
   * something nobody can see has nothing to be spent against, and a table that
   * accepted any pair of strings is a table a client can grow without bound.
   */
  z.object({
    type: z.literal('session-acknowledge'),
    id: frameIdSchema,
    storeId: storeIdSchema,
    sessionId: sessionIdSchema,
  }),
  /**
   * Mutes a session, or unmutes it.
   *
   * One frame with a boolean rather than two, because mute and unmute are one
   * setting written twice and not two acts: the client sends the state it
   * wants, so a second click on a muted row cannot be mistaken for a toggle
   * against a value the client and the hub had drifted apart on. The hub
   * stamps the moment off its own clock, which it may do here and not above
   * because a mute is compared with nothing -- it says since when.
   *
   * What mute does not do is anywhere near this frame: the row goes on being
   * sent, with its status and its place, and the quieting happens in the
   * client and in whatever pushes. A frame that could stop a session being
   * reported would be a frame that hides work from the person who muted it.
   */
  z.object({
    type: z.literal('session-mute'),
    id: frameIdSchema,
    storeId: storeIdSchema,
    sessionId: sessionIdSchema,
    muted: z.boolean(),
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
  clientTerminalFrames.subscribe,
  clientTerminalFrames.unsubscribe,
  clientTerminalFrames.input,
  clientTerminalFrames.resize,
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
   * Makes a folder: a container the user names, and the only node kind a
   * client can bring into existence out of nothing.
   *
   * Everything else in the tree is a node for something that already exists --
   * a session on a disk, a project that is a directory -- and this is the one
   * that is nothing but the arrangement. Which is why it is also the only kind
   * a removal can take away for good: discovery can put a session back and
   * nothing on any disk describes a folder.
   *
   * `parentId` is `null` for the root, which is not a node and has no id. See
   * migration 0004 for why there is no row for it to name.
   */
  z.object({
    type: z.literal('node-create-folder'),
    id: frameIdSchema,
    parentId: nodeIdSchema.nullable(),
    name: nodeNameTextSchema,
  }),
  /**
   * Renames a node -- a folder, a session, or a project -- and nothing else
   * about it.
   *
   * One frame for all three kinds, and the project-scoped frame AGX-133 added
   * beside it is gone rather than kept. The two carried the same three fields
   * and were answered by the same `node-renamed`; what the project one added
   * was a refusal when the id named something that was not a project, and that
   * refusal protects nobody. A client sending an id meant to rename *that
   * node*, and this renames it. What a second frame would have cost is a
   * second way to say one thing, and -- once the tree's own context menu is
   * what renames a project -- a frame with no sender left in the codebase.
   *
   * A project's directory is not here and never will be. It is what the
   * project *is* -- the sessions under it are the ones reported from it, and
   * the file store on the server is keyed by it -- so changing it would not be
   * an edit to a project but a different project wearing the old one's
   * children. Making another is the honest way to say that.
   *
   * The rename is permanent in one further sense: it sets the node's name
   * source to the user, and discovery stops following the transcript's title
   * from then on. A name that lapsed the next time a provider retitled
   * something would be an edit the user watched get undone.
   */
  z.object({
    type: z.literal('node-rename'),
    id: frameIdSchema,
    nodeId: nodeIdSchema,
    name: nodeNameTextSchema,
  }),
  /**
   * Moves a node to a place among a parent's children.
   *
   * `position` is where among the new siblings, counted with the node itself
   * taken out. It is clamped rather than refused: a client that computed an
   * index against a tree that has since changed asked for something reasonable,
   * and refusing it would leave a client one frame out of date unable to move
   * anything.
   *
   * Three things are refused, and each is a state the tree has no reading of:
   * a parent that cannot hold children, a move that would put a node inside
   * its own subtree, and a project landing under another project. The last is
   * not tidiness -- a session is filed under the project whose directory its
   * `cwd` is, and "the project" has to be a definite article.
   */
  z.object({
    type: z.literal('node-move'),
    id: frameIdSchema,
    nodeId: nodeIdSchema,
    parentId: nodeIdSchema.nullable(),
    position: z.int().nonnegative(),
  }),
  /**
   * Takes a node out of the tree, with everything under it.
   *
   * It removes the node and nothing else. No transcript is deleted, no
   * directory is touched, and no frame goes to any server: a tree is the
   * user's arrangement of their own screen, and removing something from an
   * arrangement has never meant deleting the thing.
   *
   * Refused while any session in the subtree has a live holder, and the
   * refusal carries that holder. Removing a session somebody is watching run
   * would leave a process going with nothing on screen pointing at it; naming
   * the holder is what lets the client offer the stop that clears the way.
   *
   * What it does do is remember. Discovery would otherwise see the session on
   * the next scan and put the node straight back, so the removal of every
   * session in the subtree is recorded -- and `node-forget-removal` is how
   * that is undone.
   */
  z.object({
    type: z.literal('node-remove'),
    id: frameIdSchema,
    nodeId: nodeIdSchema,
  }),
  /**
   * Forgets that a session was removed, so discovery may place it again.
   *
   * Keyed by the session and not by a node id, and it has to be: the node is
   * gone, so an id naming it would name nothing. `{ storeId, sessionId }` is a
   * session's identity everywhere in this protocol, and never the machine.
   */
  z.object({
    type: z.literal('node-forget-removal'),
    id: frameIdSchema,
    storeId: storeIdSchema,
    sessionId: sessionIdSchema,
  }),
  /**
   * Asks for part of the catalogue: shaped, filtered, sorted and paged.
   *
   * The frame that makes sorting and paging the hub's rather than the client's,
   * which is decision 4 of the design. `layout-request` above still answers the
   * whole tree and is still the right frame for a screen drawing an arrangement
   * somebody made by hand; this is the one a screen with a few hundred sessions
   * on it asks, and the difference is that the hub decides the order.
   *
   * That is the point rather than an optimisation. Two clients sorting one set
   * of rows by their own rules is how two screens come to disagree about one
   * catalogue, and neither of them nor the hub can say which is right. Here
   * there is one sort, it happens once, and the cursor is a position in it.
   *
   * Every parameter is a closed set or a bound: a view, a grouping, a sort key,
   * a filter of ids and enums, and a limit the hub clamps. Nothing here is a
   * column name, an expression or an ordering clause -- a query frame that
   * carried one would be the generic surface the rule about argv and env vars
   * exists to keep shut, in another direction.
   *
   * `cursor` is `null` for the first page and otherwise a string this hub
   * handed out. It is refused when it was minted before a change to the tree:
   * `catalogue-changed` has already told this client the version moved, and a
   * page resumed across a change would skip or repeat rows without saying so.
   */
  z.object({
    type: z.literal('catalogue-query'),
    id: frameIdSchema,
    view: catalogueViewSchema,
    groupBy: catalogueGroupBySchema,
    sort: catalogueSortSchema,
    filter: catalogueFilterSchema,
    cursor: catalogueCursorSchema.nullable(),
    limit: z.int().positive(),
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
   * There is no `doc-remove` and no `doc-rename` here. Both are `node-remove`
   * and `node-rename` above, over the node a document is, and minting a second
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
  /**
   * Answers an approval the agent is blocked on: let it through, or refuse it.
   *
   * The session is named because a client names a session and the hub resolves
   * which machine holds it -- the rule a stop follows. The approval is named
   * beside it because a session can have more than one open at a time, and
   * because the id is what deciding once keys on: two clients tapping at the
   * same moment send the same id, and the second one is told what the first
   * one's answer did rather than being applied on top of it.
   *
   * `decision` is two words and there is nowhere to put a third thing. No
   * proposal comes back -- the text a client rendered is the hub's to
   * remember, and a client returning it would be a client choosing what the
   * agent runs -- and no message either: the sentence a denied agent reads is
   * composed on the machine that answers the hook.
   */
  z.object({
    type: z.literal('approval-decide'),
    id: frameIdSchema,
    storeId: storeIdSchema,
    sessionId: sessionIdSchema,
    approvalId: approvalIdSchema,
    decision: approvalDecisionSchema,
  }),
  /**
   * Asks to be told about a needs-you edge when nobody is looking at the page.
   *
   * It carries the browser's own subscription and nothing else, parsed by
   * `push.ts` -- the same schema the hub parses its rows off disk with, so a
   * subscription is one shape from the browser to the table and there is no
   * second spelling of it to drift apart from the first.
   *
   * What it cannot say is the point of it, and it is the point `session-start`
   * makes in the other direction. A subscriber does not choose what a
   * notification says: there is no title here, no directory, no branch and no
   * text, because a payload is built from an edge the hub saw rather than from
   * anything a client asked for. The endpoint is an address this hub will
   * later POST to, which is why the schema is strict about it -- https only, a
   * host, no credentials, bounded -- and why it is branded, so that nothing
   * can be stored or sent to without having come through the parser.
   *
   * The answer is `push-subscribed`, or the ordinary refusal when this hub has
   * no key pair to be subscribed against.
   *
   * The endpoint is parsed here rather than merely bounded, which is the
   * opposite of what `server-pair` does above, and the difference is who typed
   * it. A pairing address is typed by a person, so a strict schema would turn
   * a typo into a `protocol-error` and a closed socket instead of a sentence
   * they can read. A subscription is produced by `PushManager.subscribe` and
   * never by a human, so one that is not a subscription is a broken client and
   * not a mistake somebody made -- and the parser is the right place to stop
   * it, before anything can be stored that nothing could ever be sent to.
   */
  z.object({
    type: z.literal('push-subscribe'),
    id: frameIdSchema,
    subscription: pushSubscriptionSchema,
  }),
  /**
   * Stops the pushes to one browser, naming the endpoint.
   *
   * The endpoint and not a handle the hub minted, because the endpoint *is*
   * the subscription: it is what the browser holds, what it can produce again
   * after a reload, and the row's own key. A hub-minted id would be a second
   * name for one thing, kept in the one place that has usually lost it by the
   * time somebody wants to be left alone.
   */
  z.object({
    type: z.literal('push-unsubscribe'),
    id: frameIdSchema,
    endpoint: pushEndpointSchema,
  }),
  /**
   * Asks for a project's standing policy: every rule it holds, whole.
   *
   * A project and never a session, which is the decision the policy exists to
   * carry -- a rule is a statement about a body of work, and a per-session one
   * would have to be written again every afternoon, while somebody stared at a
   * blocked agent and wanted it to continue. The project is named by its node
   * id for the reason a start names one: the client names a row, and the hub
   * turns it into whatever it is on disk.
   *
   * It carries no cursor and no filter. A policy is answered whole or not at
   * all -- see `APPROVAL_POLICY_RULES_MAX` -- because a screen showing half a
   * policy is a screen saying a request will be asked about when it will not.
   */
  z.object({
    type: z.literal('approval-policy-list'),
    id: frameIdSchema,
    projectId: nodeIdSchema,
  }),
  /**
   * Writes one rule into a project's policy: stop asking about exactly this.
   *
   * The rule crosses as the protocol's own `approvalPolicyRule`, which bounds
   * it, and the hub then puts it through `parseApprovalPolicyRule`, which is
   * what can refuse it with a sentence. Both, and in that order: the schema is
   * what makes the frame parse at all, and the parser is what tells the person
   * who typed it why a rule with no tool is not one. A refusal here is the
   * ordinary `refusal` frame, correlated by `replyTo`, because the sentence is
   * for the client that asked and for nobody else.
   *
   * The rule is display text compared for equality. It is never executed, never
   * spliced into a command line, and never reaches a spawn -- what it matches
   * is a proposal, which is itself text derived from a tool input and not that
   * input. So this frame does not carry an operation name or an argv element,
   * although a person reading it will recognise one: what it carries is the
   * string that appeared above the button they would otherwise tap.
   */
  z.object({
    type: z.literal('approval-policy-add'),
    id: frameIdSchema,
    projectId: nodeIdSchema,
    rule: approvalPolicyRuleSchema,
  }),
  /**
   * Takes one rule out of a project's policy: ask me about this again.
   *
   * It names the rule by the id the hub minted and the project the rule is in.
   * The project is not redundant: it is what makes the removal answerable with
   * that project's remaining rules, and it is what scopes the delete, so a
   * client holding a stale id cannot reach into a policy it was not looking at.
   */
  z.object({
    type: z.literal('approval-policy-remove'),
    id: frameIdSchema,
    projectId: nodeIdSchema,
    ruleId: approvalPolicyRuleIdSchema,
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
    /**
     * The VAPID public key a browser must subscribe against, or `null` when
     * this hub has none.
     *
     * On the welcome because it is a fact about the hub that a client needs
     * before it can ask for anything: a subscription is minted in the browser
     * *with* this key, so a control that offered to turn push on before
     * knowing it would be a control that cannot work. It costs one field on a
     * frame every connection already sends, where a route for it would be a
     * second authenticated surface answering one string.
     *
     * `null` and never the empty string, because "this hub cannot push" is a
     * real state -- no key pair could be minted, or the composition root gave
     * it no way to send -- and a plain reading of the field must not be able
     * to miss it. A client that reads `null` stays on the in-page attention
     * floor, which is what everybody relies on anyway.
     *
     * The public half only. The private half is on no interface, in no log
     * line and in no frame; see the hub's push feature for why a getter for it
     * would be a key somebody eventually reads for a second purpose.
     */
    pushPublicKey: pushKeySchema.nullable(),
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
   * The pause was taken, and how far it got -- `paused` at once, or `requested`
   * until the turn ends. A receipt to the asker; every other client learns it
   * from the holder on the next machine state, which is the one place any of
   * them reads a pause from.
   */
  z.object({
    type: z.literal('session-paused'),
    replyTo: frameIdSchema,
    storeId: storeIdSchema,
    sessionId: sessionIdSchema,
    server: serverRegistrationIdSchema,
    pause: sessionPauseSchema,
  }),
  /** The session takes input again. */
  z.object({
    type: z.literal('session-resumed'),
    replyTo: frameIdSchema,
    storeId: storeIdSchema,
    sessionId: sessionIdSchema,
    server: serverRegistrationIdSchema,
  }),
  /**
   * What the hub now records about one session's attention, after an
   * acknowledgement or a mute.
   *
   * One reply to two frames, carrying the whole of the row rather than the
   * field that moved. An acknowledgement and a mute write the same two-column
   * row, and two partial answers would leave the client merging them --
   * which is a second copy of a state the next `machine-state` is about to
   * state in full anyway.
   *
   * It is a reply and not a broadcast, like every other yes on this direction.
   * The change itself reaches the other clients where every change does: on
   * the session row of the next machine state, which is the one place any of
   * them reads attention from. So this frame is a receipt -- it tells the
   * client that asked that its frame was answered, and the button that sent it
   * stops waiting.
   */
  z.object({
    type: z.literal('session-attention'),
    replyTo: frameIdSchema,
    storeId: storeIdSchema,
    sessionId: sessionIdSchema,
    acknowledgedThrough: z.int().nonnegative().nullable(),
    mutedAt: z.int().nonnegative().nullable(),
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
  clientTerminalFrames.subscribed,
  clientTerminalFrames.unsubscribed,
  clientTerminalFrames.output,
  /**
   * The fourth terminal frame, and the only one with no counterpart on the
   * server leg: a subscription stopped feeding a pane, and the hub is the one
   * end that can say so. `terminal.ts` carries the argument.
   */
  subscriptionEndedFrameSchema,
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
   * The folder exists, and this is the node it is.
   *
   * The id is carried for the reason `project-created` carries one: it is the
   * one thing the client cannot work out for itself, and a client that had to
   * find its own folder back out of the next tree by name would be matching on
   * the one field the user is free to change.
   */
  z.object({
    type: z.literal('node-created'),
    replyTo: frameIdSchema,
    nodeId: nodeIdSchema,
  }),
  /**
   * The node is now called what was asked, and there is nothing else to say.
   *
   * It carries no name, because the client sent it and the hub stored exactly
   * that; and no kind, because a rename is one act on the tree whatever the
   * node is -- a folder, a session, or a project. It is named for the act and
   * not for the caller, which is what let the project-scoped rename frame be
   * deleted rather than kept beside it.
   */
  z.object({
    type: z.literal('node-renamed'),
    replyTo: frameIdSchema,
  }),
  /**
   * The node is where it was asked to go. Nothing to carry: the client named
   * the parent and the position, and a clamped position is a detail of the
   * tree the next layout answers for.
   */
  z.object({
    type: z.literal('node-moved'),
    replyTo: frameIdSchema,
  }),
  /** The node is out of the tree, with everything that was under it. */
  z.object({
    type: z.literal('node-removed'),
    replyTo: frameIdSchema,
  }),
  /**
   * That removal is forgotten. The session is placed again by the discovery
   * pass the hub runs on the way to answering this, so the layout a client
   * asks for next already holds it.
   */
  z.object({
    type: z.literal('node-removal-forgotten'),
    replyTo: frameIdSchema,
  }),
  /**
   * The tree changed. No `replyTo`, because it is nobody's reply.
   *
   * Unsolicited and broadcast, like `machine-state` and unlike `layout` -- and
   * the difference between this and the layout is exactly why it carries a
   * version and no nodes. A layout is one person's arrangement and is answered
   * to the client that asked; what changed about the tree is one shared fact,
   * and every client that is looking at the tree needs to know that what it is
   * holding is old. So the hub says that much to everybody, and each client
   * asks for the layout again if it is drawing one. A client that is not
   * looking at a tree does nothing and costs nothing.
   *
   * The version is monotonic and is the hub's own counter, not a row anywhere.
   * It exists so a client can tell a change it has already followed from one
   * it has not, and it has no delta form: what a client would do with an edit
   * to a tree it may be several versions behind on is the question this whole
   * protocol answers by sending things whole.
   *
   * It follows every mutation, and also a discovery pass that actually changed
   * something -- a session that appeared, a title that moved, a node the prune
   * took. The frame names the catalogue and not the client's own edit, and a
   * tree that quietly fell behind the fleet would be the same stale screen as
   * one that fell behind a rename.
   */
  z.object({
    type: z.literal('catalogue-changed'),
    version: z.int().nonnegative(),
  }),
  /**
   * One page of the catalogue, answered to the client that asked.
   *
   * A reply and never a broadcast, for the reason a layout is one: what one
   * person is looking at, sorted the way they asked for it, is not a fact about
   * the fleet.
   *
   * `total` is the count before paging -- after the filter and the search, and
   * before the limit -- so that a client can say "12 of 340" rather than
   * "12 so far". A client that had to page to the end to count would be asking
   * for the whole tree to avoid asking for the whole tree.
   *
   * `version` is the catalogue version this page was computed at, and it is the
   * same number `catalogue-changed` carries. That is what lets a client tell a
   * page from before a change from one from after it, and it is what the
   * cursor is pinned to: the hub refuses a cursor minted at an older version
   * rather than resuming into an order that has moved underneath it.
   *
   * `nextCursor` is `null` when this page is the last one. It is not "no more
   * for now": a page that ends the answer says so, and a client that got one
   * stops rather than polling for a page that will never arrive.
   */
  z.object({
    type: z.literal('catalogue-page'),
    replyTo: frameIdSchema,
    items: z.array(catalogueItemSchema),
    nextCursor: catalogueCursorSchema.nullable(),
    total: z.int().nonnegative(),
    version: z.int().nonnegative(),
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
  /**
   * What became of the approval this client answered.
   *
   * A receipt, and it is about the request rather than about the click. Four
   * outcomes, because four things can have happened and a client draws each
   * differently: the answer was applied (`granted`, `denied`) -- possibly
   * somebody else's answer, which is what deciding once means and why this
   * carries no "you won" -- or the agent had already taken the question back
   * (`withdrawn`), or nothing could be applied any more because the blocked
   * hook had stopped waiting (`expired`). A client answering a request it had
   * missed the withdrawal of is told the truth rather than a success.
   *
   * A reply and never a broadcast, like every other yes on this direction. The
   * change itself reaches every client where every change does: the approval
   * leaves the session row of the next machine state, which is the one place
   * any of them reads what is pending.
   *
   * It carries no approval id. The client named it, the id is spent the moment
   * the request ends, and restating it would be a second copy of what was
   * asked -- `replyTo` already says which question this answers.
   *
   * `answeredBy` is the one thing it adds to the word: the standing rule whose
   * grant took effect, or `null` for a request a person answered. It is on this
   * frame rather than on a second one because this frame is already what says
   * what became of the request, and an outcome that arrived separately from the
   * reason for it would be two things a client had to join. A person who tapped
   * Allow a moment after a rule did is told `granted` here either way; without
   * the rule beside it they would have no way to tell their own tap from one
   * that never counted.
   */
  z.object({
    type: z.literal('approval-decided'),
    replyTo: frameIdSchema,
    outcome: approvalOutcomeSchema,
    answeredBy: approvalAnsweredBySchema.nullable(),
  }),
  /**
   * One project's standing policy, whole, answered to the client that asked.
   *
   * The same frame answers all three questions -- list it, add to it, take one
   * out -- because all three end with the same fact, and a client that had to
   * apply an add to its own copy would be a client holding a policy nobody
   * vouched for. It is the rule this codebase follows for the machine state,
   * applied to something small enough that applying it costs nothing.
   *
   * A reply and never a broadcast. A policy is a fact about the fleet, not a
   * private arrangement like a layout, but the client that is looking at one
   * asked for it, and pushing every project's policy at every tab would be
   * sending most of them something nothing on their screen reads. The hub
   * answers the change to whoever made it; a client looking at the same policy
   * elsewhere re-asks, exactly as it does after `catalogue-changed`.
   *
   * `projectId` is carried although `replyTo` identifies the request, because a
   * client holding several policies files the answer by project and should not
   * have to remember which of its own frames asked about which.
   */
  z.object({
    type: z.literal('approval-policy'),
    replyTo: frameIdSchema,
    projectId: nodeIdSchema,
    rules: z.array(approvalPolicyRecordSchema).max(APPROVAL_POLICY_RULES_MAX),
  }),
  /**
   * The browser is subscribed, and will be told the next time something wants
   * a human while nobody is looking.
   *
   * Nothing to carry. The client sent the subscription and already has it, and
   * the endpoint is its own key on both ends -- an answer that echoed it back
   * would be a second copy of what the request said. It is a receipt, like
   * `session-attention`: the control that asked stops waiting.
   *
   * There is no frame here for what the hub later sends. A push does not
   * travel on this socket -- that is the whole point of it -- and a client
   * that was on the socket to read one would be a client that did not need the
   * push.
   */
  z.object({
    type: z.literal('push-subscribed'),
    replyTo: frameIdSchema,
  }),
  /**
   * That endpoint is forgotten, whether or not there was a row for it.
   *
   * The same yes for both, deliberately: "there was nothing stored" and "there
   * was, and now there is not" leave the browser in one state, and a client
   * that had to tell them apart would be reading a difference it cannot act
   * on.
   */
  z.object({
    type: z.literal('push-unsubscribed'),
    replyTo: frameIdSchema,
  }),
  /**
   * What that session did, oldest first, relayed from the machine that holds
   * the transcript.
   *
   * The same name and the same two fields as the server leg's answer, because
   * it is the same answer relayed: the hub parses the activities once, keeps
   * none of them and rewrites nothing, so a second shape here would be a second
   * thing to keep in step for no gain. `doc-content` on this direction makes
   * the same argument.
   *
   * It carries no store and no session. `replyTo` is the whole of the
   * correlation, as it is for every other reply on this direction, and a client
   * that has two panes open holds the frame id each of them asked with. A frame
   * that restated the address would invite a client to draw an answer against a
   * session it did not ask about.
   *
   * A refusal travels as `refusal` with `holder: null`, like every other no
   * here: an unreachable machine, a session the hub cannot see and a transcript
   * that would not be read are all sentences a client shows beside the tab.
   */
  z.object({
    type: z.literal('session-transcript-read'),
    replyTo: frameIdSchema,
    activities: transcriptActivitiesSchema,
    olderExist: z.boolean(),
  }),
  protocolErrorFrameSchema,
]);
export type HubFrame = z.infer<typeof hubFrameSchema>;

/** The one parser for everything the hub reads from a client. */
export const parseClientFrame = frameParser(clientFrameSchema);

/** The one parser for everything a client reads from the hub. */
export const parseHubFrame = frameParser(hubFrameSchema);
