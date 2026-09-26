import { CLIENT_PROTOCOL_VERSION, type FrameId } from '@agentplex/protocol';
import { encodeClientFrame } from './commands.js';
import type { FrameIds } from './frame-ids.js';
import type { Timers } from './timers.js';
import type { HubSnapshot } from './views.js';

/**
 * The socket's life, and nothing that travels on it: dialling, the backoff
 * between attempts, the heartbeat that notices a link the network dropped
 * without a word, and the one retry a person can ask for after a failure the
 * store will not retry on its own.
 *
 * What a connection going away means for everything that was waiting on it --
 * commands, requests, catalogue questions, terminals, runs -- is the store's
 * business and not this file's. It is told through `dropped`, and this file
 * owns none of that state.
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

export interface ConnectionDependencies {
  /** The token-for-ticket exchange. Rejection is an ordinary connect failure. */
  fetchTicket(): Promise<string>;
  /** Opens one socket with one ticket. The real one wraps `WebSocket`. */
  createSocket(ticket: string): StoreSocket;
  readonly timers: Timers;
  readonly frameIds: FrameIds;
  readonly reconnectDelaysMs?: readonly number[];
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly wake?: (fire: () => void) => () => void;
  /** Whether anything is listening to the store; a retry is scheduled only then. */
  watched(): boolean;
  /** The connection's own facts, said on the snapshot. */
  update(changes: Partial<Pick<HubSnapshot, 'phase' | 'problem'>>): void;
  /** One text frame, as the socket delivered it. */
  receive(text: string): void;
  /**
   * The connection is gone: everything that was waiting on it is answered.
   * `problem` is why, when the connection knows better than "it closed".
   */
  dropped(problem: string | null): void;
}

export interface Connection {
  /** The first listener arrived: dial, and listen for wakes. */
  start(): void;
  /** The last listener left: hang up, and forget everything about this one. */
  stop(): void;
  /** Dials again, now, after a failure; does nothing otherwise. */
  retry(): void;
  /** The hub said welcome: the connection holds, and the heartbeat starts. */
  welcomed(): void;
  /** The hub answered a ping. */
  ponged(replyTo: FrameId): void;
  /** Stops the store's own retrying until a person asks. */
  fail(): void;
  /** Whether a failure has stopped the store's own retrying. */
  failed(): boolean;
  /** Whether the hub has said welcome on the socket that is open now. */
  established(): boolean;
  /** The socket, while the connection is established; `null` otherwise. */
  live(): StoreSocket | null;
}

export function createConnection(dependencies: ConnectionDependencies): Connection {
  const { timers, frameIds, update } = dependencies;
  const delays = dependencies.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
  const heartbeatInterval = dependencies.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimeout = dependencies.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;

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
          protocolVersion: CLIENT_PROTOCOL_VERSION,
        }),
      );
    });
    opened.onMessage((text) => {
      if (mine !== generation) return;
      dependencies.receive(text);
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
    dependencies.dropped(problem);
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

  function scheduleRetry(): void {
    if (failed || !dependencies.watched()) return;
    const delay = delays[Math.min(attempt, delays.length - 1)] ?? 0;
    attempt += 1;
    update({ phase: 'reconnecting' });
    cancelRetry = timers.schedule(delay, connect);
  }

  return {
    start(): void {
      unsubscribeWake = dependencies.wake?.(wake) ?? null;
      connect();
    },

    stop(): void {
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
      wire?.close();
    },

    retry,

    welcomed(): void {
      established = true;
      failed = false;
      attempt = 0;
      everConnected = true;
      scheduleHeartbeat();
    },

    ponged(replyTo: FrameId): void {
      // Only the answer to the ping still open counts; an older one says
      // nothing about whether the latest question reached the hub.
      if (outstandingPing !== null && replyTo === outstandingPing) scheduleHeartbeat();
    },

    fail(): void {
      failed = true;
    },

    failed(): boolean {
      return failed;
    },

    established(): boolean {
      return established;
    },

    live(): StoreSocket | null {
      return established ? socket : null;
    },
  };
}
