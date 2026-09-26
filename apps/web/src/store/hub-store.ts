import {
  assertNever,
  decodeTerminalChunk,
  parseHubFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  type Activity,
  type ApprovalAnsweredBy,
  type ApprovalOutcome,
  type ApprovalPolicyRecord,
  type CatalogueItem,
  type CatalogueQuery,
  type ClientFrame,
  type ClientTerminalTarget,
  type DirectoryEntry,
  type FrameId,
  type GraphDocument,
  type GraphPublishedVersion,
  type GraphRunId,
  type GraphRunState,
  type GraphRunSummary,
  type GraphSimulatedStep,
  type HubFrame,
  type HubId,
  type Layout,
  type MachineState,
  type NodeId,
  type RefusalCode,
  type ServerRegistrationId,
  type SessionHolder,
  type SessionId,
  type SessionPause,
  type SessionRef,
  type StoreId,
  type SubscriptionEndReason,
  type TerminalSize,
} from '@agentplex/protocol';
import {
  createTerminalFeed,
  DEFAULT_FEED_BYTES,
  type TerminalFeed,
} from '../terminal/chunk-feed.js';
import type { FrameIds } from './frame-ids.js';
import type { Timers } from './timers.js';

/**
 * The hub connection as an external store.
 *
 * React consumes this through `useSyncExternalStore` and never through an
 * effect: the socket's lifecycle belongs to whether anything is looking, not
 * to any component's mount. The first subscriber is what dials the hub, and
 * the last one leaving is what hangs up — a page showing no live data holds no
 * socket open, and a page showing twelve panes holds exactly one.
 *
 * Three kinds of outbound traffic, three delivery rules, and keeping them
 * apart is most of this file:
 *
 *   * Commands — session-start, session-stop — are requests the user made
 *     once. While the connection is down they queue, bounded, and the queue
 *     overflowing is said in the snapshot in words rather than a command
 *     silently vanishing.
 *   * Subscriptions are standing interest, not requests: they are replayed on
 *     every (re)connection and never sit in the command queue. A queued
 *     subscription would be a request to know the past; a replayed one asks
 *     for the present, which is the only thing the hub can answer anyway.
 *   * Terminal keystrokes are neither. A keystroke queued while the
 *     connection was down would replay into a session against a screen the
 *     user was not looking at, so it is discarded — and the discard is said in
 *     the snapshot in words, because a keystroke that silently goes nowhere
 *     reads as a hung terminal.
 *
 * There is a fourth, and it is the pairing frames. A pair carries the token a
 * server printed, which is the one credential a client frame ever carries, and
 * a queue is exactly where it must not sit: a command waiting for a connection
 * that may not come back is a secret held in the memory of a tab nobody is
 * watching, for as long as that tab is open. So it is refused while the
 * connection is down and said in words, and the caller waits for the hub's own
 * answer rather than for a snapshot field — a pairing has a reply that names
 * it, and the screen that submitted the form is the one thing that needs it.
 */

/** What the store sends when it can, injected so a test can hand it a fake. */
export interface StoreSocket {
  send(text: string): void;
  close(): void;
  onOpen(fire: () => void): void;
  onMessage(fire: (text: string) => void): void;
  /** Fires once, however the socket ends — including a `close()` of our own. */
  onClose(fire: () => void): void;
}

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
 * Everything the hub has said about one start this client asked for.
 *
 * Kept per start and keyed by the frame that carried it, which the two fields
 * beside it are not: `lastStarted` and `lastRefusal` are one slot each, and a
 * screen reading them is reading whatever was answered most recently to
 * anybody. That is the right shape for the connection line -- the newest "no",
 * whoever asked for it -- and exactly the wrong one for a pane waiting on a
 * start of its own: a second start succeeding clears the first one's refusal,
 * and a pane reading the shared slot would quietly go back to saying it was
 * starting.
 *
 * So the answers are filed against the start they answer. The key is the id of
 * the `session-start` frame, which is the name the asking already has and the
 * one every reply to it carries as `replyTo`; nothing here compares anything.
 *
 * Both fields are `null` while the hub has not answered. They are never both
 * set: a start is answered once.
 */
export interface StartView {
  /** The hub's yes, naming the machine it placed the start on. */
  readonly started: StartedView | null;
  /** The hub's no, in its own words. */
  readonly refusal: RefusalView | null;
}

/**
 * The hub's answer to a stop, kept so a screen can say what landed.
 *
 * Kept beside `lastStarted` and for the same reason: the reply names the
 * machine the hub resolved, which the client never sent and cannot derive.
 * It is also the one reply a screen renders for something it may not have
 * asked for -- a stop from another tab is answered to that tab, and the row
 * it landed on is what this frame names -- so the payload is held rather
 * than dropped and the session row is read out of it.
 */
export interface StoppedView {
  readonly replyTo: FrameId;
  readonly storeId: StoreId;
  readonly sessionId: SessionId;
  /** The machine the hub resolved the session to, hub-side. */
  readonly server: ServerRegistrationId;
}

/**
 * The hub's answer to a pause: the receipt, and how far the pause got.
 *
 * `pause` is the server's word, relayed. `paused` means the session was at a
 * turn boundary and its keyboard is withheld now; `requested` means it is
 * mid-turn and the server will finish the pause when the turn ends. The
 * button that asked reads it to say "pausing" or nothing; what the screen
 * draws for the session comes from the holder on the next machine state,
 * exactly as it does for a stop.
 */
export interface PausedView {
  readonly replyTo: FrameId;
  readonly storeId: StoreId;
  readonly sessionId: SessionId;
  readonly server: ServerRegistrationId;
  readonly pause: SessionPause;
}

/** The hub's answer to a resume: a receipt and nothing more, since the only word it could carry is `none`. */
export interface ResumedView {
  readonly replyTo: FrameId;
  readonly storeId: StoreId;
  readonly sessionId: SessionId;
  readonly server: ServerRegistrationId;
}

/**
 * The hub's answer to an acknowledgement or a mute: the whole attention row as
 * it now stands.
 *
 * Kept for one reason, and it is a narrow one: the control that sent the frame
 * has to stop waiting. What the screen *draws* comes from the session row of
 * the next machine state, which every tab is sent -- so this is a receipt and
 * not a second copy of the state, and nothing reads the two moments off it.
 * They are here because the frame carries them, and keeping half a captured
 * frame would make this view one more thing to hold in step with the protocol
 * for no gain.
 */
export interface AttentionView {
  readonly replyTo: FrameId;
  readonly storeId: StoreId;
  readonly sessionId: SessionId;
  readonly acknowledgedThrough: number | null;
  readonly mutedAt: number | null;
}

/**
 * The hub's answer to a decision: what became of the request, in one word.
 *
 * Two fields because the frame has two, and the narrowness is the point. It
 * names no session and no approval -- `replyTo` already says which question
 * this answers, and the id is spent the moment the request ends -- so nothing
 * can read a row out of it. What is still pending leaves the session row of
 * the next machine state, which is where every client reads it, this one
 * included.
 *
 * The outcome is about the request and not about the tap: `granted` may be
 * somebody else's grant, which is what deciding once means, and `withdrawn`
 * and `expired` are the two endings where a person answered and nothing
 * happened. Keeping it is what lets the control that asked say which.
 */
