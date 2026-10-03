import { z } from 'zod';
import {
  approvalDecisionSchema,
  approvalIdSchema,
  approvalPolicyRuleIdSchema,
  approvalPolicyRuleSchema,
  approvalSubjectSchema,
} from './approval.js';
import { catalogueQuerySchema } from './catalogue.js';
import { directorySchema } from './directory.js';
import { docContentSchema, docNameSchema } from './doc.js';
import { frameIdSchema, protocolErrorFrameSchema } from './frames.js';
import { graphDocumentSchema, graphNameSchema } from './graph.js';
import { graphRunIdSchema } from './graph-run.js';
import {
  nodeIdSchema,
  providerSchema,
  serverRegistrationIdSchema,
  sessionIdSchema,
  storeIdSchema,
} from './identity.js';
import { nodeNameTextSchema } from './layout.js';
import {
  SERVER_ADDRESS_MAX_CHARS,
  SERVER_LABEL_MAX_CHARS,
  SERVER_TOKEN_MAX_CHARS,
} from './pairing.js';
import { frameParser } from './parse.js';
import { pushEndpointSchema, pushSubscriptionSchema } from './push.js';
import { routeInputSchema } from './route-condition.js';
import { clientTerminalFrames } from './terminal.js';
import { transcriptCountSchema } from './transcript.js';
import { paneLayoutTextSchema } from './pane-layout.js';

