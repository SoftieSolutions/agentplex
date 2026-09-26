import {
  assertNever,
  parseHubFrame,
  parseTextFrame,
  type CatalogueQuery,
  type ClientTerminalTarget,
  type FrameId,
  type TerminalSize,
} from '@agentplex/protocol';
import { DEFAULT_FEED_BYTES } from '../terminal/chunk-feed.js';
import { NO_ANSWERS, rememberAnswer, type Answers, type Reply } from './answers.js';
import { createCatalogueChannel } from './catalogue-replies.js';
import {
  encodeClientFrame,
  type CommandOutcome,
  type HubCommand,
  type HubRequest,
  type RequestOutcome,
  type TerminalInputOutcome,
} from './commands.js';
import { createConnection, type StoreSocket } from './connection.js';
import type { FrameIds } from './frame-ids.js';
import { createGraphReplies } from './graph-replies.js';
import { createSessionReplies } from './session-replies.js';
import { createTerminals } from './terminals.js';
import type { Timers } from './timers.js';
import type {
  CataloguePageView,
  CommandQueueView,
  HubSnapshot,
  TerminalInputView,
} from './views.js';

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

const INITIAL_QUEUE: Omit<CommandQueueView, 'capacity'> = { queued: 0, overflowed: null };
const INITIAL_TERMINAL: TerminalInputView = { discarded: 0, notice: null };

