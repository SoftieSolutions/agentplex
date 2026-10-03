import type {
  Activity,
  ApprovalPolicyRecord,
  CatalogueItem,
  ClientTerminalTarget,
  FrameId,
  GraphDocument,
  GraphPublishedVersion,
  GraphRunId,
  GraphRunState,
  GraphRunSummary,
  HubId,
  Layout,
  MachineState,
  NodeId,
  Provider,
  RefusalCode,
  ServerRegistrationId,
  SessionHolder,
  SessionId,
  SessionRef,
  StoreId,
  SubscriptionEndReason,
} from '@agentplex/protocol';
import type { ResumeMemories } from './resume-memory.js';
import type { TerminalFeed } from '../terminal/chunk-feed.js';
import type { Answers } from './answers.js';

/**
 * What the hub store publishes, as React reads it: the snapshot and every view
 * on it. Types only; the store that fills them is `hub-store.ts`.
 */

export type ConnectionPhase =
  /** Nothing is looking, so nothing is connected. */
  | 'idle'
  | 'connecting'
  | 'connected'
  /** Down, and either waiting out a backoff delay or mid-redial. */
  | 'reconnecting'
  /**
   * Down for a reason the store will not retry on its own -- a protocol
   * version mismatch, or a frame the hub could not read. A person can
   * (`HubStore.retry`), once one side's build has changed.
   */
  | 'failed';

export interface CommandQueueView {
  readonly queued: number;
  readonly capacity: number;
  /** Words for the user when a command was not accepted, or `null`. */
  readonly overflowed: string | null;
}

export interface TerminalInputView {
  /** Keystrokes discarded since the connection went down. */
  readonly discarded: number;
  /** The sentence to show beside a terminal while keystrokes go nowhere. */
  readonly notice: string | null;
}

/**
 * One watched terminal, as a pane reads it.
 *
 * Everything here is a fact about what the pane is being shown, and there is
 * exactly one thing on it that is not a number: the feed. Bytes go into that
 * and never into a snapshot field — a value that changed on every pty read
 * would re-render the app at output speed, which is the rule this whole path
 * is built around. What the snapshot carries instead is the handful of facts
 * that change rarely and that a pane has to be able to state: whether it is
 * attached, what it is attached to, and how much of the session it is not
 * being shown.
 *
 * ## Three losses, kept apart
 *
 * A pane showing less than everything can be short in three different places,
 * and they are three different things to do about it:
 *
 *   * `droppedBytes` is history the *terminal* evicted before this pane
 *     attached. A property of the session, the same for every viewer, fixed
 *     at the moment of attaching.
 *   * `droppedChunks` is output that existed and did not fit down the link to
 *     *this browser* — both legs, summed by the hub. A property of one
 *     connection, different for two viewers of the same session, growing
 *     while the stream runs.
 *   * `evicted` is this browser's own buffer having thrown away its oldest
 *     chunks. A property of this tab.
 *
 * `protocol/terminal.ts` argues the first two at length and refuses to sum
 * them; this refuses to sum the third for the same reason.
 *
 * ## And the fact that renders identically to all three
 *
 * `replayChunks === 0` with `droppedBytes === 0` says outright that this
 * session has printed nothing. A pane that silently starts mid-stream and a
 * pane showing a session that has done nothing draw the same empty rectangle
 * and mean opposite things, which is why both numbers are here rather than
 * one boolean derived from them.
 */