export interface ApprovalView {
  readonly replyTo: FrameId;
  readonly outcome: ApprovalOutcome;
  /**
   * The standing rule whose grant took effect, or `null` for a request a person
   * answered.
   *
   * Kept because the outcome alone is not enough for the control that asked:
   * `granted` is `granted` whether this tap was the one applied or a rule got
   * there first, and a screen that could not tell those apart would report
   * somebody's tap as having done something it did not do.
   */
  readonly answeredBy: ApprovalAnsweredBy | null;
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
 * The hub's answer to a browse, kept so the picker that asked can render it.
 *
 * `replyTo` is what joins it to the request, because a picker may have more
 * than one browse in flight -- a user who clicks twice while a slow disk is
 * answering -- and a snapshot field with no id on it would show the first
 * answer under the second directory.
 *
 * `directory` is `null` for the listing of roots, and the entries are then the
 * roots themselves carrying their own absolute paths. Everywhere else an entry
 * is one segment and is joined onto the directory. The store keeps both exactly
 * as the hub sent them; the joining rule lives in `projects/directory-picker-model.ts`,
 * where a test can reach it.
 */
export interface DirectoryListingView {
  readonly replyTo: FrameId;
  readonly directory: string | null;
  readonly roots: readonly string[];
  readonly entries: readonly DirectoryEntry[];
  readonly truncated: boolean;
}

/**
 * The hub's answer to a project create, kept so the form that asked can act.
 *
 * The node id is what makes it worth keeping. A project is named by its id from
 * then on -- a start names one -- and a form that had to find its own project
 * back out of the next tree by name would be matching on the one field the user
 * is free to change.
 */
export interface ProjectCreatedView {
  readonly replyTo: FrameId;
  readonly nodeId: NodeId;
}

/**
 * The hub's yes to one of the five tree edits, kept so the menu that asked can
 * close itself and say what happened.
 *
 * One view for all five, because the yes really is the same: the tree did what
 * was asked, and what the screen shows next comes from the layout it re-reads
 * when `catalogue-changed` arrives. `nodeId` is the one thing a create adds —
 * the id of the folder it made — and it is `null` for the four edits that make
 * nothing.
 */
export interface TreeChangeView {
  readonly replyTo: FrameId;
  readonly nodeId: NodeId | null;
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
 * The hub's answer to a document create, kept so the form that asked can act.
 *
 * The same shape and the same reason as a project's: every later frame about
 * this document names the node, and a form that had to find its own back out
 * of the next tree would be matching on a name the user may rename.
 */
export interface DocCreatedView {
  readonly replyTo: FrameId;
  readonly nodeId: NodeId;
}

/**
 * A document the hub answered with, whole, and when the machine holding it
 * says it was written.
 *
 * `replyTo` is what joins it to the request for the reason a listing carries
 * one: a person may open a second document while a slow disk is answering the
 * first, and a snapshot field with no id on it would put the first document
 * under the second name. The editor is AGX-243; what this store owes it is the
 * characters and the time, kept exactly as they arrived.
 */
export interface DocContentView {
  readonly replyTo: FrameId;
  readonly content: string;
  readonly updatedAt: number;
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
 * The hub's answer to a save: when the machine holding the document wrote it.
 *
 * Kept rather than discarded, because it is the only evidence a client has
 * that a save landed on a disk rather than merely leaving the browser -- and
 * it is the server's clock, so an editor showing "saved a moment ago" is
 * showing what the machine said and not what this tab assumed.
 */
export interface DocSavedView {
  readonly replyTo: FrameId;
  readonly updatedAt: number;
}

/**
 * The hub's answer to a graph create, kept so the form that asked can act.
 * The same shape and the same reason as a document's.
 */
export interface GraphCreatedView {
  readonly replyTo: FrameId;
  readonly nodeId: NodeId;
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

/** The hub's answer to a save: which draft, and when on the hub's clock. */
export interface GraphSavedView {
  readonly replyTo: FrameId;
  readonly version: number;
  readonly updatedAt: number;
}

/** The hub's answer to a publish: the version the draft became. */
export interface GraphPublishedView {
  readonly replyTo: FrameId;
  readonly version: number;
}

/**
 * The hub's answer to a run: what the run is called, and its number.
 *
 * `replyTo` is what joins it to the screen that pressed Run, and `runId` is
 * what that screen then reads the run's states by -- a state carries no
 * `replyTo`, because it is not an answer to anything.
 */
export interface RunStartedView {
  readonly replyTo: FrameId;
  readonly runId: GraphRunId;
  readonly number: number;
}

/** The hub's yes to a cancel. The run's end arrives as a state, not here. */
export interface RunCancelledView {
  readonly replyTo: FrameId;
  readonly runId: GraphRunId;
}

/**
 * The hub's answer to a read of a graph's run: the newest run, or `null`
 * when the graph has never run.
 *
 * Kept so the screen that asked can match it to its read, and name the graph
 * so a screen can drop a run it was holding when the answer is `null`. A run
 * in the answer is also filed in `runs`, like any state, so a screen reading
 * the graph's newest there sees it either way.
 */
export interface RunLatestView {
  readonly replyTo: FrameId;
  readonly nodeId: NodeId;
  readonly run: GraphRunState | null;
}

/**
 * The hub's answer to a simulate: what a run of the graph's draft would do,
 * step by step with why, and the sentence the walk stopped on or `null`.
 *
 * Kept by the frame it answers, like a save or a publish, so the screen that
 * pressed Simulate matches it to its own request and a second screen's
 * answer is not drawn as this one's. Nothing in it is a run: no run id, no
 * number, and nothing filed in `runs`.
 */
export interface SimulatedView {
  readonly replyTo: FrameId;
  readonly nodeId: NodeId;
  readonly path: readonly GraphSimulatedStep[];
  readonly reason: string | null;
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

/**
 * The hub's yes to a subscribe or an unsubscribe, kept so the control that
 * asked can stop waiting.
 *
 * One view for two frames, like `AttentionView`: both answers carry nothing
 * but the id of the frame they answer, and two views would be two things to
 * hold in step for a difference nothing renders. `subscribed` is which of the
 * two it was, because a control that says "notifications are on" has to know
 * which way the last answer went.
 *
 * It is a receipt and never the state of a subscription. What a browser is
 * actually subscribed to lives in the browser -- `pushManager.getSubscription`
 * is the only honest answer -- and a store field that claimed otherwise would
 * go on claiming it after somebody revoked the permission in their settings.
 */
export interface PushView {
  readonly replyTo: FrameId;
  readonly subscribed: boolean;
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
  /** The hub's most recent "no", kept until a later command is answered yes. */
  readonly lastRefusal: RefusalView | null;
  /** The hub's most recent yes to a start, kept until the next one. */
  readonly lastStarted: StartedView | null;
  /**
   * What the hub has said about each start this client made, by the id of the
   * frame that carried it.
   *
   * A map rather than the slot above, for the reason `StartView` argues: a
   * pane opened on a start reads its own answer and not the newest one.
   */
  readonly starts: ReadonlyMap<FrameId, StartView>;
  /** The hub's most recent yes to a stop, kept until the next one. */
  readonly lastStopped: StoppedView | null;
  /** The hub's most recent yes to a pause, and to a resume, each kept until the next. */
  readonly lastPaused: PausedView | null;
  readonly lastResumed: ResumedView | null;
  /** The hub's most recent yes to an acknowledgement or a mute. */
  readonly lastAttention: AttentionView | null;
  /** What the hub last said became of an approval this client answered. */
  readonly lastApproval: ApprovalView | null;
  /** Every project's standing policy this client has been answered, by node. */
  readonly approvalPolicies: ReadonlyMap<NodeId, ApprovalPolicyView>;
  /** The hub's most recent directory listing, kept until the next one. */
  readonly lastListing: DirectoryListingView | null;
  /** The hub's most recent yes to a project create, kept until the next one. */
  readonly lastProjectCreated: ProjectCreatedView | null;
  /** The hub's most recent yes to a tree edit, kept until the next one. */
  readonly lastTreeChange: TreeChangeView | null;
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
  /** The hub's most recent yes to a document create, kept until the next one. */
  readonly lastDocCreated: DocCreatedView | null;
  /** The hub's most recent yes to a document save, kept until the next one. */
  readonly lastDocSaved: DocSavedView | null;
  /** The most recent document the hub answered with, kept until the next one. */
  readonly lastDocContent: DocContentView | null;
  /** The hub's most recent yes to a graph create, kept until the next one. */
  readonly lastGraphCreated: GraphCreatedView | null;
  /** The most recent graph the hub answered with, kept until the next one. */
  readonly lastGraphDocument: GraphDocumentView | null;
  /** The hub's most recent yes to a graph save, kept until the next one. */
  readonly lastGraphSaved: GraphSavedView | null;
  /** The hub's most recent yes to a graph publish, kept until the next one. */
  readonly lastGraphPublished: GraphPublishedView | null;
  /** The hub's most recent yes to a run, kept until the next one. */
  readonly lastRunStarted: RunStartedView | null;
  /** The hub's most recent yes to a run cancel, kept until the next one. */
  readonly lastRunCancelled: RunCancelledView | null;
  /** The hub's most recent answer to a read of a graph's run. */
  readonly lastRunLatest: RunLatestView | null;
  /** The hub's most recent answer to a simulate, kept until the next one or a drop. */
  readonly lastSimulated: SimulatedView | null;
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
  /** The hub's most recent yes to a subscribe or an unsubscribe. */
  readonly lastPush: PushView | null;
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
}

/**
 * A command is a client frame body without its id: ids belong to the store's
 * counter, minted at the moment of acceptance so a queued command keeps one
 * identity from enqueue to reply. `hello` and `ping` are not commands — the
 * connection machinery owns them — and `layout-request` and
 * `pane-layout-request` are subscriptions (standing interest), not requests
 * the user makes once. `pane-layout-save` is a command: a save is something
 * that happened once, and if the connection is down when it does, the queue
 * carries it — later saves replay after it, so the hub still ends on the
 * newest arrangement. `directory-list` is a command too, and the queue is the
 * right place for it rather than the wrong one: a person browsing while the
 * connection blinks asked a question once, and the answer is as good a moment
 * later. It is not standing interest — nothing re-lists a directory on every
 * reconnection — so it is not a subscription. `project-create`, the five tree
 * edits and the three document frames are commands for the plainest reason of
 * all: each is something the user did once, and a queue is where a once-only
 * intent waits. `session-acknowledge` and `session-mute` are commands for that
 * same reason, and the queue is righter for them than it is for a stop:
 * dismissing a prompt while the connection blinks is still dismissing that
 * prompt, and the hub stamps the moment when it reads the frame rather than
 * when the user clicked — so what a queued acknowledgement ends up worth is
 * decided by whether the session spoke in the meantime, which is the rule an
 * acknowledgement already lives by. `push-subscribe` and `push-unsubscribe`
 * are commands for the same reason, and the queue is right for them in a way
 * it is not for a pairing: neither carries a credential -- a push endpoint is
 * a capability for reaching that browser, minted by its own push service, and
 * it is what the hub stores rather than a secret the user typed -- and turning
 * notifications on while the connection blinks is still turning them on.
 *
 * The three policy frames are commands for the plainest reason too: reading a
 * project's rules is a question asked once by somebody who opened a panel, and
 * writing or removing one is something a person did once. None of them is
 * standing interest -- nothing re-reads a policy on every reconnection, the way
 * the layout is re-asked -- so none of them is a subscription. Queueing a write
 * over a blink is right for the same reason it is right for an acknowledgement:
 * "stop asking me about this" is still what the person meant a second later,
 * and the hub refuses the rule if it has since become one it will not take.
 *
 * `approval-decide` is a command for that reason too, and it is the one where
 * queueing looks riskiest and is not: a decision held over a blink can reach a
 * hub that has nothing left to apply it to. What makes it safe is that the hub
 * says so -- `withdrawn` for a question the agent took back, `expired` for a
 * hook that stopped waiting -- so a late answer is reported as what it was
 * rather than swallowed or mistaken for a denial. Dropping it instead would
 * lose the one case that matters most: a person answering the moment they saw
 * the request, over a connection that blinked while they read it.
 */
type CommandFrame = Extract<
  ClientFrame,
  {
    type:
      | 'session-start'
      | 'session-stop'
      | 'session-pause'
      | 'session-resume'
      | 'session-acknowledge'
      | 'session-mute'
      | 'approval-decide'
      | 'approval-policy-list'
      | 'approval-policy-add'
      | 'approval-policy-remove'
      | 'pane-layout-save'
      | 'directory-list'
      | 'project-create'
      | 'node-create-folder'
      | 'node-rename'
      | 'node-move'
      | 'node-remove'
      | 'node-forget-removal'
      | 'doc-create'
      | 'doc-save'
      | 'doc-open'
      | 'graph-create'
      | 'graph-open'
      | 'graph-save'
      | 'graph-publish'
      | 'graph-run'
      | 'graph-run-cancel'
      | 'graph-run-read'
      | 'graph-run-history-request'
      | 'graph-run-open'
      | 'graph-simulate'
      | 'push-subscribe'
      | 'push-unsubscribe'
      | 'session-transcript';
  }
>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type HubCommand = DistributiveOmit<CommandFrame, 'id'>;

export type CommandOutcome =
  | { readonly accepted: true; readonly id: FrameId; readonly delivery: 'sent' | 'queued' }
  | { readonly accepted: false; readonly reason: string };

/**
 * A request the store sends now or not at all, and then waits for.
 *
 * The pairing frames and nothing else so far: they carry a credential, which
 * is why they may not queue, and they change what the hub may dial, which is
 * why the screen that sent one waits for the answer rather than inferring it
 * from the next state.
 */
type RequestFrame = Extract<ClientFrame, { type: 'server-pair' | 'server-unpair' }>;
export type HubRequest = DistributiveOmit<RequestFrame, 'id'>;

/**
 * What the hub answered, as a value.
 *
 * A refusal is not a failure to send: the hub read the frame and said no, and
 * its words are what the screen shows. `reason` therefore covers both -- the
 * hub's refusal and the store's own "there is no connection to send this on" --
 * because to whoever submitted the form they are the same kind of sentence.
 */
export type RequestOutcome =
  | {
      readonly ok: true;
      readonly reply: Extract<HubFrame, { type: 'server-paired' | 'server-unpaired' }>;
    }
  | { readonly ok: false; readonly reason: string };

export type TerminalInputOutcome =
  { readonly delivered: true } | { readonly delivered: false; readonly reason: string };

export interface HubStore {
  /**
   * The `useSyncExternalStore` contract. The first subscriber connects the
   * store; the last one to leave closes it.
   */
  subscribe(listener: () => void): () => void;
  getSnapshot(): HubSnapshot;
  /**
   * Dials again, now, after a `failed` connection; does nothing otherwise.
   *
   * The store never retries a failure on its own -- the same build against the
   * same hub gets the same refusal -- but the build on one side may have
   * changed since, and a person who knows that should not have to reload the
   * tab to say so. Anything else is the store's own backoff, left alone.
   */
  retry(): void;
  /** Sends now, or queues while the connection is down. Never silently drops. */
  sendCommand(command: HubCommand): CommandOutcome;
  /**
   * Sends now and resolves with the hub's own answer; refuses in words when
   * there is nothing to send on.
   *
   * Never queued, and that is the whole difference from `sendCommand`: what
   * goes out this way carries a credential, and a queued one would be a secret
   * kept in memory with nobody watching it. A connection that drops before the
   * answer arrives resolves with what happened rather than leaving a promise
   * nothing will ever settle -- the screen has a button that is spinning.
   */
  request(request: HubRequest): Promise<RequestOutcome>;
  /** Sends now, or discards while the connection is down. Never queues. */
  sendTerminalInput(target: ClientTerminalTarget, data: string): TerminalInputOutcome;
  /**
   * Tells the session how big the viewer is, and remembers it.
   *
   * Not a command and not a keystroke: a size is standing interest of a sort
   * the other two are not — it is a fact about the viewer that stays true
   * until the next one, so the last one given is said again each time the hub
   * answers the subscription. Silent on success, like the wire:
   * what a pane can see for itself is not worth a frame back.
   */
  sendTerminalResize(target: ClientTerminalTarget, size: TerminalSize): void;
  /**
   * Standing interest in one terminal, replayed on every reconnection.
   *
   * The returned function gives the watch back; the last one to leave is what
   * sends `session-unsubscribe`. The bytes and the facts about them are in
   * the snapshot, under `terminalKey(target)` — not returned here, because a
   * pane re-reads them on every render and a value handed over once would be
   * the version that was true at mount.
   */
  watchTerminal(target: ClientTerminalTarget): () => void;
  /** Standing interest in the stored layout, re-requested on every reconnection. */
  subscribeLayout(): () => void;
  /** Standing interest in the stored pane layout, re-requested the same way. */
  subscribePaneLayout(): () => void;
  /**
   * Asks the hub for one page of the catalogue, and answers it.
   *
   * A promise rather than a snapshot field with a `replyTo` on it, and it is
   * the one request on this store that is shaped that way. The others are
   * intent -- start this, save that -- whose answer belongs on the screen that
   * asked and nowhere else; a page is a *read*, and the caller almost always
   * has to do something with it before it can draw anything: keep the cursor,
   * append to what it already has, decide whether to ask for the next one. A
   * caller that had to watch a snapshot field for its own answer would have to
   * match on `replyTo` by hand, which is the correlation this store already
   * does.
   *
   * It is never queued. A page is a read of the catalogue as it is now, pinned
   * by the hub to a version; replaying one after a reconnection would send a
   * cursor the hub has already decided is stale, and be refused for a reason
   * the person who asked would not recognise. So a query issued while the
   * connection is down rejects, at once, with the reason -- and the screen asks
   * again when it is back.
   *
   * It rejects with the hub's own sentence when the hub refuses -- a stale
   * cursor is the one a client acts on, by asking for the first page again.
   */
  queryCatalogue(query: CatalogueQuery): Promise<CataloguePageView>;
  /**
   * The same question, asked off the channel the screen is drawing.
   *
   * There is one catalogue channel here -- one remembered question, one page on
   * the snapshot, one re-issue when `catalogue-changed` arrives -- because one
   * screen draws the catalogue and a second copy of a page nobody is looking at
   * is a second answer to disagree with. A caller that wants a page *for
   * itself* does not fit that: the command palette asks its own question on
   * every keystroke and keeps the answer inside the dialog, and asking through
   * `queryCatalogue` would make the panel's rows change under a person typing
   * in a dialog over them, and make the next `catalogue-changed` re-ask what
   * was typed rather than what is on screen.
   *
   * So this sends the same frame and is answered by the same correlation, and
   * differs in the two things that make the channel a channel: the question is
   * not remembered, and the page does not land on the snapshot. Everything
   * else is `queryCatalogue`'s contract, sentence for sentence -- it is never
   * queued, it rejects while the connection is down, it rejects with the hub's
   * own words when the hub refuses, and it is told when the socket drops under
   * it.
   */
  queryCatalogueDetached(query: CatalogueQuery): Promise<CataloguePageView>;
  /**
   * Standing interest in the catalogue, so a change re-issues the last query.
   *
   * The counterpart of `subscribeLayout`, and it does the same thing for the
   * same reason: `catalogue-changed` carries a version and no rows, so the
   * honest response is to re-read whatever this client is actually drawing. A
   * client watching no catalogue does nothing at all.
   *
   * The re-issue starts from the first page, never from the cursor the last
   * page handed back. That cursor was minted at the version that just moved,
   * and the hub refuses it by design.
   */
  subscribeCatalogue(): () => void;
}

export interface HubStoreDependencies {
  /** The token-for-ticket exchange. Rejection is an ordinary connect failure. */
  fetchTicket(): Promise<string>;
  /** Opens one socket with one ticket. The real one wraps `WebSocket`. */
  createSocket(ticket: string): StoreSocket;
  readonly timers: Timers;
  readonly frameIds: FrameIds;
  /**
   * How big one watched terminal's buffer may get, in bytes.
   *
   * Injected only so a test can make a feed drop something with three chunks;
   * the app takes the default, which `chunk-feed.ts` argues.
   */
  readonly terminalFeedBytes?: number;
  /** Bounds the offline command queue. The default is deliberate; see below. */
  readonly maxQueuedCommands?: number;
  /** Reconnect backoff, first try to steady state. The last entry repeats. */
  readonly reconnectDelaysMs?: readonly number[];
  /** How long an established connection goes before it pings the hub. */
  readonly heartbeatIntervalMs?: number;
  /** How long a ping may go unanswered before the connection is given up. */
  readonly heartbeatTimeoutMs?: number;
  /**
   * Tells the store the page has reason to doubt its connection: it came back
   * into view, or the network came back. Subscribed while anything listens to
   * the store; the returned function unsubscribes. None means no wakes.
   */
  readonly wake?: (fire: () => void) => () => void;
}

/**
 * More than any burst of human intent while offline, and few enough that the
 * queue never becomes a macro recorder: a command beyond this many is intent
 * that has gone stale, and refusing it in words beats replaying half a
 * minute's clicking into a hub that has moved on.
 */
const DEFAULT_MAX_QUEUED_COMMANDS = 32;

/** Fast enough that a blip heals unnoticed; capped so a dead hub is not hammered. */
const DEFAULT_RECONNECT_DELAYS_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000, 15_000];

/**
 * A socket the network dropped without a word stays open to the browser until
 * a write fails, which can be minutes, so the store asks. Under the 60 s idle
 * timeout a reverse proxy commonly holds, and a dead link is noticed within
 * interval plus deadline.
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;

/** The one place a client frame becomes characters. */
export function encodeClientFrame(frame: ClientFrame): string {
  return JSON.stringify(frame);
}

/**
 * One name for one terminal, so two frames naming it are one subscription.
 *
 * JSON and not a joined string, for the reason the session key it replaces
 * was: a store id and a session id are opaque, and a separator that can
 * appear inside one of them is a collision waiting for the store that uses
 * it. The `by` discriminator is part of the key because a start handle and a
 * session are two different things to watch, right up until the hub says
 * which session a start became — and even then the pane goes on being
 * answered under the name it asked with.
 */
/**
 * How many starts a connection remembers the hub's answer to.
 *
 * Far above any arrangement of panes -- a screen of twelve panes is twelve
 * starts -- and small enough that a tab left open all day starting sessions
 * cannot grow this without bound. The oldest *answered* entry goes first, so
 * what is dropped is an answer rather than a pane's expectation of one; see
 * `evictOldestStarts` for what happens in the corner where nothing has been
 * answered at all.
 */
const MAX_REMEMBERED_STARTS = 64;

/**
 * How many transcript answers a connection remembers.
 *
 * Far smaller than the number of starts, because these are not two fields and
 * a boolean: one answer is up to two hundred activities, which the protocol's
 * own arithmetic sizes at a quarter of a megabyte. The cap is still well above
 * any arrangement of panes -- a screen of twelve panes all on Transcript is
 * twelve entries -- so what falls off is an answer an earlier read left behind
 * rather than one somebody is looking at.
 *
 * Oldest first, and plainly so: every entry here is an answer that has already
 * arrived, and the oldest of them is the one a pane is least likely to still be
 * drawing. A pane that refreshes keeps a pointer at its own previous answer
 * (`TranscriptAsks`), and that pointer is the newest of its entries, so
 * evicting from the old end takes the stale ones first.
 */
export const MAX_REMEMBERED_TRANSCRIPTS = 16;
/** How many runs the store remembers, oldest first. Far above any screen's interest. */
export const MAX_REMEMBERED_RUNS = 64;

export function terminalKey(target: ClientTerminalTarget): string {
  return target.by === 'start'
    ? JSON.stringify(['start', target.startId])
    : JSON.stringify(['session', target.storeId, target.sessionId]);
}

/** The same key for a session named by a frame rather than by a target. */
function sessionTerminalKey(storeId: StoreId, sessionId: SessionId): string {
  return JSON.stringify(['session', storeId, sessionId]);
}

/**
 * One watched terminal as the store holds it: the published facts, plus the
 * bookkeeping a subscription needs and a pane has no use for.
 */
interface TerminalRecord {
  readonly key: string;
  readonly target: ClientTerminalTarget;
  readonly feed: TerminalFeed;
  /** How many panes are looking. The last one leaving sends the unsubscribe. */
  watchers: number;
  attached: boolean;
  session: SessionRef | null;
  replayChunks: number;
  droppedBytes: number;
  droppedChunks: number;
  printed: boolean;
  problem: string | null;
  ended: SubscriptionEndReason | null;
  /**
   * How much this pane had already been shown when its subscription was
   * re-established, in bytes over this feed's whole life, or `null` when none
   * of that has happened.
   *
   * A position rather than a flag, because the flag has to go out again. The
   * output a replay duplicates is everything this pane held at that moment --
   * the bytes below this position -- and the feed evicts oldest first, so the
   * moment it has thrown away that much, the older copy of the repeat is gone
   * and only the replayed one is left. `feed.dropped` is the same count on the
   * same scale, which is what makes the comparison exact rather than a guess
   * at how much a replay was worth.
   */
  resumedAbove: number | null;
  /**
   * The id of the `session-subscribe` this record's subscription was asked
   * with, or `null` when there is none outstanding.
   *
   * Kept for as long as the subscription stands rather than forgotten when it
   * is first answered, because the hub answers it more than once: a machine
   * that dropped and came back is re-subscribed on this client's behalf, and
   * the fresh `session-subscribed` names the frame this pane asked with. It is
   * also what a refusal about this terminal names, which is why the entry it
   * indexes is the one place both are matched.
   */
  subscribeId: FrameId | null;
  /**
   * The last size the pane gave for this terminal, said again each time the
   * hub answers the subscription.
   *
   * A size is not a keystroke and not a command: it stays true until the next
   * one, so a reconnection that did not carry it would leave the process on
   * the far end laying its screen out against a window that is no longer
   * there.
   */
  size: TerminalSize | null;
  /** The session key this was indexed under as well, once a reply named one. */
  bound: string | null;
}

/** What a terminal frame this client sent is waiting to be told about. */
type TerminalAsk = 'subscribe' | 'unsubscribe' | 'input' | 'resize';

const INITIAL_QUEUE: Omit<CommandQueueView, 'capacity'> = { queued: 0, overflowed: null };
const INITIAL_TERMINAL: TerminalInputView = { discarded: 0, notice: null };

export function createHubStore(dependencies: HubStoreDependencies): HubStore {
  const { timers, frameIds } = dependencies;
  const capacity = dependencies.maxQueuedCommands ?? DEFAULT_MAX_QUEUED_COMMANDS;
  const delays = dependencies.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
  const feedBytes = dependencies.terminalFeedBytes ?? DEFAULT_FEED_BYTES;
  const heartbeatInterval = dependencies.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimeout = dependencies.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;

  const listeners = new Set<() => void>();
  let snapshot: HubSnapshot = {
    phase: 'idle',
    problem: null,
    hubId: null,
    machineState: null,
    layout: null,
    paneLayout: null,
    commandQueue: { ...INITIAL_QUEUE, capacity },
    terminals: new Map(),
    terminalInput: INITIAL_TERMINAL,
    lastRefusal: null,
    lastStarted: null,
    starts: new Map(),
    lastStopped: null,
    lastPaused: null,
    lastResumed: null,
    lastAttention: null,
    lastApproval: null,
    approvalPolicies: new Map(),
    lastListing: null,
    lastProjectCreated: null,
    lastTreeChange: null,
    catalogue: null,
    lastDocCreated: null,
    lastDocSaved: null,
    lastDocContent: null,
    lastGraphCreated: null,
    lastGraphDocument: null,
    lastGraphSaved: null,
    lastGraphPublished: null,
    lastRunStarted: null,
    lastRunCancelled: null,
    lastRunLatest: null,
    lastSimulated: null,
    runs: new Map(),
    runHistories: new Map(),
    lastPush: null,
    pushPublicKey: null,
    transcripts: new Map(),
  };

  let socket: StoreSocket | null = null;
  /** Bumped on every dial and on teardown, so a stale callback can tell. */
  let generation = 0;
  let established = false;
  /** True once a protocol mismatch has stopped the store's own retrying. */
  let failed = false;
  /** Consecutive failed attempts since the connection last held. */
  let attempt = 0;
  let everConnected = false;
  let cancelRetry: (() => void) | null = null;
  /** The heartbeat's one pending timer: the next ping, or the deadline on the last. */
  let cancelHeartbeat: (() => void) | null = null;
  /** The ping the hub has not answered yet, which only its own pong clears. */
  let outstandingPing: FrameId | null = null;
  let unsubscribeWake: (() => void) | null = null;

  const queue: { readonly id: FrameId; readonly command: HubCommand }[] = [];
  /** Sent commands awaiting a reply, by the id the reply will name. */
  const pending = new Set<FrameId>();
  /**
   * What the hub has said about each start, by the frame that asked.
   *
   * Written when a start is accepted rather than when one is answered, so that
   * a pane opened in the same click as the start finds an entry to read and
   * can say it is asking rather than say nothing at all.
   *
   * Bounded, oldest first, because a tab that starts sessions all day would
   * otherwise accumulate one entry per start for as long as it is open. The
   * cap is far above any arrangement of panes, so nothing a pane is still
   * waiting on is ever the entry that goes.
   */
  const starts = new Map<FrameId, StartView>();
  /**
   * What each transcript read was answered with, by the frame that asked.
   *
   * Written only when an answer arrives, unlike `starts`: a pane already knows
   * the id it asked with and says "reading" off that, so there is nothing an
   * empty entry would tell it that it does not hold itself.
   */
  const transcripts = new Map<FrameId, TranscriptView>();
  /**
   * Every run this client has been told about, by run id: what `runs` on
   * the snapshot is a copy of. Bounded, oldest first, for the reason the
   * starts are: a tab watching a graph all day would otherwise keep one
   * entry per run for as long as it is open.
   */
  const runs = new Map<GraphRunId, GraphRunState>();
  /**
   * Requests whose caller is waiting, by the id the answer will name.
   *
   * Settled by the reply, by a refusal, or by the connection going away --
   * never left pending, because on the other end of each of these is a button
   * that is spinning.
   */
  const waiting = new Map<FrameId, (outcome: RequestOutcome) => void>();

  let layoutWatchers = 0;
  let paneLayoutWatchers = 0;
  let catalogueWatchers = 0;
  /**
   * The last catalogue query this store sent, so a change can re-issue it.
   *
   * The query and not the page: what has to survive a change is the question,
   * and the answer to it is exactly what the change invalidated.
   */
  let lastQuery: CatalogueQuery | null = null;
  /**
   * Catalogue queries awaiting an answer, by the id the answer will name.
   *
   * Beside `pending` rather than in it, because the two are settled by
   * different things: a command's entry is deleted when the reply arrives and
   * the screen reads the outcome off the snapshot, and one of these has a
   * caller blocked on it that must be told either way -- including when the
   * connection drops with the question unanswered.
   */
  const pendingQueries = new Map<
    FrameId,
    {
      resolve(page: CataloguePageView): void;
      reject(error: Error): void;
      /**
       * Whether this one was asked off the channel, for the caller alone.
       *
       * Kept per question rather than read back off the query, because two
       * askers can send the identical question for different reasons -- the
       * panel drawing the catalogue and the palette searching it -- and what
       * tells them apart is who asked rather than what was asked.
       */
      readonly detached: boolean;
    }
  >();

  /** Tells every blocked caller the answer is not coming. */
  function abandonQueries(why: string): void {
    for (const waiting of [...pendingQueries.values()]) waiting.reject(new Error(why));
    pendingQueries.clear();
  }
  /** Every watched terminal, by the key of the target the pane named. */
  const terminals = new Map<string, TerminalRecord>();
  /**
   * Start-addressed records, indexed again by the session they turned out to
   * be, so output carrying only a session id still finds them.
   *
   * A second index rather than a re-keyed map, because both names stay true:
   * the hub goes on stamping this client's own start handle on every frame
   * for that watch, and the pane goes on being answered under the name it
   * asked with. The hub's relay keeps the same two names for the same reason.
   */
  const rebound = new Map<string, Set<TerminalRecord>>();
  /** Terminal frames this client sent, by the id a refusal would name. */
  const terminalReplies = new Map<FrameId, { readonly key: string; readonly ask: TerminalAsk }>();

  function update(changes: Partial<HubSnapshot>): void {
    snapshot = { ...snapshot, ...changes };
    for (const listener of [...listeners]) listener();
  }

  /**
   * Publishes the terminal facts, and nothing else.
   *
   * Called only when one of them actually changed. A chunk arriving is not
   * one of them: bytes go to the feed, and the pane's emulator reads them
   * from there without React ever hearing about it.
   */
  /**
   * Whether both copies of a re-established feed are still in this pane's
   * buffer. Read where it is published rather than stored, because what moves
   * it is the feed evicting, which is not an event this store hears about.
   */
  function stillRepeating(record: TerminalRecord): boolean {
    return record.resumedAbove !== null && record.feed.dropped < record.resumedAbove;
  }

  function publishTerminals(): void {
    const views = new Map<string, TerminalWatchView>();
    for (const [key, record] of terminals) {
      views.set(key, {
        target: record.target,
        feed: record.feed,
        attached: record.attached,
        session: record.session,
        replayChunks: record.replayChunks,
        droppedBytes: record.droppedBytes,
        droppedChunks: record.droppedChunks,
        evicted: record.feed.truncated,
        printed: record.printed,
        problem: record.problem,
        ended: record.ended,
        resumed: stillRepeating(record),
      });
    }
    update({ terminals: views });
  }

  /**
   * Opens an entry for a start the moment it is accepted, sent or queued.
   *
   * Not when the hub answers, because a pane is opened in the same click that
   * sends the start and has to be able to say something before any answer
   * exists. An entry with two nulls on it is that something: asked, and not
   * yet answered.
   */
  function rememberStart(command: HubCommand, id: FrameId): void {
    if (command.type !== 'session-start') return;
    starts.set(id, { started: null, refusal: null });
    evictOldestStarts();
    update({ starts: new Map(starts) });
  }

  /**
   * Brings the remembered starts back under the cap, answered ones first.
   *
   * A start the hub has not answered is the one a pane may still be waiting to
   * read, so it is passed over while there is any settled entry left to drop --
   * a pane that lost its entry would go back to saying it was asking, which is
   * the over-claim this map exists to prevent. The bound is still hard: with
   * nothing settled to drop, the oldest goes anyway, because a map that could
   * refuse to shrink is not a bound.
   */
  function evictOldestStarts(): void {
    while (starts.size > MAX_REMEMBERED_STARTS) {
      const settled = [...starts].find(
        ([, view]) => view.started !== null || view.refusal !== null,
      );
      const [oldest] = settled ?? [...starts][0] ?? [];
      if (oldest === undefined) return;
      starts.delete(oldest);
    }
  }

  /**
   * Brings the remembered transcripts back under the cap, oldest first.
   *
   * No passing over, unlike `evictOldestStarts`: every entry here is already an
   * answer, so there is no unsettled one to protect and the insertion order is
   * the order they arrived in.
   */
  function evictOldestTranscripts(): void {
    while (transcripts.size > MAX_REMEMBERED_TRANSCRIPTS) {
      const [oldest] = [...transcripts.keys()];
      if (oldest === undefined) return;
      transcripts.delete(oldest);
    }
  }

  /** Files an answer against the start it answers, and publishes it. */
  function noteStartAnswer(replyTo: FrameId, answer: StartView): void {
    if (!starts.has(replyTo)) return;
    starts.set(replyTo, answer);
    update({ starts: new Map(starts) });
  }

  function queueView(overflowed: string | null): CommandQueueView {
    return { queued: queue.length, capacity, overflowed };
  }

  /**
   * Puts one terminal frame on the wire and remembers what it was, so that a
   * refusal reaches the pane that asked rather than the screen-wide "the hub
   * said no" that every other command shares.
   *
   * Answered with the id, or `null` when there was nothing to send it on.
   */
  function sendTerminalFrame(
    ask: TerminalAsk,
    key: string,
    build: (id: FrameId) => ClientFrame,
  ): FrameId | null {
    const wire = socket;
    if (!established || wire === null) return null;
    const id = frameIds.next();
    terminalReplies.set(id, { key, ask });
    wire.send(encodeClientFrame(build(id)));
    return id;
  }

  /**
   * Asks for one terminal. The size the viewer has waits for the answer: a
   * resize for a terminal this connection is not yet watching is a frame the
   * hub can only refuse, and `session-subscribed` is where it goes out.
   */
  function subscribeTerminal(record: TerminalRecord): void {
    record.subscribeId = sendTerminalFrame('subscribe', record.key, (id) => ({
      type: 'session-subscribe',
      id,
      target: record.target,
    }));
  }

  /** Every terminal a chunk belongs to, each once however many names found it. */
  function recipientsOf(
    storeId: StoreId,
    sessionId: SessionId | null,
    startId: FrameId | null,
  ): Set<TerminalRecord> {
    const matched = new Set<TerminalRecord>();
    if (startId !== null) {
      const byStart = terminals.get(terminalKey({ by: 'start', startId }));
      if (byStart !== undefined) matched.add(byStart);
    }
    if (sessionId !== null) {
      const key = sessionTerminalKey(storeId, sessionId);
      const bySession = terminals.get(key);
      if (bySession !== undefined) matched.add(bySession);
      for (const record of rebound.get(key) ?? []) matched.add(record);
    }
    return matched;
  }

  /**
   * Asks again for a terminal this connection was refused by start handle.
   *
   * The race this exists for is real and is not the hub's fault: a pane opens
   * in the click that sends the start, so its subscribe can arrive while the
   * hub is still waiting for a machine to fork the process, and a handle the
   * hub has not recorded yet is a handle it must refuse -- "this connection
   * did not start that session" is the right answer to a handle that is not
   * there, and would be the wrong answer to hold open.
   *
   * So the client asks again on the one frame that says the handle now exists.
   * Only a record that is not attached, because a subscription that was
   * answered needs nothing, and a second subscribe to a terminal this
   * connection is already watching is refused by the hub on purpose.
   *
   * And only when nothing is outstanding, which is the same rule read for the
   * other order the race can come out in. The hub may read the first subscribe
   * *after* it sends this reply, in which case that subscribe is about to
   * succeed and this connection is not attached yet -- so a retry here would
   * be the second subscribe the hub refuses as a duplicate, and the pane would
   * carry "the hub said no" for the rest of its life beside a terminal that is
   * working perfectly. A subscribe with no answer yet is a subscribe that may
   * still be answered; there is nothing to ask again for.
   */
  function retrySubscribeByStart(startId: FrameId): void {
    const key = terminalKey({ by: 'start', startId });
    const record = terminals.get(key);
    if (record === undefined || record.attached) return;
    for (const asked of terminalReplies.values()) {
      if (asked.key === key && asked.ask === 'subscribe') return;
    }
    // The refusal that sent the pane here is answered rather than left on
    // screen beside a terminal that is about to work.
    record.problem = null;
    publishTerminals();
    subscribeTerminal(record);
  }

  /** Forgets the second name a start-addressed record was given. */
  function unbind(record: TerminalRecord): void {
    if (record.bound === null) return;
    const held = rebound.get(record.bound);
    held?.delete(record);
    if (held?.size === 0) rebound.delete(record.bound);
    record.bound = null;
  }

  /**
   * A start-addressed record learns which session it turned out to be.
   *
   * The moment a pending pane becomes a session's pane. The record keeps its
   * start-addressed key -- the hub still answers to it -- and gains a second
   * name, so a chunk carrying only the session id reaches it too.
   *
   * Taken off the hub's own frames rather than guessed from what arrived
   * around the same time: a spawn and a scan racing is exactly the case where
   * guessing by timing attaches a pane to somebody else's agent. Two frames
   * can carry the answer and both are read, because which of them arrives
   * first is not this store's to decide. The subscription's reply carries it
   * when the provider had already named the session; for the spawn this whole
   * path exists for it has not, and the first frame that can say so is a chunk
   * of output carrying both names -- which is the server's reading of its own
   * store report, relayed down the terminal path rather than inferred here.
   *
   * Answers whether anything changed, so the output path does not publish a
   * snapshot per chunk.
   */
  function nameStart(record: TerminalRecord, storeId: StoreId, sessionId: SessionId): boolean {
    if (record.target.by !== 'start' || record.session !== null) return false;
    record.session = { storeId, sessionId };
    unbind(record);
    const key = sessionTerminalKey(storeId, sessionId);
    record.bound = key;
    const held = rebound.get(key) ?? new Set<TerminalRecord>();
    held.add(record);
    rebound.set(key, held);
    return true;
  }

  function connect(): void {
    cancelRetry = null;
    const mine = (generation += 1);
    update({ phase: everConnected || attempt > 0 ? 'reconnecting' : 'connecting' });
    dependencies.fetchTicket().then(
      (ticket) => {
        if (mine !== generation) return;
        open(ticket);
      },
      (error: unknown) => {
        if (mine !== generation) return;
        update({ problem: `could not get a connection ticket from the hub: ${String(error)}` });
        scheduleRetry();
      },
    );
  }

  function open(ticket: string): void {
    const mine = generation;
    const opened = dependencies.createSocket(ticket);
    socket = opened;
    opened.onOpen(() => {
      if (mine !== generation) return;
      opened.send(
        encodeClientFrame({
          type: 'hello',
          id: frameIds.next(),
          protocolVersion: PROTOCOL_VERSION,
        }),
      );
    });
    opened.onMessage((text) => {
      if (mine !== generation) return;
      receive(text);
    });
    opened.onClose(() => {
      if (mine !== generation) return;
      lose(null);
    });
  }

  /**
   * The connection is gone, whether the socket said so or the heartbeat
   * decided it: everything that was waiting on it is answered, and a retry is
   * scheduled.
   */
  function lose(problem: string | null): void {
    drop(problem);
    scheduleRetry();
  }

  /**
   * Forgets the connection and answers everything that was waiting on it,
   * without deciding what comes next: `lose` schedules the backoff, and
   * `retry` dials at once.
   *
   * `problem` is why, when the store knows better than "it closed"; a close
   * the socket reported words only the commands it stranded.
   */
  function drop(problem: string | null): void {
    socket = null;
    established = false;
    stopHeartbeat();
    const unanswered = pending.size;
    pending.clear();
    settleWaiting('the connection dropped before the hub answered');
    abandonQueries('the connection dropped before the hub answered this catalogue query');
    detachTerminals();
    // A run held across a drop is where it was when the socket went, and
    // nothing on the next one moves it until a state or a read's answer
    // arrives: a screen mounted meanwhile must not draw it live.
    const heldRuns = runs.size > 0;
    runs.clear();
    const stranded =
      unanswered > 0
        ? `the connection dropped before the hub answered ${String(unanswered)} command${
            unanswered === 1 ? '' : 's'
          }`
        : null;
    const said =
      problem !== null && stranded !== null ? `${problem}; ${stranded}` : (problem ?? stranded);
    if (said !== null || heldRuns) {
      update({
        ...(heldRuns ? { runs: new Map() } : {}),
        ...(said !== null ? { problem: said } : {}),
      });
    }
  }

  function retry(): void {
    if (!failed) return;
    failed = false;
    attempt = 0;
    cancelRetry?.();
    cancelRetry = null;
    // `failed` is set on the frame, not on the close: the hub may not have
    // hung up yet, and a failure after a welcome leaves the socket, the
    // heartbeat and `established` all in place. Given up here, with the bump
    // first because a socket's `close()` may report synchronously, so the old
    // socket's close is the stale one and nothing more goes out on it.
    const lingering = socket;
    if (lingering !== null) {
      generation += 1;
      drop(null);
      lingering.close();
    }
    connect();
  }

  /** Waits out one quiet interval, then asks. Replaces whatever was pending. */
  function scheduleHeartbeat(): void {
    stopHeartbeat();
    cancelHeartbeat = timers.schedule(heartbeatInterval, ping);
  }

  function stopHeartbeat(): void {
    cancelHeartbeat?.();
    cancelHeartbeat = null;
    outstandingPing = null;
  }

  function ping(): void {
    cancelHeartbeat = null;
    const wire = socket;
    if (!established || wire === null) return;
    const id = frameIds.next();
    outstandingPing = id;
    wire.send(encodeClientFrame({ type: 'ping', id }));
    cancelHeartbeat = timers.schedule(heartbeatTimeout, () => {
      cancelHeartbeat = null;
      const unanswering = socket;
      // Given up here and now rather than when the socket reports its close:
      // a browser holds a half-open socket's `close` until its closing
      // handshake times out, and the bump makes that late event a stale one.
      generation += 1;
      lose(`the hub did not answer a ping within ${String(heartbeatTimeout / 1_000)} s`);
      unanswering?.close();
    });
  }

  /**
   * The page came back into view or back online, either of which is a moment
   * a connection may have died unnoticed. A retry waiting out its backoff
   * dials now; an established connection with no question open asks now.
   * Anything else -- a dial in flight, a failure, a ping already out -- is
   * left alone, because a second dial would orphan the first socket.
   */
  function wake(): void {
    if (cancelRetry !== null) {
      cancelRetry();
      connect();
      return;
    }
    if (established && !failed && socket !== null && outstandingPing === null) {
      stopHeartbeat();
      ping();
    }
  }

  /**
   * Answers everybody still waiting, with the same sentence.
   *
   * Called when the socket goes and when the store is torn down. A request that
   * was in flight may or may not have reached the hub, and this says exactly
   * that rather than guessing: the screen re-reads the state, which is the one
   * thing that can settle what actually happened.
   */
  function settleWaiting(reason: string): void {
    const stranded = [...waiting.values()];
    waiting.clear();
    for (const settle of stranded) settle({ ok: false, reason });
  }

  function scheduleRetry(): void {
    if (failed || listeners.size === 0) return;
    const delay = delays[Math.min(attempt, delays.length - 1)] ?? 0;
    attempt += 1;
    update({ phase: 'reconnecting' });
    cancelRetry = timers.schedule(delay, connect);
  }

  /** Files a run whole under its id, the oldest forgotten past the bound. */
  function fileRun(state: GraphRunState): void {
    runs.set(state.runId, state);
    while (runs.size > MAX_REMEMBERED_RUNS) {
      const oldest = runs.keys().next().value;
      if (oldest === undefined) break;
      runs.delete(oldest);
    }
  }

  function receive(text: string): void {
    const parsed = parseTextFrame(parseHubFrame, text);
    if (!parsed.ok) {
      // Dropped and said, never obeyed and never fatal: closing a working
      // connection over one unreadable broadcast would throw away the next
      // state frame, which arrives whole and may be perfectly readable. The
      // snapshot carries the words so the degradation is visible, not silent.
      update({ problem: `the hub sent a frame this client could not read: ${parsed.reason}` });
      return;
    }

    const frame = parsed.value;
    switch (frame.type) {
      case 'welcome': {
        established = true;
        failed = false;
        attempt = 0;
        everConnected = true;
        update({
          phase: 'connected',
          hubId: frame.hubId,
          // Taken from every welcome and not only the first. A hub that was
          // restarted with push wired in is a hub whose next welcome says so,
          // and a client holding the answer from the connection before would
          // be refusing to offer something that now works.
          pushPublicKey: frame.pushPublicKey,
          problem: null,
          // A fresh connection is a live terminal again; the discard notice
          // described a spell that has ended.
          terminalInput: INITIAL_TERMINAL,
        });
        replaySubscriptions();
        flushQueue();
        scheduleHeartbeat();
        return;
      }
      case 'pong': {
        // Only the answer to the ping still open counts; an older one says
        // nothing about whether the latest question reached the hub.
        if (outstandingPing !== null && frame.replyTo === outstandingPing) scheduleHeartbeat();
        return;
      }
      case 'machine-state': {
        // No client-side version arithmetic: the hub already never re-sends a
        // version on one connection, and a fresh connection starts with the
        // whole current state. The latest frame received is the state.
        update({ machineState: frame.state });
        return;
      }
      case 'layout': {
        update({ layout: frame.nodes });
        return;
      }
      case 'pane-layout': {
        update({ paneLayout: { layout: frame.layout } });
        return;
      }
      case 'pane-layout-saved': {
        pending.delete(frame.replyTo);
        return;
      }
      case 'session-started': {
        pending.delete(frame.replyTo);
        const started: StartedView = {
          replyTo: frame.replyTo,
          storeId: frame.storeId,
          sessionId: frame.sessionId,
          server: frame.server,
        };
        update({ lastRefusal: null, lastStarted: started });
        noteStartAnswer(frame.replyTo, { started, refusal: null });
        // The reply is also the moment a subscription by this start's handle
        // becomes possible, which is why it is retried here. A pane opens in
        // the same click that sends the start, so its subscribe can reach the
        // hub while the spawn is still being forked on another machine -- and
        // a handle the hub has not written yet is one it can only refuse. It
        // writes the handle before sending this frame, so a retry on reading
        // one is a retry that finds it.
        //
        // On the client rather than as a hold at the hub: a hub that parked a
        // subscribe until a start resolved would be holding a frame for a
        // start that may be refused, or may never answer at all, and would owe
        // every one of them a timeout and a reply. The client already knows
        // which start it is waiting on, and this is one frame.
        retrySubscribeByStart(frame.replyTo);
        return;
      }
      case 'session-stopped': {
        pending.delete(frame.replyTo);
        update({
          lastRefusal: null,
          lastStopped: {
            replyTo: frame.replyTo,
            storeId: frame.storeId,
            sessionId: frame.sessionId,
            server: frame.server,
          },
        });
        return;
      }
      case 'session-paused': {
        pending.delete(frame.replyTo);
        update({
          lastRefusal: null,
          lastPaused: {
            replyTo: frame.replyTo,
            storeId: frame.storeId,
            sessionId: frame.sessionId,
            server: frame.server,
            pause: frame.pause,
          },
        });
        return;
      }
      case 'session-resumed': {
        pending.delete(frame.replyTo);
        update({
          lastRefusal: null,
          lastResumed: {
            replyTo: frame.replyTo,
            storeId: frame.storeId,
            sessionId: frame.sessionId,
            server: frame.server,
          },
        });
        return;
      }
      case 'session-attention': {
        pending.delete(frame.replyTo);
        update({
          lastRefusal: null,
          lastAttention: {
            replyTo: frame.replyTo,
            storeId: frame.storeId,
            sessionId: frame.sessionId,
            acknowledgedThrough: frame.acknowledgedThrough,
            mutedAt: frame.mutedAt,
          },
        });
        return;
      }
      case 'approval-decided': {
        pending.delete(frame.replyTo);
        // Kept the way an attention reply is kept, and clearing the refusal
        // for the same reason: the last thing the hub said about this client's
        // frames is now a yes, and a card showing both would put a sentence
        // about an answered question beside the answer. The outcome is the
        // whole payload -- what is still open is read off the next machine
        // state, never out of here.
        update({
          lastRefusal: null,
          lastApproval: {
            replyTo: frame.replyTo,
            outcome: frame.outcome,
            answeredBy: frame.answeredBy,
          },
        });
        return;
      }
      case 'push-subscribed':
      case 'push-unsubscribed': {
        pending.delete(frame.replyTo);
        // The refusal is cleared for the reason a start clears it: the last
        // thing the hub said is now a yes, and a control showing both would be
        // showing a sentence about a question that has since been answered.
        update({
          lastRefusal: null,
          lastPush: { replyTo: frame.replyTo, subscribed: frame.type === 'push-subscribed' },
        });
        return;
      }
      case 'approval-policy': {
        pending.delete(frame.replyTo);
        // Replaced whole, and by the project the frame names rather than by
        // whichever question was asked: list, add and remove all answer with
        // the policy as it now stands, so there is nothing here to apply and
        // nothing to get wrong. A client that applied its own add would be a
        // client holding a policy nobody vouched for.
        const policies = new Map(snapshot.approvalPolicies);
        policies.set(frame.projectId, { replyTo: frame.replyTo, rules: frame.rules });
        update({ lastRefusal: null, approvalPolicies: policies });
        return;
      }
      case 'server-paired':
      case 'server-unpaired': {
        waiting.get(frame.replyTo)?.({ ok: true, reply: frame });
        waiting.delete(frame.replyTo);
        return;
      }
      case 'directory-listing': {
        pending.delete(frame.replyTo);
        // The refusal is cleared for the reason a start clears it: the last
        // thing the hub said is now a yes, and a picker showing both would be
        // showing a sentence about a question that has since been answered.
        update({
          lastRefusal: null,
          lastListing: {
            replyTo: frame.replyTo,
            directory: frame.directory,
            roots: frame.roots,
            entries: frame.entries,
            truncated: frame.truncated,
          },
        });
        return;
      }
      case 'project-created': {
        pending.delete(frame.replyTo);
        // No re-request here, and there used to be one. The hub now broadcasts
        // `catalogue-changed` after every change to the tree, this one
        // included, so asking again on the reply as well would be two requests
        // for one change — and only on the client that made it, which was
        // always the wrong half: the other tabs are looking at the same tree.
        update({
          lastRefusal: null,
          lastProjectCreated: { replyTo: frame.replyTo, nodeId: frame.nodeId },
        });
        return;
      }
      case 'node-created': {
        pending.delete(frame.replyTo);
        update({
          lastRefusal: null,
          lastTreeChange: { replyTo: frame.replyTo, nodeId: frame.nodeId },
        });
        return;
      }
      case 'doc-created': {
        pending.delete(frame.replyTo);
        update({
          lastRefusal: null,
          lastDocCreated: { replyTo: frame.replyTo, nodeId: frame.nodeId },
        });
        // No re-request here, for the reason a project create has none: a
        // document is a node, so the hub broadcasts `catalogue-changed` after
        // making one, and asking again on the reply as well would be two
        // requests for one change -- on the only client that already knows.
        return;
      }
      case 'doc-saved': {
        pending.delete(frame.replyTo);
        // Nothing about the tree changed. A save changes the file on a machine
        // and the hub's index of when; it changes no row the layout carries,
        // so there is nothing here for a re-read of the tree to find.
        update({
          lastRefusal: null,
          lastDocSaved: { replyTo: frame.replyTo, updatedAt: frame.updatedAt },
        });
        return;
      }
      case 'doc-content': {
        pending.delete(frame.replyTo);
        update({
          lastRefusal: null,
          lastDocContent: {
            replyTo: frame.replyTo,
            content: frame.content,
            updatedAt: frame.updatedAt,
          },
        });
        return;
      }
      case 'graph-created': {
        pending.delete(frame.replyTo);
        // No re-request, for the reason a document create has none: a graph is
        // a node, the hub broadcasts `catalogue-changed` after making one, and
        // this client hears it like every other.
        update({
          lastRefusal: null,
          lastGraphCreated: { replyTo: frame.replyTo, nodeId: frame.nodeId },
        });
        return;
      }
      case 'graph-document': {
        pending.delete(frame.replyTo);
        update({
          lastRefusal: null,
          lastGraphDocument: {
            replyTo: frame.replyTo,
            nodeId: frame.nodeId,
            name: frame.name,
            draftVersion: frame.draftVersion,
            document: frame.document,
            published: frame.published,
          },
        });
        return;
      }
      case 'graph-saved': {
        pending.delete(frame.replyTo);
        // A save changes the draft and nothing the tree carries.
        update({
          lastRefusal: null,
          lastGraphSaved: {
            replyTo: frame.replyTo,
            version: frame.version,
            updatedAt: frame.updatedAt,
          },
        });
        return;
      }
      case 'graph-published': {
        pending.delete(frame.replyTo);
        // A publish changes which versions exist and nothing the tree carries.
        update({
          lastRefusal: null,
          lastGraphPublished: { replyTo: frame.replyTo, version: frame.version },
        });
        return;
      }
      case 'graph-run-started': {
        pending.delete(frame.replyTo);
        update({
          lastRefusal: null,
          lastRunStarted: { replyTo: frame.replyTo, runId: frame.runId, number: frame.number },
        });
        return;
      }
      case 'graph-run-state': {
        // Unsolicited and whole: filed by the run, replacing what was there.
        // Nothing is pending for it, because nobody asked for this frame.
        const { type: _type, ...state } = frame;
        fileRun(state);
        update({ runs: new Map(runs) });
        return;
      }
      case 'graph-run-cancelled': {
        pending.delete(frame.replyTo);
        update({
          lastRefusal: null,
          lastRunCancelled: { replyTo: frame.replyTo, runId: frame.runId },
        });
        return;
      }
      case 'graph-run-latest': {
        // The answer to a read, and to an open of one run: either way it is
        // addressed, and the frame that asked is settled here.
        pending.delete(frame.replyTo);
        // A run in the answer is filed like any state, so that a screen
        // reading its graph's newest out of `runs` finds it there too.
        if (frame.run !== null) fileRun(frame.run);
        update({
          lastRefusal: null,
          lastRunLatest: { replyTo: frame.replyTo, nodeId: frame.nodeId, run: frame.run },
          ...(frame.run === null ? {} : { runs: new Map(runs) }),
        });
        return;
      }
      case 'graph-simulated': {
        pending.delete(frame.replyTo);
        update({
          lastRefusal: null,
          lastSimulated: {
            replyTo: frame.replyTo,
            nodeId: frame.nodeId,
            path: frame.path,
            reason: frame.reason,
          },
        });
        return;
      }
      case 'graph-run-history': {
        pending.delete(frame.replyTo);
        // Filed by the graph and replacing the list held for it: the answer
        // is whole, newest first, as the hub read it.
        const histories = new Map(snapshot.runHistories);
        histories.set(frame.nodeId, {
          replyTo: frame.replyTo,
          nodeId: frame.nodeId,
          runs: frame.runs,
        });
        update({ lastRefusal: null, runHistories: histories });
        return;
      }
      case 'session-transcript-read': {
        pending.delete(frame.replyTo);
        // Filed under the frame that asked, and whole: a transcript is one read
        // of a file at one moment, and two answers stitched together would be a
        // history that never existed on any disk. It replaces nothing but what
        // was filed under this same id, so the pane that asked something else
        // still has its own answer to draw.
        transcripts.set(frame.replyTo, {
          replyTo: frame.replyTo,
          activities: frame.activities,
          olderExist: frame.olderExist,
        });
        evictOldestTranscripts();
        update({ lastRefusal: null, transcripts: new Map(transcripts) });
        return;
      }
      case 'node-renamed':
      case 'node-moved':
      case 'node-removed':
      case 'node-removal-forgotten': {
        pending.delete(frame.replyTo);
        // One case for four frames, because the answer is the same: the tree
        // did what was asked, and what is on screen comes from the layout the
        // broadcast is about to make this client re-read.
        update({ lastRefusal: null, lastTreeChange: { replyTo: frame.replyTo, nodeId: null } });
        return;
      }
      case 'catalogue-page': {
        const waiting = pendingQueries.get(frame.replyTo);
        pendingQueries.delete(frame.replyTo);
        const page: CataloguePageView = {
          items: frame.items,
          nextCursor: frame.nextCursor,
          total: frame.total,
          version: frame.version,
        };
        // The snapshot carries it as well as the caller, because a re-issue on
        // `catalogue-changed` has no caller: nobody asked for it, and the page
        // has to land somewhere a screen is looking. A detached page is the one
        // exception and the reason that flag exists: it answers a caller who
        // asked for itself, and putting it here would replace the rows of a
        // screen that asked a different question.
        if (waiting?.detached !== true) update({ catalogue: page });
        waiting?.resolve(page);
        return;
      }
      case 'catalogue-changed': {
        // Unsolicited, and the only frame that makes this store ask for
        // something on its own account. It carries a version and no nodes, so
        // the honest response is to re-read what this client is actually
        // drawing — and a client watching neither a layout nor a catalogue does
        // nothing at all.
        requestLayout();
        requestCatalogue();
        return;
      }
      case 'session-subscribed': {
        const asked = terminalReplies.get(frame.replyTo);
        // Not deleted, unlike every other correlation here. This one names a
        // standing interest rather than a question: the hub subscribes again
        // on this pane's behalf when the machine holding the session comes
        // back, and answers that under the id this pane asked with. Dropping
        // the entry on the first reply would leave the second one -- the one
        // that says how much history is being replayed into a pane with a gap
        // in it -- matching nothing.
        const record = asked === undefined ? undefined : terminals.get(asked.key);
        if (record === undefined) return;

        // A reply to a subscription that was interrupted, rather than the
        // first one. What follows it is the machine's scrollback as it stands
        // now, written after bytes this pane already has -- so what is already
        // here is what the replay is about to say again.
        if (record.printed) record.resumedAbove = record.feed.dropped + record.feed.bytes;
        record.attached = true;
        // The size the pane last reported, said now and by the store: the
        // pane's pacer never reports a size twice, so a size it gave before
        // this answer -- or before a machine coming back re-answered it --
        // reaches the far end here or not at all.
        const size = record.size;
        if (size !== null) {
          sendTerminalFrame('resize', record.key, (id) => ({
            type: 'terminal-resize',
            id,
            target: record.target,
            size,
          }));
        }
        record.ended = null;
        record.problem = null;
        record.replayChunks = frame.replayChunks;
        record.droppedBytes = frame.droppedBytes;
        if (record.target.by === 'start') {
          // A subscription by start handle, answered by a hub that already
          // knows the session: `nameStart` is where a pending record stops
          // being pending, whichever frame brings the news.
          if (frame.sessionId !== null) nameStart(record, frame.storeId, frame.sessionId);
        } else {
          record.session =
            frame.sessionId === null
              ? null
              : { storeId: frame.storeId, sessionId: frame.sessionId };
        }
        publishTerminals();
        return;
      }
      case 'session-unsubscribed': {
        // The books were closed when the last pane left; this says the hub
        // agrees. Nothing to publish: a pane that is gone has no notice to
        // show, and one still here never asked for this.
        terminalReplies.delete(frame.replyTo);
        return;
      }
      case 'session-subscription-ended': {
        // Addressed by the target this pane asked with, which is the name it
        // is keyed by here -- including the start handle of a spawn nobody has
        // named yet, which no frame addressed by session id could reach.
        const record = terminals.get(terminalKey(frame.target));
        if (record === undefined) return;

        record.attached = false;
        record.ended = frame.reason;
        // The bytes stay. They are what the emulator has painted, and a pane
        // whose feed stopped is still showing the last of a session rather
        // than nothing.
        if (frame.reason === 'session-ended' && record.subscribeId !== null) {
          // The hub has given this subscription back: there is no terminal on
          // the other end to re-attach to, so the id it was asked with will
          // never name another frame.
          terminalReplies.delete(record.subscribeId);
          record.subscribeId = null;
        }
        publishTerminals();
        return;
      }
      case 'terminal-output': {
        const chunk = decodeTerminalChunk(frame.chunk);
        for (const record of recipientsOf(frame.storeId, frame.sessionId, frame.startId)) {
          const evicted = record.feed.truncated;
          const repeating = stillRepeating(record);
          record.feed.push(chunk);
          // The frame that names a spawn, in the ordinary case. A subscription
          // made before the provider wrote its session id was answered with a
          // `null` one, and output is what carries the answer afterwards: the
          // server puts the session on every chunk from the moment it binds
          // the terminal to it.
          const named =
            frame.sessionId === null ? false : nameStart(record, frame.storeId, frame.sessionId);
          // Only the facts, and only when one of them moved. The bytes went
          // to the feed above and the emulator has them already; publishing
          // per chunk would re-render the app at the speed the agent prints.
          const changed =
            named ||
            !record.printed ||
            record.droppedChunks !== frame.droppedChunks ||
            evicted !== record.feed.truncated ||
            // This chunk may have pushed the older copy of a repeat out of the
            // buffer, which is a fact about the label and moves nothing else.
            repeating !== stillRepeating(record);
          record.printed = true;
          // Cumulative and only ever increasing, so the newest frame is the
          // whole count; a reader comparing it with the last one it saw gets
          // the size of the gap.
          record.droppedChunks = frame.droppedChunks;
          if (changed) publishTerminals();
        }
        return;
      }
      case 'refusal': {
        const asked = terminalReplies.get(frame.replyTo);
        if (asked !== undefined) {
          terminalReplies.delete(frame.replyTo);
          const record = terminals.get(asked.key);
          if (record === undefined) return;
          // Said on the pane rather than in the screen-wide refusal: this is
          // a no about one terminal, and the user is looking at it. A blank
          // rectangle and a machine that is asleep draw the same thing.
          record.problem = frame.message;
          if (asked.ask === 'subscribe') {
            record.attached = false;
            record.subscribeId = null;
          }
          publishTerminals();
          return;
        }
        pending.delete(frame.replyTo);
        // A refusal answers a request as surely as a reply does, and its words
        // are the hub's own. It still goes into `lastRefusal`: the connection
        // line shows the newest "no" whoever asked for it.
        waiting.get(frame.replyTo)?.({ ok: false, reason: frame.message });
        waiting.delete(frame.replyTo);
        // A refused query has a caller blocked on it, and it is told first: the
        // one refusal worth acting on here is a stale cursor, and what the
        // caller does about it is ask for the first page again. The snapshot
        // still carries the sentence, like every other no.
        const refused = pendingQueries.get(frame.replyTo);
        pendingQueries.delete(frame.replyTo);
        refused?.reject(new Error(frame.message));
        const refusal: RefusalView = {
          replyTo: frame.replyTo,
          code: frame.code,
          message: frame.message,
          holder: frame.holder,
        };
        update({ lastRefusal: refusal });
        // And against the start it answers, when it answers one. The slot
        // above is the newest "no" on the connection and a later yes clears
        // it; a pane waiting on this start needs the one that was said to it.
        noteStartAnswer(frame.replyTo, { started: null, refusal });
        if (!established && frame.code === 'protocol-version') {
          // Redialling on a timer cannot change which protocol either side
          // speaks, and a capped backoff against a hub that will refuse
          // forever is noise. A new build can, and it arrives when somebody
          // deploys one: so the store stops here and a person retries.
          failed = true;
          update({ phase: 'failed', problem: frame.message });
        }
        return;
      }
      case 'protocol-error': {
        // The hub could not read something this client sent. The hub closes
        // the socket after saying so, and a client that produced one
        // unreadable frame will produce the same one again — a build mismatch,
        // not weather — so the store does not retry this on its own either;
        // a person can, through `retry`, once a build has changed.
        failed = true;
        update({
          phase: 'failed',
          problem: `the hub could not read a frame this client sent: ${frame.message}`,
        });
        return;
      }
      default:
        // Exhaustive, the way the hub's two switches are. A frame added to
        // the protocol with no case here is a type error rather than a
        // silence: the four terminal frames parsed cleanly for a milestone
        // and fell out of the bottom of a switch exactly like this one, with
        // no log line and nothing to find.
        return assertNever(frame, 'hub frame');
    }
  }

  /** Asks for the tree again, if anything is watching it. */
  function requestLayout(): void {
    const wire = socket;
    if (wire === null || !established || layoutWatchers === 0) return;
    wire.send(encodeClientFrame({ type: 'layout-request', id: frameIds.next() }));
  }

  /**
   * Asks the catalogue question again, if anything is watching it.
   *
   * From the first page, never from the last cursor: the cursor was minted at
   * the version that just moved, and the hub refuses one from before a change
   * by design. A rejection here has no caller to reach, so it is swallowed into
   * the snapshot's `problem` the way an unreadable frame is -- the degradation
   * is visible rather than silent, and a page nobody asked for must not become
   * an unhandled rejection.
   */
  function requestCatalogue(): void {
    const question = lastQuery;
    if (question === null || catalogueWatchers === 0) return;
    issueQuery({ ...question, cursor: null }).catch((error: unknown) => {
      update({ problem: `the catalogue could not be re-read: ${String(error)}` });
    });
  }

  /**
   * Sends one catalogue query and answers it, or rejects saying why not.
   *
   * The query is remembered before the send rather than after, so that a change
   * arriving while this one is in flight re-issues the question that was asked
   * rather than the one before it -- unless it is `'detached'`, which is a
   * caller's own question and not the channel's: remembering it would have the
   * next `catalogue-changed` re-ask what somebody typed into a dialog instead
   * of what a screen is drawing.
   */
  function issueQuery(
    query: CatalogueQuery,
    asked: 'channel' | 'detached' = 'channel',
  ): Promise<CataloguePageView> {
    const detached = asked === 'detached';
    if (!detached) lastQuery = query;
    const wire = socket;
    if (!established || wire === null) {
      return Promise.reject(
        new Error(
          snapshot.problem ??
            'the connection is down: a catalogue page is a read of now and is not queued',
        ),
      );
    }
    const id = frameIds.next();
    return new Promise<CataloguePageView>((resolve, reject) => {
      pendingQueries.set(id, { resolve, reject, detached });
      wire.send(encodeClientFrame({ ...query, type: 'catalogue-query', id }));
    });
  }

  function replaySubscriptions(): void {
    const wire = socket;
    if (wire === null) return;
    if (layoutWatchers > 0) {
      wire.send(encodeClientFrame({ type: 'layout-request', id: frameIds.next() }));
    }
    if (paneLayoutWatchers > 0) {
      wire.send(encodeClientFrame({ type: 'pane-layout-request', id: frameIds.next() }));
    }
    // The catalogue is standing interest too, and a reconnection is a change
    // this client slept through: the hub's version may have moved any number of
    // times while the socket was down, so the question is asked again from the
    // first page rather than resumed.
    requestCatalogue();
    for (const record of terminals.values()) subscribeTerminal(record);
  }

  function flushQueue(): void {
    const wire = socket;
    if (wire === null) return;
    for (const { id, command } of queue.splice(0)) {
      pending.add(id);
      wire.send(encodeClientFrame({ ...command, id }));
    }
    update({ commandQueue: queueView(null) });
  }

  function teardown(): void {
    generation += 1;
    cancelRetry?.();
    cancelRetry = null;
    stopHeartbeat();
    unsubscribeWake?.();
    unsubscribeWake = null;
    const wire = socket;
    socket = null;
    established = false;
    failed = false;
    attempt = 0;
    everConnected = false;
    // Queued commands go with the connection: their replies would reach a page
    // nobody is looking at, and replaying stored intent minutes later against
    // a hub that moved on is the surprise the bound exists to prevent.
    queue.length = 0;
    pending.clear();
    settleWaiting('the page stopped listening to the hub before it answered');
    abandonQueries('nothing is looking at this store any more');
    lastQuery = null;
    wire?.close();
    detachTerminals();
    update({
      phase: 'idle',
      commandQueue: queueView(null),
      terminalInput: INITIAL_TERMINAL,
      // A listing describes somebody else's disk as it was; nothing is looking
      // any more, and the next page to look will ask again.
      lastListing: null,
      // Same, and more so: a catalogue page is pinned to a version this hub run
      // may not be at when somebody looks again.
      catalogue: null,
      // The same, and more so: a document is a file that may have been edited
      // on its own machine while nothing here was connected, so holding the
      // characters would be holding a copy this store cannot vouch for.
      lastDocContent: null,
      // A graph's draft is the hub's, and another client may have saved it
      // while nothing here was connected: the same copy this store cannot
      // vouch for, so the screen asks again when it is looked at.
      lastGraphDocument: null,
      // A run moves on the hub's own clock. What this store held is where a
      // run was when the socket went, and the next state to arrive is whole.
      runs: new Map(),
      // A run may have started or ended meanwhile, so a list held from then
      // is a list nobody can vouch for; the screen asks again.
      runHistories: new Map(),
      // A path is a reading of a draft and of the fleet's placement, and
      // either may have moved while nothing here was connected.
      lastSimulated: null,
      // And the same again: the transcript file goes on being appended to on
      // its own machine while nothing here is connected.
      transcripts: new Map(),
    });
    transcripts.clear();
    runs.clear();
  }

  /**
   * The connection is gone: every watch is standing interest again rather
   * than an attachment.
   *
   * The records survive, because the panes do — a subscription is interest
   * and not a request, and the next welcome replays it. What does not survive
   * is everything that was true of *that* connection: nothing is attached to
   * a socket that is closed, `droppedChunks` counts one link's losses and the
   * link is gone, and a refusal the last connection gave is not a fact about
   * the next one. The buffered bytes stay: they are what the emulator is
   * showing, and a pane does not go blank because a socket did.
   */
  function detachTerminals(): void {
    terminalReplies.clear();
    if (terminals.size === 0) return;
    for (const record of terminals.values()) {
      record.attached = false;
      record.droppedChunks = 0;
      record.problem = null;
      // Why a subscription ended is a fact about the connection that carried
      // it, and that connection is gone: what a pane shows now is the store's
      // own phase, which says the hub itself is unreachable.
      record.ended = null;
      record.subscribeId = null;
    }
    publishTerminals();
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) {
        unsubscribeWake = dependencies.wake?.(wake) ?? null;
        connect();
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
        if (listeners.size === 0) teardown();
      };
    },