export function createHubStore(dependencies: HubStoreDependencies): HubStore {
  const { frameIds } = dependencies;
  const capacity = dependencies.maxQueuedCommands ?? DEFAULT_MAX_QUEUED_COMMANDS;

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
    answers: NO_ANSWERS,
    starts: new Map(),
    approvalPolicies: new Map(),
    catalogue: null,
    graphDocuments: new Map(),
    runs: new Map(),
    runHistories: new Map(),
    pushPublicKey: null,
    transcripts: new Map(),
  };

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

  function update(changes: Partial<HubSnapshot>): void {
    snapshot = { ...snapshot, ...changes };
    for (const listener of [...listeners]) listener();
  }

  /**
   * `replies` with what is owed now: every frame sent and not answered, and
   * every frame queued. Derived from `pending` and the queue rather than kept
   * beside them, so there is one record of what is out and it cannot drift.
   */
  function answersWith(replies: ReadonlyMap<FrameId, Reply>): Answers {
    return { replies, outstanding: new Set([...pending, ...queue.map(({ id }) => id)]) };
  }

  /** Files the hub's answer under the frame it names, for whoever sent that frame. */
  function remember(reply: Reply): void {
    pending.delete(reply.replyTo);
    update({ answers: answersWith(rememberAnswer(snapshot.answers.replies, reply)) });
  }

  /** A frame answered by something `answers` does not keep: it is owed nothing now. */
  function settle(id: FrameId): void {
    if (pending.delete(id)) update({ answers: answersWith(snapshot.answers.replies) });
  }

  const connection = createConnection({
    ...dependencies,
    watched: () => listeners.size > 0,
    update,
    receive,
    dropped,
  });
  const terminals = createTerminals({
    live: connection.live,
    frameIds,
    feedBytes: dependencies.terminalFeedBytes ?? DEFAULT_FEED_BYTES,
    publish: (views) => update({ terminals: views }),
  });
  const catalogue = createCatalogueChannel({
    live: connection.live,
    frameIds,
    problem: () => snapshot.problem,
    update,
  });
  const graphs = createGraphReplies({ snapshot: () => snapshot, update });
  const sessions = createSessionReplies({ update });

  function queueView(overflowed: string | null): CommandQueueView {
    return { queued: queue.length, capacity, overflowed };
  }

  /**
   * The connection is gone: everything that was waiting on it is answered.
   *
   * `problem` is why, when the connection knows better than "it closed"; a
   * close the socket reported words only the commands it stranded.
   */
  function dropped(problem: string | null): void {
    const unanswered = pending.size;
    pending.clear();
    settleWaiting('the connection dropped before the hub answered');
    catalogue.abandon('the connection dropped before the hub answered this catalogue query');
    terminals.detach();
    // A run held across a drop is where it was when the socket went, and
    // nothing on the next one moves it until a state or a read's answer
    // arrives: a screen mounted meanwhile must not draw it live.
    const heldRuns = graphs.dropRuns();
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
        // A frame stranded on this socket is not answered on the next one, so
        // it is owed nothing: the screen that sent it stops waiting, and the
        // line above is what says why. A queued frame is still owed.
        ...(unanswered > 0 ? { answers: answersWith(snapshot.answers.replies) } : {}),
      });
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
        connection.welcomed();
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
        return;
      }
      case 'pong': {
        connection.ponged(frame.replyTo);
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
        settle(frame.replyTo);
        return;
      }
      case 'session-started': {
        remember(frame);
        sessions.started(frame);
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
        terminals.retryByStart(frame.replyTo);
        return;
      }
      // Answers and nothing more: the screen that sent the frame reads its own
      // out of `answers`, and what it draws next comes from the state. None of
      // them asks for the tree again. The hub broadcasts `catalogue-changed`
      // after every change to the tree, and asking on the reply as well would
      // be two requests for one change -- on the only client that already
      // knows. A save, a publish or a run changes nothing the tree carries.
      case 'session-stopped':
      case 'session-paused':
      case 'session-resumed':
      case 'session-attention':
      case 'approval-decided':
      case 'push-subscribed':
      case 'push-unsubscribed':
      case 'directory-listing':
      case 'project-created':
      case 'node-created':
      case 'node-renamed':
      case 'node-moved':
      case 'node-removed':
      case 'node-removal-forgotten':
      case 'doc-created':
      case 'doc-saved':
      case 'doc-content':
      case 'graph-created':
      case 'graph-saved':
      case 'graph-published':
      case 'graph-run-started':
      case 'graph-run-cancelled':
      case 'graph-simulated': {
        remember(frame);
        return;
      }
      case 'approval-policy': {
        remember(frame);
        // Replaced whole, and by the project the frame names rather than by
        // whichever question was asked: list, add and remove all answer with
        // the policy as it now stands, so there is nothing here to apply and
        // nothing to get wrong. A client that applied its own add would be a
        // client holding a policy nobody vouched for.
        const policies = new Map(snapshot.approvalPolicies);
        policies.set(frame.projectId, { replyTo: frame.replyTo, rules: frame.rules });
        update({ approvalPolicies: policies });
        return;
      }
      case 'server-paired':
      case 'server-unpaired': {
        waiting.get(frame.replyTo)?.({ ok: true, reply: frame });
        waiting.delete(frame.replyTo);
        return;
      }
      case 'graph-document': {
        // Filed before it is settled, so it is never owed nothing and nowhere.
        graphs.document(frame);
        settle(frame.replyTo);
        return;
      }
      case 'graph-run-state': {
        graphs.state(frame);
        return;
      }
      case 'graph-run-latest': {
        // The answer to a read, and to an open of one run: either way it is
        // addressed, and the frame that asked is settled here.
        remember(frame);
        graphs.latest(frame);
        return;
      }
      case 'graph-run-history': {
        remember(frame);
        graphs.history(frame);
        return;
      }
      case 'session-transcript-read': {
        sessions.transcript(frame);
        settle(frame.replyTo);
        return;
      }
      case 'catalogue-page': {
        catalogue.answered(frame);
        return;
      }
      case 'catalogue-changed': {
        // Unsolicited, and the only frame that makes this store ask for
        // something on its own account. It carries a version and no nodes, so
        // the honest response is to re-read what this client is actually
        // drawing — and a client watching neither a layout nor a catalogue does
        // nothing at all.
        requestLayout();
        catalogue.reissue();
        return;
      }
      case 'session-subscribed': {
        terminals.subscribed(frame);
        return;
      }
      case 'session-unsubscribed': {
        terminals.unsubscribed(frame);
        return;
      }
      case 'session-subscription-ended': {
        terminals.ended(frame);
        return;
      }
      case 'terminal-output': {
        terminals.output(frame);
        return;
      }
      case 'refusal': {
        // A refusal about a terminal frame is said on its pane and nowhere else.
        if (terminals.refused(frame)) return;
        remember(frame);
        // A refusal answers a request as surely as a reply does, and its words
        // are the hub's own: filed under the frame it refuses, like a yes.
        waiting.get(frame.replyTo)?.({ ok: false, reason: frame.message });
        waiting.delete(frame.replyTo);
        catalogue.refused(frame);
        // And against the start it answers, when it answers one.
        sessions.refused(frame);
        if (!connection.established() && frame.code === 'protocol-version') {
          // Redialling on a timer cannot change which protocol either side
          // speaks, and a capped backoff against a hub that will refuse
          // forever is noise. A new build can, and it arrives when somebody
          // deploys one: so the store stops here and a person retries.
          connection.fail();
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
        connection.fail();
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
    const wire = connection.live();
    if (wire === null || layoutWatchers === 0) return;
    wire.send(encodeClientFrame({ type: 'layout-request', id: frameIds.next() }));
  }

  function replaySubscriptions(): void {
    const wire = connection.live();
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
    catalogue.reissue();
    terminals.resubscribe();
  }

  function flushQueue(): void {
    const wire = connection.live();
    if (wire === null) return;
    for (const { id, command } of queue.splice(0)) {
      pending.add(id);
      wire.send(encodeClientFrame({ ...command, id }));
    }
    update({ commandQueue: queueView(null) });
  }

  function teardown(): void {
    connection.stop();
    // Queued commands go with the connection: their replies would reach a page
    // nobody is looking at, and replaying stored intent minutes later against
    // a hub that moved on is the surprise the bound exists to prevent.
    queue.length = 0;
    pending.clear();
    settleWaiting('the page stopped listening to the hub before it answered');
    catalogue.stop();
    terminals.detach();
    update({
      phase: 'idle',
      commandQueue: queueView(null),
      terminalInput: INITIAL_TERMINAL,
      // An answer is to a frame some screen sent on a connection that is now
      // over, and the next one to look sends its own. Among them are a
      // directory listing of somebody else's disk as it was, a document that
      // may have been edited on its own machine meanwhile, and a simulated
      // path through a draft that may have moved: copies this store cannot
      // vouch for.
      answers: NO_ANSWERS,
      // A catalogue page is pinned to a version this hub run may not be at
      // when somebody looks again.
      catalogue: null,
      // A graph's draft is the hub's, and another client may have saved it
      // while nothing here was connected: a copy this store cannot vouch
      // for, so the screen asks again when it is looked at.
      graphDocuments: new Map(),
      // A run moves on the hub's own clock. What this store held is where a
      // run was when the socket went, and the next state to arrive is whole.
      runs: new Map(),
      // A run may have started or ended meanwhile, so a list held from then
      // is a list nobody can vouch for; the screen asks again.
      runHistories: new Map(),
      // And the same again: the transcript file goes on being appended to on
      // its own machine while nothing here is connected.
      transcripts: new Map(),
    });
    sessions.forget();
    graphs.forget();
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) connection.start();
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

    retry: connection.retry,

    sendCommand(command: HubCommand): CommandOutcome {
      if (connection.failed()) {
        return {
          accepted: false,
          reason: snapshot.problem ?? 'the connection has failed and is not retrying',
        };
      }
      const wire = connection.live();
      if (wire !== null) {
        const id = frameIds.next();
        pending.add(id);
        // Owed from now, and replaced without a notification: the one reader
        // is whoever sent it, who has the id only once this returns, and a
        // listener that sends on a change would be told first and send again.
        snapshot = { ...snapshot, answers: answersWith(snapshot.answers.replies) };
        sessions.asked(command, id);
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
      update({
        commandQueue: queueView(snapshot.commandQueue.overflowed),
        answers: answersWith(snapshot.answers.replies),
      });
      sessions.asked(command, id);
      return { accepted: true, id, delivery: 'queued' };
    },

    request(request: HubRequest): Promise<RequestOutcome> {
      const wire = connection.live();
      if (wire === null) {
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
      if (terminals.input(target, data)) return { delivered: true };
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

    sendTerminalResize: terminals.resize,

    watchTerminal: terminals.watch,

    subscribeLayout(): () => void {
      layoutWatchers += 1;
      const wire = connection.live();
      if (layoutWatchers === 1 && wire !== null) {
        wire.send(encodeClientFrame({ type: 'layout-request', id: frameIds.next() }));
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
      const wire = connection.live();
      if (paneLayoutWatchers === 1 && wire !== null) {
        wire.send(encodeClientFrame({ type: 'pane-layout-request', id: frameIds.next() }));
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        paneLayoutWatchers -= 1;
      };
    },

    queryCatalogue: catalogue.query,

    queryCatalogueDetached: catalogue.queryDetached,

    subscribeCatalogue: catalogue.subscribe,
  };
}