export interface TerminalWatchView {
  /** What this pane asked to watch: a session, or a start it has not been named. */
  readonly target: ClientTerminalTarget;
  /**
   * The bytes, buffered so a late emulator catches up.
   *
   * One per target and not one per pane: two panes on one session are one
   * subscription — the hub refuses a second from the same connection — so a
   * second pane replays from this rather than opening blank.
   */
  readonly feed: TerminalFeed;
  /** Whether the hub has answered this subscription. */
  readonly attached: boolean;
  /**
   * The session this turned out to be, or `null`.
   *
   * The answer to "which terminal did I just attach to" for a pane that asked
   * by start handle: `null` until the provider names the session, and the ref
   * from the moment the hub says so.
   */
  readonly session: SessionRef | null;
  /** Frames of history the reply promised. Zero says the session has printed nothing. */
  readonly replayChunks: number;
  /** Bytes the terminal had already evicted when the replay began. */
  readonly droppedBytes: number;
  /** Chunks lost on the way here, both legs, over this connection's life. */
  readonly droppedChunks: number;
  /** Whether this browser's own buffer has evicted its oldest chunks. */
  readonly evicted: boolean;
  /** Whether any output at all has reached this pane. */
  readonly printed: boolean;
  /** The hub's most recent "no" about this terminal, in its words, or `null`. */
  readonly problem: string | null;
  /**
   * Why this pane stopped being fed, or `null` while it is being fed.
   *
   * The whole point of the frame behind it: a session that has gone quiet and
   * a session nobody is relaying any more are the same rectangle, and this is
   * the only thing that tells them apart. Cleared when the hub subscribes
   * again on this pane's behalf, which for a dropped or draining machine is
   * what happens by itself a moment later.
   */
  readonly ended: SubscriptionEndReason | null;
  /**
   * Whether this pane is still holding both copies of a re-established feed.
   *
   * What it is really saying is that the bytes have a seam in them. The
   * machine's scrollback survived whatever interrupted the subscription, so
   * what the fresh one replays is the tail of the session as it stands --
   * which overlaps what this pane was already showing, and is written after it
   * rather than in place of it. The buffered bytes are kept rather than
   * cleared, because they are what the emulator has painted and a pane does
   * not go blank to tidy up its own history; the label says what happened
   * instead.
   *
   * It goes false again when the older of the two copies has been evicted,
   * because from then on nothing appears twice -- and a label that outlived
   * what it described would be the pane over-claiming in the other direction,
   * warning about a repeat a user can no longer find.
   */
  readonly resumed: boolean;
}

export interface PaneLayoutAnswer {
  /** Exactly the characters the last save carried, or `null`: never stored. */
  readonly layout: string | null;
}

export interface RefusalView {
  /** The id of the command it answers, so a screen can tell whose "no" it is. */
  readonly replyTo: FrameId;
  readonly code: RefusalCode;
  readonly message: string;
  readonly holder: SessionHolder | null;
}

/**
 * The hub's answer to a start, kept so the screen that asked can act on it.
 *
 * `sessionId` is `null` for a fresh spawn -- the provider mints its own id and
 * the hub learns it from the next scan -- and the session's id for a resume.
 * The distinction is the whole navigation rule in the new-session flow: an id
 * here is an address a pane can open, and `null` is the honest absence of one.
 */
export interface StartedView {
  readonly replyTo: FrameId;
  readonly storeId: StoreId;
  readonly sessionId: SessionId | null;
  /** The machine the hub picked (or the override it honoured). */
  readonly server: ServerRegistrationId;
}

/**
 * What a start asked for, as the command that carried it said it.
 *
 * Kept because a spawn has no session to be named by until the provider writes
 * one, and a list that shows the start before then has nothing else to say
 * what it is: these three fields are the whole of what the client knows. The
 * prompt and the machine override are left behind -- the one is user content
 * nobody reads back off a row, and the other is answered by `started.server`,
 * which names the machine the hub actually picked.
 */
export interface StartAsked {
  readonly storeId: StoreId;
  readonly provider: Provider;
  /** The project the start was filed under, or `null` for none. */
  readonly project: NodeId | null;
}

/**
 * Everything the hub has said about one start this client asked for.
 *
 * Kept per start and keyed by the frame that carried it, like `answers`, and
 * beside it for one reason `answers` cannot serve: an entry is written the
 * moment a start is accepted, so a pane opened in the same click has an entry
 * to read before anything has been answered.
 *
 * The key is the id of the `session-start` frame, which is the name the
 * asking already has and the one every reply to it carries as `replyTo`.
 *
 * `started` and `refusal` are `null` while the hub has not answered. They are
 * never both set: a start is answered once.
 */
export interface StartView {
  /** What the start asked for, filed when it was accepted and never changed. */
  readonly asked: StartAsked;
  /** The hub's yes, naming the machine it placed the start on. */
  readonly started: StartedView | null;
  /** The hub's no, in its own words. */
  readonly refusal: RefusalView | null;
  /**
   * The session a spawn became, once a report named it, or `null`.
   *
   * Not an answer -- `started` is that -- but news the hub sends this client
   * alone, watching or not, so a pane opened on a spawn can rebind to the
   * session with no terminal open on it. It may arrive before `started`.
   */
  readonly named: SessionRef | null;
}

/**
 * One project's standing policy as this client last read it.
 *
 * The whole policy, never a page: the hub answers it whole, and a client
 * holding part of one would be a client saying a request will be asked about
 * when it will not.
 *
 * Kept by project rather than in one newest slot, because more than one screen
 * can be looking at a policy -- a session pane and the project it is filed
 * under -- and a single slot would show one of them the other's answer.
 */
