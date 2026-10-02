import type { HubToServerFrame, MachineLoad } from '@agentplex/protocol';
import {
  type Clock,
  type Logger,
  closure,
  CLOSE_POLICY,
  type MessageSocket,
  type Timers,
} from '@agentplex/node-shared';
import type { Pong } from './frame-router.js';

/**
 * Proof that a connected server is still there.
 *
 * TCP reports a close it was told about. It does not report a laptop that
 * suspended, a NAT that forgot the flow, or a route that went away: the socket
 * stays open, `send` succeeds into nothing, and no close ever arrives. Without
 * something asking, the hub would show that server as connected until the
 * process restarted -- and its sessions would keep counting toward attention
 * the whole time, which is precisely the badge nobody can clear by looking.
 *
 * So the hub asks. A ping that goes unanswered within the deadline is taken as
 * the connection being gone, and this closes it. Closing is the whole
 * interface: everything above already handles a connection that drops, and a
 * second notification channel for "dropped, but this way" would be two code
 * paths to the same state.
 *
 * The same round trip is the hub's measurement of how far away the machine is,
 * and the pong that ends it carries what the machine's cpus were doing. Both
 * go up as one reading, timed by the hub: only the end that dialled can time a
 * round trip, and the load is true of the instant the pong was written, so the
 * two are one fact about one moment.
 *
 * The interval is timed on a monotonic source and not on the wall clock. The
 * wall clock steps -- NTP corrects it, a laptop wakes and catches up -- and a
 * step between ping and pong would be published as the link's latency: a live
 * machine drawn at thirty seconds, in the tone that asks for attention, until
 * the next round. The wall clock only dates the reading.
 *
 * The pong is handed in rather than read off the socket here. It used to be
 * read here, with a parse of its own and a hand check of `type` beside the
 * frame router's -- two parsers for one direction, which is the thing
 * `frame-router.ts` exists to rule out. The transport routes it now.
 */

/** One completed heartbeat: how long it took, and what the pong said. */
export interface RoundTripReading {
  /** Pong arrival minus ping send, in whole ms by the monotonic source. Never negative. */
  readonly ms: number;
  /** The machine's load exactly as the parsed pong carried it. */
  readonly load: MachineLoad | null;
  /** When the pong arrived, by the hub's clock. */
  readonly at: number;
}

export interface HeartbeatDependencies {
  readonly timers: Timers;
  /** What a reading is dated with. Never what it is timed with: this one steps. */
  readonly clock: Clock;
  /**
   * What a round trip is timed with: milliseconds from an arbitrary origin that
   * never goes backwards and is not corrected, as `performance.now()` is.
   * Injected, so a test can say how long one took.
   */
  readonly monotonic: () => number;
  readonly logger: Logger;
  /**
   * The connection's frame id counter, continued rather than restarted.
   *
   * A frame id is unique within one connection, and the handshake already
   * spent the first one. A counter started again here would send a ping whose
   * id the handshake had used, which is the one thing an id is for.
   */
  readonly nextFrameId: () => number;
  /** Called with every round trip completed, and never for one that was not. */
  readonly onRoundTrip: (reading: RoundTripReading) => void;
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
}

/**
 * Quiet enough not to matter on a metered link, frequent enough that a machine
 * that went away is noticed in well under a minute.
 */
const DEFAULT_INTERVAL_MS = 20_000;

/**
 * How long a pong may take. Generous on purpose: this deadline being missed
 * costs a reconnect, and a reconnect on a link that was merely slow is worse
 * than noticing a dead peer ten seconds later.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface Heartbeat {
  /**
   * A pong the frame router took off this connection.
   *
   * One that names the ping outstanding ends the round and is timed; any other
   * -- an echo of an earlier ping, or one nobody asked for -- is passed over,
   * because it proves nothing about the link now.
   */
  pong(frame: Pong): void;
  /** Cancels whatever is scheduled. Safe to call more than once. */
  stop(): void;
}

export function startHeartbeat(
  socket: MessageSocket,
  dependencies: HeartbeatDependencies,
): Heartbeat {
  const { timers, clock, monotonic, logger, nextFrameId, onRoundTrip } = dependencies;
  const intervalMs = dependencies.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let stopped = false;
  let cancel: (() => void) | null = null;
  /** The ping waiting for an answer and when it left, or `null` between rounds. */
  let outstanding: { readonly id: number; readonly sentAt: number } | null = null;

  const stop = (): void => {
    stopped = true;
    cancel?.();
    cancel = null;
  };

  const send = (frame: HubToServerFrame): void => void socket.send(JSON.stringify(frame));

  const scheduleNextPing = (): void => {
    if (stopped) return;
    cancel = timers.schedule(intervalMs, () => {
      if (stopped) return;
      const id = nextFrameId();
      outstanding = { id, sentAt: monotonic() };
      send({ type: 'ping', id });
      cancel = timers.schedule(timeoutMs, () => {
        if (stopped) return;
        // Stopped before closing, so the close this triggers finds no timer
        // still scheduled behind it.
        stop();
        logger.warn('server stopped answering', { afterMs: timeoutMs });
        socket.close(closure(CLOSE_POLICY, `no pong within ${timeoutMs}ms`));
      });
    });
  };

  socket.onClose(stop);

  const pong = (frame: Pong): void => {
    if (stopped || outstanding === null || frame.replyTo !== outstanding.id) return;

    const ms = Math.round(monotonic() - outstanding.sentAt);
    outstanding = null;
    cancel?.();
    scheduleNextPing();

    // A monotonic source does not run backwards, so this is a broken one. The
    // pong still proves the peer is there, so the round is complete; what is
    // dropped is the figure, because the client's parser would refuse the whole
    // state frame carrying a negative one and zero would claim the fastest link
    // in the fleet.
    if (ms < 0) return;
    onRoundTrip({ ms, load: frame.load, at: clock.now() });
  };

  scheduleNextPing();

  return { pong, stop };
}
