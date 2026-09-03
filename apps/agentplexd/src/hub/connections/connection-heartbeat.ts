import { parseServerToHubFrame, parseTextFrame, type HubToServerFrame } from '@agentplex/protocol';
import type { Logger } from '../../shared/logger.js';
import { closure, CLOSE_POLICY, type MessageSocket } from '../../shared/message-socket.js';
import type { Timers } from '../../shared/timers.js';

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
 */

export interface HeartbeatDependencies {
  readonly timers: Timers;
  readonly logger: Logger;
  /**
   * The connection's frame id counter, continued rather than restarted.
   *
   * A frame id is unique within one connection, and the handshake already
   * spent the first one. A counter started again here would send a ping whose
   * id the handshake had used, which is the one thing an id is for.
   */
  readonly nextFrameId: () => number;
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
  /** Cancels whatever is scheduled. Safe to call more than once. */
  stop(): void;
}

export function startHeartbeat(
  socket: MessageSocket,
  dependencies: HeartbeatDependencies,
): Heartbeat {
  const { timers, logger, nextFrameId } = dependencies;
  const intervalMs = dependencies.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let stopped = false;
  let cancel: (() => void) | null = null;
  /** The ping waiting for an answer, or `null` between rounds. */
  let outstanding: number | null = null;

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
      outstanding = id;
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

  socket.onMessage((text) => {
    if (stopped || outstanding === null) return;

    // The one parser for this direction, as everywhere else. Frames that are
    // not pongs -- and text that is not a frame at all -- belong to whatever
    // else reads this socket, and are not this module's to complain about.
    const parsed = parseTextFrame(parseServerToHubFrame, text);
    if (!parsed.ok || parsed.value.type !== 'pong') return;
    if (parsed.value.replyTo !== outstanding) return;

    outstanding = null;
    cancel?.();
    scheduleNextPing();
  });

  scheduleNextPing();

  return { stop };
}