export interface ApprovalPolicyView {
  readonly replyTo: FrameId;
  readonly rules: readonly ApprovalPolicyRecord[];
}

/**
 * One page of the catalogue, as the hub answered it.
 *
 * `total` is the count before paging, so a screen can say "12 of 340" rather
 * than "12 so far"; `nextCursor` is `null` when this page ends the answer, and
 * a client that got one stops rather than polling for a page that will never
 * come.
 *
 * `version` is the catalogue version the hub computed it at, and it is the same
 * number `catalogue-changed` carries. It is what says a page is from before a
 * change -- and what makes the cursor on it refusable, which is why a re-issue
 * after a change starts from the first page rather than from where this one
 * left off.
 */
export interface CataloguePageView {
  readonly items: readonly CatalogueItem[];
  readonly nextCursor: string | null;
  readonly total: number;
  readonly version: number;
}

/**
 * One session's transcript as the hub answered it: the tail of what the
 * session did, and whether there is more behind it.
 *
 * `replyTo` is what joins it to the request, for the reason a document's
 * content carries one: a person may open a second session's Transcript tab
 * while a slow disk answers the first, and a snapshot field with no id on it
 * would draw the first session's history under the second session's name.
 *
 * Kept by the frame that asked, and never by session. Nothing here is a cache:
 * a transcript is a read of a file that is still being appended to, so what the
 * store owes a pane is the answer to the question that pane asked. A
 * per-session store would be a client-side copy of somebody else's file, going
 * stale silently -- which is the thing the hub itself refuses to do.
 */
export interface TranscriptView {
  readonly replyTo: FrameId;
  readonly activities: readonly Activity[];
  /** Whether the session did more before the oldest of these. */
  readonly olderExist: boolean;
}

/**
 * A graph as the hub answered an open: its name, its draft and the draft's
 * number, and which versions are published.
 *
 * `nodeId` is on the view as well as `replyTo`, and the screen reads it by
 * the node: a graph is a screen and not a pane, so there is one of it per node
 * rather than one per request, and a screen that had to hold the frame id it
 * asked with would be a screen that lost its document across a remount.
 */
export interface GraphDocumentView {
  readonly replyTo: FrameId;
  readonly nodeId: NodeId;
  readonly name: string;
  readonly draftVersion: number;
  readonly document: GraphDocument;
  readonly published: readonly GraphPublishedVersion[];
}

/**
 * The hub's answer to a history request: one graph's runs, newest first, at
 * most the protocol's bound, as summaries without steps. Filed by the graph
 * it names, so two screens open on two graphs each find their own list.
 */
export interface RunHistoryView {
  readonly replyTo: FrameId;
  readonly nodeId: NodeId;
  readonly runs: readonly GraphRunSummary[];
}

