import {
  parseHubFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  type CatalogueItem,
  type CatalogueQuery,
  type ClientFrame,
  type DirectoryEntry,
  type FrameId,
  type HubFrame,
  type HubId,
  type Layout,
  type MachineState,
  type NodeId,
  type RefusalCode,
  type ServerRegistrationId,
  type SessionHolder,
  type SessionId,
  type SessionRef,
  type StoreId,
} from '@agentplex/protocol';
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
  /** Down for a reason retrying cannot fix — a protocol version mismatch. */
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

export interface HubSnapshot {
  readonly phase: ConnectionPhase;
  /** What is degraded, in words, or `null` while nothing is. */
  readonly problem: string | null;
  readonly hubId: HubId | null;
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
  readonly terminalInput: TerminalInputView;
  /** The hub's most recent "no", kept until a later command is answered yes. */
  readonly lastRefusal: RefusalView | null;
  /** The hub's most recent yes to a start, kept until the next one. */
  readonly lastStarted: StartedView | null;
  /** The hub's most recent yes to a stop, kept until the next one. */
  readonly lastStopped: StoppedView | null;
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
 * reconnection — so it is not a subscription. `project-create` and the five
 * tree edits are commands for the plainest reason of all: each is something
 * the user did once, and a queue is where a once-only intent waits.
 */
type CommandFrame = Extract<
  ClientFrame,
  {
    type:
      | 'session-start'
      | 'session-stop'
      | 'pane-layout-save'
      | 'directory-list'
      | 'project-create'
      | 'node-create-folder'
      | 'node-rename'
      | 'node-move'
      | 'node-remove'
      | 'node-forget-removal';
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
  sendTerminalInput(ref: SessionRef, data: string): TerminalInputOutcome;
  /** Standing interest in one session, replayed on every reconnection. */
  subscribeSession(ref: SessionRef): () => void;
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
   * How a session subscription goes on the wire, already encoded.
   *
   * The protocol has no session-subscribe frame yet — terminal frames arrive
   * with the milestone that implements them — so the replay machinery takes
   * the encoding as a seam. Until the seam is filled, interest is tracked and
   * replay sends nothing, which is the honest half of the behaviour.
   */
  encodeSessionSubscription?: (ref: SessionRef, id: FrameId) => string;
  /** How a terminal keystroke goes on the wire. The same seam, the same reason. */
  encodeTerminalInput?: (ref: SessionRef, data: string, id: FrameId) => string;
  /** Bounds the offline command queue. The default is deliberate; see below. */
  readonly maxQueuedCommands?: number;
  /** Reconnect backoff, first try to steady state. The last entry repeats. */
  readonly reconnectDelaysMs?: readonly number[];
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

/** The one place a client frame becomes characters. */
export function encodeClientFrame(frame: ClientFrame): string {
  return JSON.stringify(frame);
}

const INITIAL_QUEUE: Omit<CommandQueueView, 'capacity'> = { queued: 0, overflowed: null };
const INITIAL_TERMINAL: TerminalInputView = { discarded: 0, notice: null };

export function createHubStore(dependencies: HubStoreDependencies): HubStore {
  const { timers, frameIds } = dependencies;
  const capacity = dependencies.maxQueuedCommands ?? DEFAULT_MAX_QUEUED_COMMANDS;
  const delays = dependencies.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;

  const listeners = new Set<() => void>();
  let snapshot: HubSnapshot = {
    phase: 'idle',
    problem: null,
    hubId: null,
    machineState: null,
    layout: null,
    paneLayout: null,
    commandQueue: { ...INITIAL_QUEUE, capacity },
    terminalInput: INITIAL_TERMINAL,
    lastRefusal: null,
    lastStarted: null,
    lastStopped: null,
    lastListing: null,
    lastProjectCreated: null,
    lastTreeChange: null,
    catalogue: null,
  };

  let socket: StoreSocket | null = null;
  /** Bumped on every dial and on teardown, so a stale callback can tell. */
  let generation = 0;
  let established = false;
  /** True once a protocol mismatch has made retrying pointless. */
  let failed = false;
  /** Consecutive failed attempts since the connection last held. */
  let attempt = 0;
  let everConnected = false;
  let cancelRetry: (() => void) | null = null;

  const queue: { readonly id: FrameId; readonly command: HubCommand }[] = [];
  /** Sent commands awaiting a reply, by the id the reply will name. */
  const pending = new Set<FrameId>();
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
    { resolve(page: CataloguePageView): void; reject(error: Error): void }
  >();

  /** Tells every blocked caller the answer is not coming. */
  function abandonQueries(why: string): void {
    for (const waiting of [...pendingQueries.values()]) waiting.reject(new Error(why));
    pendingQueries.clear();
  }
  const sessionWatchers = new Map<string, { readonly ref: SessionRef; count: number }>();

  function update(changes: Partial<HubSnapshot>): void {
    snapshot = { ...snapshot, ...changes };
    for (const listener of [...listeners]) listener();
  }

  function queueView(overflowed: string | null): CommandQueueView {
    return { queued: queue.length, capacity, overflowed };
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
      socket = null;
      established = false;
      const unanswered = pending.size;
      pending.clear();
      settleWaiting('the connection dropped before the hub answered');
      abandonQueries('the connection dropped before the hub answered this catalogue query');
      if (unanswered > 0) {
        update({
          problem: `the connection dropped before the hub answered ${String(unanswered)} command${
            unanswered === 1 ? '' : 's'
          }`,
        });
      }
      scheduleRetry();
    });
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
          problem: null,
          // A fresh connection is a live terminal again; the discard notice
          // described a spell that has ended.
          terminalInput: INITIAL_TERMINAL,
        });
        replaySubscriptions();
        flushQueue();
        return;
      }
      case 'pong':
        return;
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
        update({
          lastRefusal: null,
          lastStarted: {
            replyTo: frame.replyTo,
            storeId: frame.storeId,
            sessionId: frame.sessionId,
            server: frame.server,
          },
        });
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
        // has to land somewhere a screen is looking.
        update({ catalogue: page });
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
      case 'refusal': {
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
        update({
          lastRefusal: {
            replyTo: frame.replyTo,
            code: frame.code,
            message: frame.message,
            holder: frame.holder,
          },
        });
        if (!established && frame.code === 'protocol-version') {
          // Redialling cannot change which protocol either side speaks, and a
          // capped backoff against a hub that will refuse forever is noise.
          failed = true;
          update({ phase: 'failed', problem: frame.message });
        }
        return;
      }
      case 'protocol-error': {
        // The hub could not read something this client sent. The hub closes
        // the socket after saying so, and a client that produced one
        // unreadable frame will produce the same one again — a build mismatch,
        // not weather — so retrying is pointless here too.
        failed = true;
        update({
          phase: 'failed',
          problem: `the hub could not read a frame this client sent: ${frame.message}`,
        });
        return;
      }
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
   * rather than the one before it.
   */
  function issueQuery(query: CatalogueQuery): Promise<CataloguePageView> {
    lastQuery = query;
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
      pendingQueries.set(id, { resolve, reject });
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
    const encode = dependencies.encodeSessionSubscription;
    if (encode !== undefined) {
      for (const { ref } of sessionWatchers.values()) {
        wire.send(encode(ref, frameIds.next()));
      }
    }
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
    });
  }

  function sessionKey(ref: SessionRef): string {
    // JSON, not a joined string: an opaque id may contain any separator.
    return JSON.stringify([ref.storeId, ref.sessionId]);
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) connect();
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

    sendTerminalInput(ref: SessionRef, data: string): TerminalInputOutcome {
      const wire = socket;
      if (established && wire !== null) {
        const encode = dependencies.encodeTerminalInput;
        if (encode === undefined) {
          return { delivered: false, reason: 'this build cannot send terminal input yet' };
        }
        wire.send(encode(ref, data, frameIds.next()));
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

    subscribeSession(ref: SessionRef): () => void {
      const key = sessionKey(ref);
      const existing = sessionWatchers.get(key);
      if (existing !== undefined) {
        existing.count += 1;
      } else {
        sessionWatchers.set(key, { ref, count: 1 });
        // New interest on a live connection is sent now; on a dead one it is
        // not queued — the replay on the next welcome is what carries it.
        const encode = dependencies.encodeSessionSubscription;
        if (established && socket !== null && encode !== undefined) {
          socket.send(encode(ref, frameIds.next()));
        }
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const entry = sessionWatchers.get(key);
        if (entry === undefined) return;
        entry.count -= 1;
        if (entry.count === 0) sessionWatchers.delete(key);
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
