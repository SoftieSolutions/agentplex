import { describe, expect, it } from 'vitest';
import type { MachineLoad } from '@agentplex/protocol';
import {
  createFakeMessageSocket,
  PEER_GONE,
  createFakeTimers,
} from '@agentplex/node-shared/testing';
import { createFrameIdCounter, createLogger } from '@agentplex/node-shared';
import { startHeartbeat, type RoundTripReading } from './connection-heartbeat.js';
import type { Pong } from './frame-router.js';

/**
 * Liveness on a socket nobody is speaking on.
 *
 * The failure this exists for is the one TCP does not report: a laptop that
 * suspends, a NAT that drops the flow, a route that goes away. No close
 * arrives, `send` succeeds into nothing, and the hub goes on showing the
 * server as connected — which is exactly the badge-you-cannot-clear the
 * connectivity rule refuses. A ping that goes unanswered is the only evidence
 * available, so it is the one this asks for.
 */

const logger = createLogger('error', () => {});

/** The fake socket delivers asynchronously, as a real one does. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function pings(sent: readonly string[]): readonly number[] {
  return sent
    .map((text) => JSON.parse(text) as { type: string; id: number })
    .filter((frame) => frame.type === 'ping')
    .map((frame) => frame.id);
}

/**
 * A load as a server's pong carries it. The figures are one real machine's
 * answer, as `machine-state.test.ts` in the protocol package holds it.
 */
const LOAD: MachineLoad = {
  cpuCount: 14,
  cpu: { percent: 31.4, windowMs: 20_000 },
  loadAverage: [1.49951171875, 3.03271484375, 3.66796875],
};

const T0 = 1_756_000_000_000;

function beating() {
  const socket = createFakeMessageSocket();
  const timers = createFakeTimers();
  let now = T0;
  // Deliberately nowhere near the wall clock: `performance.now()` counts from
  // process start, so the two share nothing but the unit.
  let elapsed = 1_000.25;
  const clock = { now: () => now };
  const readings: RoundTripReading[] = [];
  const heartbeat = startHeartbeat(socket, {
    timers,
    clock,
    monotonic: () => elapsed,
    logger,
    nextFrameId: createFrameIdCounter(),
    onRoundTrip: (reading) => readings.push(reading),
    intervalMs: 20_000,
    timeoutMs: 10_000,
  });
  return {
    socket,
    timers,
    heartbeat,
    readings,
    /** Time passing: both the wall clock and the interval source move on. */
    advance: (ms: number) => {
      now += ms;
      elapsed += ms;
    },
    /** The wall clock stepping (NTP, a wake from sleep) while no time passes. */
    stepWallClock: (ms: number) => void (now += ms),
    /** The interval source alone moving, which a real one only ever does forwards. */
    stepMonotonic: (ms: number) => void (elapsed += ms),
    now: () => now,
  };
}

function pong(replyTo: number, load: MachineLoad | null = null): Pong {
  return { type: 'pong', replyTo, load };
}