export interface HubSnapshot {
  readonly phase: ConnectionPhase;
  /** What is degraded, in words, or `null` while nothing is. */
  readonly problem: string | null;
  readonly hubId: HubId | null;
  /**
   * The VAPID key this hub's browsers subscribe against, or `null` when it has
   * none -- which is also the answer before the first welcome.
   *
   * Read off the welcome rather than asked for, because a client has to hold
   * it before it can mint a subscription at all. The two nulls are deliberately
   * one state: nothing can offer to turn push on until a hub has said it can
   * push, and "no welcome yet" is as good a reason not to offer as "no key
   * pair". A finer distinction would be one with no button behind it.
   */
  readonly pushPublicKey: string | null;
  /**
   * The latest whole state the hub sent, or `null` before the first one.
   * Kept, unchanged, across a disconnection: `phase` is what labels it stale.
   */
  readonly machineState: MachineState | null;
  /**
   * Whether `machineState` arrived on this connection.
   *
   * A welcome makes the phase `connected` a frame before the hub's answer to
   * it -- the whole current state -- lands, and React can draw in between. A
   * screen showing the kept state labels it by phase; a screen about to act
   * on it waits for this, or it acts on what the last connection said.
   */
  readonly machineStateCurrent: boolean;
  /** The stored layout, once a layout subscription has been answered. */
  readonly layout: Layout | null;
  /**
   * The stored pane layout, once a pane layout subscription has been
   * answered, or `null` while no answer has arrived. The answer's own
   * `layout` is `null` when the hub has never stored one — two different
   * facts, so two levels of null: "not answered yet" renders as loading and
   * "answered: nothing stored" renders as the default arrangement.
   *
   * Characters, not a tree. Every shape rule lives in the layout module's own
   * parser (`src/layout/tree.ts`); the store carries what the hub answered,
   * verbatim, the way the hub carries what a save sent.
   */
  readonly paneLayout: PaneLayoutAnswer | null;
  readonly commandQueue: CommandQueueView;
  /**
   * Every terminal this client is watching, by the key of the target it named.
   *
   * A map rather than a field per pane because a target is not a component:
   * the layout may show one session in two panes and the address bar may open
   * a third, and all of them are one subscription and one buffer.
   */
  readonly terminals: ReadonlyMap<string, TerminalWatchView>;
  readonly terminalInput: TerminalInputView;
  /**
   * What the hub has answered this client's commands with, by the id of the
   * frame each answer names -- every command reply, and every refusal that is
   * not about a terminal -- and which commands are still owed an answer.
   * `answers.ts` says which replies are kept, bounds them, and is how a screen
   * reads its own answer out of them (`followUp`).
   *
   * The replies are kept across a dropped connection; what was owed on it is
   * not, because nothing on the next one will answer it. Both are emptied
   * when nothing is looking any more.
   */
  readonly answers: Answers;
  /**
   * What the hub has said about each start this client made, by the id of the
   * frame that carried it.
   *
   * A map rather than the slot above, for the reason `StartView` argues: a
   * pane opened on a start reads its own answer and not the newest one.
   */
  readonly starts: ReadonlyMap<FrameId, StartView>;
  /** Every project's standing policy this client has been answered, by node. */
  readonly approvalPolicies: ReadonlyMap<NodeId, ApprovalPolicyView>;
  /**
   * The last catalogue page this store was answered, or `null` before the first.
   *
   * Kept in the snapshot as well as handed back from `queryCatalogue`, because
   * the two have different readers. The promise answers the caller that asked;
   * this is what a re-issue after `catalogue-changed` has to land in, since
   * nobody is waiting on that one -- the change came from the hub, not from a
   * screen.
   */
  readonly catalogue: CataloguePageView | null;
  /**
   * Each graph as the hub last answered an open of it, by the graph.
   *
   * By node and not by frame, because a graph is a screen with one of it per
   * node: any open of this node -- the screen's own, or a remount's -- is an
   * answer the screen wants, and a screen holding the frame id it asked with
   * would lose its document across a remount. Emptied when nothing is looking,
   * since the hub's draft may be saved by another client meanwhile.
   */
  readonly graphDocuments: ReadonlyMap<NodeId, GraphDocumentView>;
  /**
   * Every run the hub has told this client about, by run id, each as the
   * whole state last sent.
   *
   * By run, because the frame names the run and one graph's earlier runs
   * are still worth reading; a screen picks its graph's newest by the
   * `nodeId` each state carries. Replaced whole on every frame, since a state
   * is whole. Bounded by `MAX_REMEMBERED_RUNS`, oldest first, and emptied
   * when the socket drops: a state held across a drop is where the run was
   * when the connection went, and nothing on this socket will move it.
   */
  readonly runs: ReadonlyMap<GraphRunId, GraphRunState>;
  /**
   * Each graph's run history as the hub last answered it, by the graph.
   *
   * A reply and never pushed: a screen asks on open, on every reconnection
   * and when one of its graph's runs moves in a way the list does not show
   * yet. Dropped with the connection, like `runs`.
   */
  readonly runHistories: ReadonlyMap<NodeId, RunHistoryView>;
  /**
   * What the hub has answered each transcript read with, by the id of the
   * frame that asked.
   *
   * A map rather than one slot, for the reason `starts` is one: two panes can
   * be open on one session -- which is the case this screen exists to serve --
   * and with a single slot the second pane's answer would erase the first
   * pane's. The first pane's `replyTo` would then match nothing, so it would go
   * back to saying it was reading with no read of its own outstanding, which is
   * a sentence claiming a machine is being asked something when it is not.
   *
   * Bounded by `MAX_REMEMBERED_TRANSCRIPTS`, oldest first. A pane that has not
   * asked finds nothing, which is exactly what a Transcript tab nobody has
   * opened should show.
   */
  readonly transcripts: ReadonlyMap<FrameId, TranscriptView>;
  /**
   * What this page has learnt about resuming each session: whether a process
   * was seen running it, and the start it last sent for it.
   *
   * The store's and not a pane's, because a pane remounts -- a split, a closed
   * sibling, a trip away from the layout -- and a pane that forgot would
   * restart a session it had watched somebody stop. `resume-memory.ts` argues
   * it. Kept across a teardown too: what ran on this page still ran.
   */
  readonly resumes: ResumeMemories;
}