    getSnapshot(): HubSnapshot {
      return snapshot;
    },

    retry,

    sendCommand(command: HubCommand): CommandOutcome {
      if (failed) {
        return {
          accepted: false,
          reason: snapshot.problem ?? 'the connection has failed and is not retrying',
        };
      }
      const wire = socket;
      if (established && wire !== null) {
        const id = frameIds.next();
        pending.add(id);
        rememberStart(command, id);
        wire.send(encodeClientFrame({ ...command, id }));
        return { accepted: true, id, delivery: 'sent' };
      }
      if (queue.length >= capacity) {
        const reason =
          `${String(capacity)} commands are already waiting for the connection to return; ` +
          'this one was not accepted';
        update({ commandQueue: queueView(reason) });
        return { accepted: false, reason };
      }
      const id = frameIds.next();
      queue.push({ id, command });
      rememberStart(command, id);
      update({ commandQueue: queueView(snapshot.commandQueue.overflowed) });
      return { accepted: true, id, delivery: 'queued' };
    },

    request(request: HubRequest): Promise<RequestOutcome> {
      const wire = socket;
      if (!established || wire === null) {
        // Refused rather than queued, and said in words the screen shows. The
        // pair frame carries the token a server printed; a queued one would be
        // that credential sitting in this tab's memory until the connection
        // came back, which may be never.
        return Promise.resolve({
          ok: false,
          reason:
            snapshot.problem ??
            'this page is not connected to the hub; nothing was sent, and nothing is queued',
        });
      }
      const id = frameIds.next();
      wire.send(encodeClientFrame({ ...request, id }));
      return new Promise<RequestOutcome>((resolve) => waiting.set(id, resolve));
    },

