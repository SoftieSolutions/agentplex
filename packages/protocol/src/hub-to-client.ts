import { z } from 'zod';
import {
  APPROVAL_POLICY_RULES_MAX,
  approvalAnsweredBySchema,
  approvalOutcomeSchema,
  approvalPolicyRecordSchema,
} from './approval.js';
import { catalogueCursorSchema, catalogueItemSchema } from './catalogue.js';
import { directoryListingFrameSchema } from './directory.js';
import { docContentSchema } from './doc.js';
import { frameIdSchema, protocolErrorFrameSchema, refusalCodeSchema } from './frames.js';
import { graphDocumentSchema, graphPublishedVersionSchema } from './graph.js';
import {
  GRAPH_RUN_HISTORY_MAX,
  GRAPH_RUN_OUTPUT_MAX_CHARS,
  GRAPH_RUN_STEPS_MAX,
  graphRunIdSchema,
  graphRunStateSchema,
  graphRunSummarySchema,
  graphSimulatedStepSchema,
} from './graph-run.js';
import {
  hubIdSchema,
  nodeIdSchema,
  serverRegistrationIdSchema,
  sessionIdSchema,
  storeIdSchema,
} from './identity.js';
import { layoutSchema } from './layout.js';
import { machineStateSchema, sessionHolderSchema } from './machine-state.js';
import { pauseTakenSchema } from './session.js';
import { frameParser } from './parse.js';
import { pushKeySchema } from './push.js';
import { clientTerminalFrames, subscriptionEndedFrameSchema } from './terminal.js';
import { transcriptActivitiesSchema } from './transcript.js';
import { paneLayoutTextSchema } from './pane-layout.js';