describe('startHeartbeat', () => {
  it('sends nothing until the interval has passed', () => {
    const { socket } = beating();

    expect(socket.sent).toEqual([]);
  });

  it('pings when the interval elapses', () => {
    const { socket, timers } = beating();

    timers.fireAll();

    expect(pings(socket.sent)).toEqual([1]);
  });

  it('keeps the connection when the pong names the ping', () => {
    const { socket, timers, heartbeat } = beating();
    timers.fireAll();

    heartbeat.pong(pong(pings(socket.sent)[0] ?? 0));

    expect(socket.closure).toBeNull();
    // And it goes round again: the next ping is scheduled, not the timeout.
    timers.fireAll();
    expect(pings(socket.sent)).toEqual([1, 2]);
  });

  it('closes the connection when no pong arrives before the deadline', () => {
    const { socket, timers } = beating();

    // The interval, then the deadline the ping set.
    timers.fireAll();
    timers.fireAll();

    expect(socket.closure).not.toBeNull();
  });

  it('does not accept a pong that answers an earlier ping', () => {
    // A stale pong is what a peer that went away mid-round-trip and came back
    // sends. Taking it for an answer to the outstanding ping would mean a
    // connection could be kept alive by echoes of itself.
    const { socket, timers, heartbeat } = beating();
    timers.fireAll();
    heartbeat.pong(pong(1));
    timers.fireAll();

    heartbeat.pong(pong(1));
    timers.fireAll();

    expect(socket.closure).not.toBeNull();
  });

  it('reads nothing off the socket itself: the transport routes the pong here', async () => {
    // One parser and one switch per direction. A pong written straight onto
    // the socket reaches nobody unless the frame router hands it over, so the
    // deadline still closes a connection whose pongs nobody routed.
    const { socket, timers } = beating();
    timers.fireAll();

    socket.receive(JSON.stringify(pong(pings(socket.sent)[0] ?? 0)));
    await settle();
    timers.fireAll();

    expect(socket.closure).not.toBeNull();
  });

  it('times the round trip from the ping leaving to the pong arriving', () => {
    const { socket, timers, heartbeat, readings, advance, now } = beating();
    timers.fireAll();
    advance(12);

    heartbeat.pong(pong(pings(socket.sent)[0] ?? 0, LOAD));

    expect(readings).toEqual([{ ms: 12, load: LOAD, at: now() }]);
  });

  it('passes on the load exactly as the pong carried it, including none', () => {
    // `null` is a server that could not read its own cpus. The timing is still
    // a measurement, so the reading goes up with the load left empty rather
    // than being dropped with it.
    const { socket, timers, heartbeat, readings, advance } = beating();
    timers.fireAll();
    advance(40);

    heartbeat.pong(pong(pings(socket.sent)[0] ?? 0, null));

    expect(readings).toEqual([{ ms: 40, load: null, at: T0 + 40 }]);
  });

  it('publishes nothing before the first pong', () => {
    // No figure is the honest answer until one has been measured: a zero here
    // would draw as the fastest machine in the fleet.
    const { timers, readings } = beating();
    timers.fireAll();

    expect(readings).toEqual([]);
  });

  it('times each round from its own ping, not from the first', () => {
    const { socket, timers, heartbeat, readings, advance } = beating();
    timers.fireAll();
    advance(12);
    heartbeat.pong(pong(pings(socket.sent)[0] ?? 0));

    advance(20_000);
    timers.fireAll();
    advance(61);
    heartbeat.pong(pong(pings(socket.sent)[1] ?? 0));

    expect(readings.map((reading) => reading.ms)).toEqual([12, 61]);
  });

  it('measures nothing from a pong that answers an earlier ping', () => {
    // The echo that cannot keep a connection alive cannot time one either: the
    // interval between an old ping and a new pong is not a round trip.
    const { socket, timers, heartbeat, readings, advance } = beating();
    timers.fireAll();
    heartbeat.pong(pong(pings(socket.sent)[0] ?? 0));
    timers.fireAll();
    advance(5);

    heartbeat.pong(pong(pings(socket.sent)[0] ?? 0));

    expect(readings).toHaveLength(1);
  });

  it('measures nothing from a pong nobody asked for', () => {
    const { heartbeat, readings } = beating();

    heartbeat.pong(pong(1));

    expect(readings).toEqual([]);
  });

  it('times the true interval across a wall clock that jumped forward mid-round', () => {
    // An NTP step or a wake from sleep moves the wall clock by seconds while
    // the link took milliseconds. Timed by the wall clock, a healthy link would
    // publish as thirty seconds in the needs-you tone until the next round.
    const { socket, timers, heartbeat, readings, advance, stepWallClock, now } = beating();
    timers.fireAll();
    stepWallClock(30_000);
    advance(12);

    heartbeat.pong(pong(pings(socket.sent)[0] ?? 0, LOAD));

    // The interval from the interval source; the arrival from the wall clock,
    // which is what every other time a client is shown is dated by.
    expect(readings).toEqual([{ ms: 12, load: LOAD, at: now() }]);
  });

  it('times the true interval across a wall clock that stepped backwards mid-round', () => {
    const { socket, timers, heartbeat, readings, advance, stepWallClock } = beating();
    timers.fireAll();
    stepWallClock(-1_000);
    advance(7);

    heartbeat.pong(pong(pings(socket.sent)[0] ?? 0));

    expect(readings.map((reading) => reading.ms)).toEqual([7]);
    expect(socket.closure).toBeNull();
  });

  it('publishes whole milliseconds, because the interval source counts in fractions', () => {
    const { socket, timers, heartbeat, readings, stepMonotonic } = beating();
    timers.fireAll();
    stepMonotonic(12.6);

    heartbeat.pong(pong(pings(socket.sent)[0] ?? 0));

    expect(readings.map((reading) => reading.ms)).toEqual([13]);
  });

  it('keeps the connection but publishes no figure from an interval source that ran backwards', () => {
    // No real one does. A negative figure is still refused here rather than
    // downstream, where the client's parser would reject the whole state frame
    // carrying it; the pong proves the peer either way.
    const { socket, timers, heartbeat, readings, stepMonotonic } = beating();
    timers.fireAll();
    stepMonotonic(-1_000);

    heartbeat.pong(pong(pings(socket.sent)[0] ?? 0));

    expect(readings).toEqual([]);
    expect(socket.closure).toBeNull();
  });

  it('stops scheduling once stopped', () => {
    const { socket, timers, heartbeat } = beating();

    heartbeat.stop();
    timers.fireAll();

    expect(timers.pending).toBe(0);
    expect(socket.sent).toEqual([]);
  });

  it('stops itself when the socket closes, leaving no timer behind', async () => {
    const { socket, timers } = beating();

    socket.closeFromPeer(PEER_GONE);
    await settle();

    expect(timers.pending).toBe(0);
  });

  it('does not close a socket twice when the deadline and the peer race', () => {
    const { socket, timers } = beating();
    timers.fireAll();

    socket.closeFromPeer(PEER_GONE);
    timers.fireAll();

    expect(socket.closure).toEqual(PEER_GONE);
  });
});