    sendTerminalInput(target: ClientTerminalTarget, data: string): TerminalInputOutcome {
      if (established && socket !== null) {
        // Answered only when it fails, which is the wire's rule and this
        // one's: a terminal acknowledges input by echoing it, so `delivered`
        // means it went out. A write that could not be made still comes back,
        // as a refusal naming this frame, and lands on the pane.
        sendTerminalFrame('input', terminalKey(target), (id) => ({
          type: 'terminal-input',
          id,
          target,
          data,
        }));
        return { delivered: true };
      }
      const discarded = snapshot.terminalInput.discarded + 1;
      const keystrokes = discarded === 1 ? 'keystroke was' : 'keystrokes were';
      update({
        terminalInput: {
          discarded,
          notice:
            `the connection is down: ${String(discarded)} ${keystrokes} discarded, ` +
            'not queued — nothing typed here will replay when it returns',
        },
      });
      return { delivered: false, reason: 'the connection is down; keystrokes are discarded' };
    },

    sendTerminalResize(target: ClientTerminalTarget, size: TerminalSize): void {
      const key = terminalKey(target);
      // A target nothing watches has no subscription for the hub to route a
      // resize to, and no record to remember it on: nothing to do. No pane
      // lands here, since a pane mounts its terminal only once it watches.
      const record = terminals.get(key);
      if (record === undefined) return;
      // Remembered whether or not it can be sent: the size is what the pane
      // currently is, and the next `session-subscribed` -- this connection's
      // first, or the one after a redial -- is when the far end hears it.
      record.size = size;
      if (!record.attached) return;
      sendTerminalFrame('resize', key, (id) => ({
        type: 'terminal-resize',
        id,
        target,
        size,
      }));
    },

