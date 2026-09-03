import {
  parseHubFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  type ClientFrame,
  type FrameId,
  type HubId,
  type Layout,
  type MachineState,
  type RefusalCode,
  type SessionHolder,
  type SessionRef,
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

export interface RefusalView {
  readonly code: RefusalCode;
  readonly message: string;
  readonly holder: SessionHolder | null;
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
  readonly commandQueue: CommandQueueView;
  readonly terminalInput: TerminalInputView;
  /** The hub's most recent "no", kept until a later command is answered yes. */
  readonly lastRefusal: RefusalView | null;
}

/**
 * A command is a client frame body without its id: ids belong to the store's
 * counter, minted at the moment of acceptance so a queued command keeps one
 * identity from enqueue to reply. `hello` and `ping` are not commands — the
 * connection machinery owns them — and `layout-request` is a subscription
 * (standing interest in the layout), not a request the user makes once.
 */
type CommandFrame = Extract<ClientFrame, { type: 'session-start' | 'session-stop' }>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type HubCommand = DistributiveOmit<CommandFrame, 'id'>;

export type CommandOutcome =
  | { readonly accepted: true; readonly id: FrameId; readonly delivery: 'sent' | 'queued' }
  | { readonly accepted: false; readonly reason: string };

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
  /** Sends now, or discards while the connection is down. Never queues. */
  sendTerminalInput(ref: SessionRef, data: string): TerminalInputOutcome;
  /** Standing interest in one session, replayed on every reconnection. */
  subscribeSession(ref: SessionRef): () => void;
  /** Standing interest in the stored layout, re-requested on every reconnection. */
  subscribeLayout(): () => void;
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
    commandQueue: { ...INITIAL_QUEUE, capacity },
    terminalInput: INITIAL_TERMINAL,
    lastRefusal: null,
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

  let layoutWatchers = 0;
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
      case 'session-started':
      case 'session-stopped': {
        pending.delete(frame.replyTo);
        update({ lastRefusal: null });
        return;
      }
      case 'refusal': {
        pending.delete(frame.replyTo);
        update({
          lastRefusal: { code: frame.code, message: frame.message, holder: frame.holder },
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

  function replaySubscriptions(): void {
    const wire = socket;
    if (wire === null) return;
    if (layoutWatchers > 0) {
      wire.send(encodeClientFrame({ type: 'layout-request', id: frameIds.next() }));
    }
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
    wire?.close();
    update({
      phase: 'idle',
      commandQueue: queueView(null),
      terminalInput: INITIAL_TERMINAL,
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
  };
}
