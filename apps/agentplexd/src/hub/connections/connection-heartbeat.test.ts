import { describe, expect, it } from 'vitest';
import type { ServerToHubFrame } from '@agentplex/protocol';
import { createFakeMessageSocket, PEER_GONE } from '../../shared/fake-message-socket.js';
import { createFrameIdCounter } from '../../shared/ids.js';
import { createLogger } from '../../shared/logger.js';
import { createFakeTimers } from '../../shared/timers.js';
import { startHeartbeat } from './connection-heartbeat.js';

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

function beating() {
  const socket = createFakeMessageSocket();
  const timers = createFakeTimers();
  const heartbeat = startHeartbeat(socket, {
    timers,
    logger,
    nextFrameId: createFrameIdCounter(),
    intervalMs: 20_000,
    timeoutMs: 10_000,
  });
  return { socket, timers, heartbeat };
}

function reply(frame: ServerToHubFrame): string {
  return JSON.stringify(frame);
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

  it('keeps the connection when the pong names the ping', async () => {
    const { socket, timers } = beating();
    timers.fireAll();

    socket.receive(reply({ type: 'pong', replyTo: pings(socket.sent)[0] ?? 0 }));
    await settle();

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

  it('does not accept a pong that answers an earlier ping', async () => {
    // A stale pong is what a peer that went away mid-round-trip and came back
    // sends. Taking it for an answer to the outstanding ping would mean a
    // connection could be kept alive by echoes of itself.
    const { socket, timers } = beating();
    timers.fireAll();
    socket.receive(reply({ type: 'pong', replyTo: 1 }));
    await settle();
    timers.fireAll();

    socket.receive(reply({ type: 'pong', replyTo: 1 }));
    await settle();
    timers.fireAll();

    expect(socket.closure).not.toBeNull();
  });

  it('ignores every other frame, because they belong to somebody else', async () => {
    // The heartbeat shares the socket with whatever reads sessions off it. A
    // frame it does not understand is not its business and is certainly not a
    // reason to hang up.
    const { socket, timers } = beating();
    timers.fireAll();

    socket.receive('{"type":"handshake-accepted","replyTo":99,"protocolVersion":1,');
    socket.receive(reply({ type: 'protocol-error', code: 'bad-request', message: 'not mine' }));
    await settle();

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