/**
 * The client-facing half of the protocol, one direction: browser (or MCP
 * caller) to hub. What the hub sends back, and why its frames come in the
 * kinds they do, is `hub-to-client.ts`. The terminal frames here are
 * instantiated from `terminal.ts` with this leg's start handle, as the other
 * direction's are.
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
   * `paneLayoutTextSchema` in `pane-layout.ts`), so this frame changes when the bound
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
     * The project to start in, or `null` for the home directory of the account
     * the server runs as. `HOME_PROJECT_ID` starts there too: HOME is a project
     * with no directory, so a start in it carries none, as `null` does.
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
     * `null` and HOME both reach the server with no directory, and the server
     * spawns in the home directory of the account it runs as. Both remain,
     * because a session that belongs to no other project is the ordinary case
     * and not a degraded one, and both end in HOME: discovery files a session
     * with no other project there.
     *
     * A resume that names a project, HOME included, is refused: a session
     * resumes in the directory its own transcript recorded, so a project on a
     * resume would be a second directory nobody may choose.
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
   *
   * The fields are `catalogueQuerySchema`'s, spread rather than restated. A
   * restatement is a second list that a field added to the query can be missing
   * from, and the frame would then strip on the wire what the type says a
   * client sent.
   */
  z.object({
    type: z.literal('catalogue-query'),
    id: frameIdSchema,
    ...catalogueQuerySchema.shape,
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
   * Makes a graph in a project: a node in the tree, and an empty draft.
   *
   * `projectId` is a node id for the reason a document's is: the client names
   * a row and the hub decides where under it the node goes. There is no
   * `server` here, unlike a document, because a graph is not a file on any
   * machine -- the hub holds the document and runs the graph, and which
   * machine each step lands on is the node's own `placement` to say.
   *
   * No document travels with the create. A graph starts empty and the canvas
   * fills it in with saves, so a create that carried one would be a second
   * path a document can arrive by.
   */
  z.object({
    type: z.literal('graph-create'),
    id: frameIdSchema,
    projectId: nodeIdSchema,
    name: graphNameSchema,
  }),
  /**
   * Reads a graph back: its name, its draft, and which versions are published.
   *
   * The node is the whole address, as it is for a document. What comes back
   * is the draft and never a published version -- a published version is
   * immutable, so the canvas has nothing to edit in one, and a runtime that
   * wants one reads it in the hub, where it lives.
   */
  z.object({
    type: z.literal('graph-open'),
    id: frameIdSchema,
    nodeId: nodeIdSchema,
  }),
  /**
   * Replaces the draft, whole.
   *
   * The document is parsed here, at the wire, by the same schema the hub
   * reads a stored one with: an edge to a node that is not there, a route
   * whose condition does not parse, a kind this build has never heard of are
   * all refusals before anything is written. There is no patch form, for the
   * reason a document has none -- the draft is what the last save put there,
   * and no version the hub never saw whole can be half-applied.
   */
  z.object({
    type: z.literal('graph-save'),
    id: frameIdSchema,
    nodeId: nodeIdSchema,
    document: graphDocumentSchema,
  }),
  /**
   * Stamps the draft as the next published version and opens a new draft
   * copying it.
   *
   * It carries no document: what is published is the draft as the hub holds
   * it, so a client publishes what it last saved and never something it did
   * not first write. A draft that cannot run -- no TRIGGER, an ACTION nothing
   * on this build performs, a SUB-GRAPH pinned to a version nobody published
   * -- is refused in words, and the draft is left as it was.
   */
  z.object({
    type: z.literal('graph-publish'),
    id: frameIdSchema,
    nodeId: nodeIdSchema,
  }),
  /**
   * Runs the graph's latest published version with this input.
   *
   * The node is the whole address and the version is not named: what runs is
   * the newest thing that was published, because a run is a person pressing
   * Run on the screen they are looking at, and the draft is the one thing
   * that may never run. The input is the object the first ROUTER's conditions
   * read, bounded by the same schema those conditions evaluate against, and
   * it is the run's whole payload -- no frame here names a store, a machine or
   * a directory, because every one of those is the graph's own to decide, per
   * node, at the step that needs it.
   */
  z.object({
    type: z.literal('graph-run'),
    id: frameIdSchema,
    nodeId: nodeIdSchema,
    input: routeInputSchema,
  }),
  /**
   * Stops a run before its next step.
   *
   * Named by the run and not by the graph, because two runs of one graph can
   * be in flight and a cancel that named the graph would be a coin toss. The
   * step in flight is left to end on its own: an agent mid-turn is not
   * interrupted, for the reason a stop refuses a busy holder.
   */
  z.object({
    type: z.literal('graph-run-cancel'),
    id: frameIdSchema,
    runId: graphRunIdSchema,
  }),
  /**
   * Asks where the graph's latest run stands.
   *
   * A run's states arrive unsolicited only while a socket is up; a screen
   * whose socket dropped holds the run where it was when the connection went,
   * and the hub sends nothing about a run that ended meanwhile. So a screen
   * asks, on open and on every reconnection, and is answered with
   * `graph-run-latest`: the newest run of that graph, or `null` when the
   * graph has never run. Sending it also marks this connection as watching
   * that graph, which is what run states are fanned out by.
   */
  z.object({
    type: z.literal('graph-run-read'),
    id: frameIdSchema,
    nodeId: nodeIdSchema,
  }),
  /**
   * Asks for the graph's runs, newest first, as the history list draws them.
   *
   * A reply to the asking client alone, like `layout-request`: a list is what
   * one screen asked to look at, and a new run reaches every watching screen
   * as a state already. The answer is summaries only and at most
   * `GRAPH_RUN_HISTORY_MAX` of them. Sending it marks this connection as
   * watching the graph, as `graph-run-read` does, so the screen that asked is
   * told when a run moves and knows to ask again when one ends.
   */
  z.object({
    type: z.literal('graph-run-history-request'),
    id: frameIdSchema,
    nodeId: nodeIdSchema,
  }),
  /**
   * Asks for one run of the graph, whole: the row a person picked in the
   * history list, for the strip and LAST OUTPUT to read.
   *
   * Named by the run and by its graph. The run is the address; the graph is
   * what this connection watches from then on, and what the hub checks the
   * run against, so that a screen open on one graph is never handed another
   * graph's run to draw as its own. Answered by `graph-run-latest`, addressed
   * to this frame and carrying the run -- the read's answer, reused because an
   * unaddressed `graph-run-state` would leave the open pending on the client --
   * or refused when the graph has no such run.
   */
  z.object({
    type: z.literal('graph-run-open'),
    id: frameIdSchema,
    nodeId: nodeIdSchema,
    runId: graphRunIdSchema,
  }),
  /**
   * Walks the graph's draft without doing anything, and asks what a run of
   * it would do.
   *
   * The draft and not a published version, because the point is to check a
   * graph before it is published: the routes, the placement, the waits. The
   * input is what a run would be started with, parsed by the same bounded
   * schema, and the answer is `graph-simulated` to this client alone. No run
   * is numbered, no session starts and nothing is written, so there is
   * nothing to watch: sending this does not mark the graph watched.
   */
  z.object({
    type: z.literal('graph-simulate'),
    id: frameIdSchema,
    nodeId: nodeIdSchema,
    input: routeInputSchema,
  }),
  /**
   * Answers an approval: let it through, or refuse it.
   *
   * The subject is named because a client names what it answers and the hub
   * resolves who holds it -- for a session, which machine, the rule a stop
   * follows; for a graph run, the hub itself, which minted the request when
   * the run reached a HUMAN node. The approval is named beside it because a
   * subject can have more than one open at a time, and because the id is what
   * deciding once keys on: two clients tapping at the same moment send the
   * same id, and the second one is told what the first one's answer did
   * rather than being applied on top of it.
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
    subject: approvalSubjectSchema,
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

/** The one parser for everything the hub reads from a client. */
export const parseClientFrame = frameParser(clientFrameSchema);