/**
 * The client-facing half of the protocol, the other direction: hub to browser
 * (or MCP caller). What a client sends is `client-to-hub.ts`.
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
  /**
   * The spawn a start answered with `sessionId: null` now has the id its
   * provider minted.
   *
   * Sent to the page that sent the start, whether or not it ever subscribed:
   * `replyTo` names that start so the client can bind what it asked for to the
   * session it became. It is not a reply to a pending command --
   * `session-started` already answered that -- and a client owes nothing on
   * receipt.
   *
   * The page, not the socket: the hub files a start under the `instance` its
   * hello carried, and sends the naming to whichever socket that instance holds
   * now. A report repeating its starts is not news and sends nothing, but a
   * page that redials is sent the naming of every spawn it made that the hub
   * still holds, again, on the new socket -- a naming the old socket carried
   * may have been lost with it, and the page cannot say which. So a client may
   * be told one start's name more than once and must take a repeat as the same
   * news. `sessionId` is never null: until the report has an id there is
   * nothing to send.
   */
  z.object({
    type: z.literal('session-named'),
    replyTo: frameIdSchema,
    storeId: storeIdSchema,
    sessionId: sessionIdSchema,
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
    pause: pauseTakenSchema,
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
   * The graph was made, and this is the node it will be named by.
   *
   * The same shape as a document's yes, and for the same reason: every later
   * frame about this graph names the node. The tree change itself reaches
   * every client as `catalogue-changed`.
   */
  z.object({
    type: z.literal('graph-created'),
    replyTo: frameIdSchema,
    nodeId: nodeIdSchema,
  }),
  /**
   * A graph, as the canvas needs it: the name, the draft and its number, and
   * which versions have been published.
   *
   * `nodeId` is restated on this reply, unlike a document's content, because
   * the canvas draws a header out of it and the store files the answer by the
   * node as well as by the frame -- a graph open is a screen and not a pane,
   * so there is one of it per node and not one per request. `published` is
   * the numbers and their dates and never the documents: a published version
   * is read where it runs, in the hub, and a client that wanted one to look
   * at would be asking for a screen this ticket does not draw.
   */
  z.object({
    type: z.literal('graph-document'),
    replyTo: frameIdSchema,
    nodeId: nodeIdSchema,
    name: z.string(),
    draftVersion: z.int().positive(),
    document: graphDocumentSchema,
    published: z.array(graphPublishedVersionSchema),
  }),
  /**
   * The draft was replaced. `version` is the draft's number, so a canvas that
   * published between saves can tell which draft this answer is about, and
   * `updatedAt` is the hub's clock -- the hub is the machine that holds a
   * graph, so here its clock is the right one.
   */
  z.object({
    type: z.literal('graph-saved'),
    replyTo: frameIdSchema,
    version: z.int().positive(),
    updatedAt: z.int().nonnegative(),
  }),
  /** The draft became this published version, and the next draft is `version + 1`. */
  z.object({
    type: z.literal('graph-published'),
    replyTo: frameIdSchema,
    version: z.int().positive(),
  }),
  /**
   * The run began, and this is what it is called.
   *
   * Two names, because they answer different questions: `runId` is what every
   * later frame and a cancel file under, and `number` is what a person says --
   * "run 38 broke" -- counted from 1 per graph. The state itself follows as
   * `graph-run-state`, unsolicited, and this reply carries none of it so that
   * there is one shape a run's progress arrives in.
   */
  z.object({
    type: z.literal('graph-run-started'),
    replyTo: frameIdSchema,
    runId: graphRunIdSchema,
    number: z.int().positive(),
  }),
  /**
   * A run, whole, as it stands now.
   *
   * Unsolicited, and sent to every client that has asked about its graph on
   * this connection -- opened it, run it, or read its run -- because a run is
   * one fact about the hub and two tabs open on the graph must read the same
   * step, while a tab open on something else has no use for hundreds of step
   * records. It has no `replyTo` because nobody asked for this particular
   * frame: the client that pressed Run was answered by `graph-run-started`, a
   * `graph-run-read` by `graph-run-latest`, and everything else is the run
   * moving. The fields are `graphRunStateSchema`'s,
   * spread here rather than nested so the frame reads like every other frame
   * on this direction.
   */
  z.object({ type: z.literal('graph-run-state'), ...graphRunStateSchema.shape }),
  /**
   * The answer to a `graph-run-read`: where the graph's newest run stands,
   * or `null` when the graph has never run. It is also the answer to a
   * `graph-run-open`, carrying the run that was opened, never `null` there:
   * a graph with no such run is refused instead.
   *
   * Its own frame rather than a `graph-run-state` with an optional `replyTo`,
   * because every frame on this direction is either an answer, whose
   * `replyTo` is required, or unsolicited, and has none. A state that is
   * sometimes an answer would be the one frame a client has to inspect a
   * field of to know which, and a client that forgot to would leave the read
   * waiting for an answer that had already come -- which is what the first
   * shape of this did. The run is nested rather than spread because it may be
   * absent, and it names the graph again beside it so that the no-run answer
   * still says which graph a screen filing runs by graph should drop.
   */
  z.object({
    type: z.literal('graph-run-latest'),
    replyTo: frameIdSchema,
    nodeId: nodeIdSchema,
    run: graphRunStateSchema.nullable(),
  }),
  /**
   * The graph's runs, newest first, answered to the client that asked.
   *
   * Summaries, never steps, and at most `GRAPH_RUN_HISTORY_MAX`: the newest
   * that many, so a graph run for a year answers in one frame the size of one
   * run's state. It names the graph so a screen files it by the graph, and an
   * empty list is the answer for a graph that has never run -- there is no
   * separate "none" here, because an empty list is already that sentence.
   */
  z.object({
    type: z.literal('graph-run-history'),
    replyTo: frameIdSchema,
    nodeId: nodeIdSchema,
    runs: z.array(graphRunSummarySchema).max(GRAPH_RUN_HISTORY_MAX),
  }),
  /**
   * What a run of the graph's draft would do, node by node, with why.
   *
   * `path` is the walk in order, a SUB-GRAPH's child steps directly after it
   * one depth down, bounded by `GRAPH_RUN_STEPS_MAX` as a run's steps are.
   * `reason` is the sentence the walk stopped on -- a run that would stop at a
   * node, a JOIN one of whose branches would never arrive, a draft with no
   * TRIGGER -- and `null` when every branch reached a node with nowhere to
   * go, which is where a run would succeed. It names the graph so a screen
   * files it by the graph.
   */
  z.object({
    type: z.literal('graph-simulated'),
    replyTo: frameIdSchema,
    nodeId: nodeIdSchema,
    path: z.array(graphSimulatedStepSchema).max(GRAPH_RUN_STEPS_MAX),
    reason: z.string().max(GRAPH_RUN_OUTPUT_MAX_CHARS).nullable(),
  }),
  /**
   * The cancel was taken. The run's end arrives as `graph-run-state` with
   * `cancelled` on it, after whatever step was in flight has ended; this says
   * only that the request reached a run that was still going.
   */
  z.object({
    type: z.literal('graph-run-cancelled'),
    replyTo: frameIdSchema,
    runId: graphRunIdSchema,
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

/** The one parser for everything a client reads from the hub. */
export const parseHubFrame = frameParser(hubFrameSchema);