    watchTerminal(target: ClientTerminalTarget): () => void {
      const key = terminalKey(target);
      const existing = terminals.get(key);
      if (existing !== undefined) {
        // One subscription per target, however many panes. The hub refuses a
        // second subscribe to one terminal from one connection -- a second
        // asks for a second replay -- so the right answer for a second pane
        // is the buffer the first one filled.
        existing.watchers += 1;
      } else {
        const record: TerminalRecord = {
          key,
          target,
          feed: createTerminalFeed({ maxBytes: feedBytes }),
          watchers: 1,
          attached: false,
          session:
            target.by === 'session'
              ? { storeId: target.storeId, sessionId: target.sessionId }
              : null,
          replayChunks: 0,
          droppedBytes: 0,
          droppedChunks: 0,
          printed: false,
          problem: null,
          ended: null,
          resumedAbove: null,
          subscribeId: null,
          size: null,
          bound: null,
        };
        terminals.set(key, record);
        // New interest on a live connection is sent now; on a dead one it is
        // not queued — the replay on the next welcome is what carries it.
        subscribeTerminal(record);
        publishTerminals();
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const record = terminals.get(key);
        if (record === undefined) return;
        record.watchers -= 1;
        if (record.watchers > 0) return;
        terminals.delete(key);
        unbind(record);
        // The standing interest is over, so the id that named it names nothing.
        if (record.subscribeId !== null) terminalReplies.delete(record.subscribeId);
        // The partner of the subscribe, and the whole difference between
        // closing a tab and killing an agent: the count this gives back is
        // the one the server evicts terminals by, and detaching closes
        // nothing.
        sendTerminalFrame('unsubscribe', key, (id) => ({
          type: 'session-unsubscribe',
          id,
          target,
        }));
        publishTerminals();
      };
    },

    subscribeLayout(): () => void {
      layoutWatchers += 1;
      if (layoutWatchers === 1 && established && socket !== null) {
        socket.send(encodeClientFrame({ type: 'layout-request', id: frameIds.next() }));
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        layoutWatchers -= 1;
      };
    },

    subscribePaneLayout(): () => void {
      paneLayoutWatchers += 1;
      if (paneLayoutWatchers === 1 && established && socket !== null) {
        socket.send(encodeClientFrame({ type: 'pane-layout-request', id: frameIds.next() }));
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        paneLayoutWatchers -= 1;
      };
    },

    queryCatalogue(query: CatalogueQuery): Promise<CataloguePageView> {
      return issueQuery(query);
    },

    queryCatalogueDetached(query: CatalogueQuery): Promise<CataloguePageView> {
      return issueQuery(query, 'detached');
    },

    subscribeCatalogue(): () => void {
      // Nothing is sent on the first subscriber, unlike the two above. There is
      // no question yet: a catalogue query carries a view, a sort and a filter
      // that only the screen knows, and this store has nothing to ask for until
      // that screen asks once.
      catalogueWatchers += 1;
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        catalogueWatchers -= 1;
      };
    },
  };
}
