import { describe, expect, it } from 'vitest';
import type { HubToServerFrame } from '@agentplex/protocol';
import { createLogger } from '@agentplex/node-shared';
import { createFakeTimers } from '@agentplex/node-shared/testing';
import { createStreamChannel, DEFAULT_STREAM_TIMEOUT_MS } from './stream-channel.js';
import type { StreamOutcome } from './servers.js';

/**
 * The terminal frames a connection is waiting on, and the two ways one settles.
 *
 * The subject is the half that has no equivalent in the instruction channel
 * beside it: a frame that is answered only when it fails. A subscribe gets a
 * reply, a keystroke gets one only when it could not be delivered, and this is
 * what keeps the second from accumulating a correlation per key pressed while
 * still being able to attribute a refusal to the frame that earned it.
 *
 * Answers are asserted to arrive *synchronously*, where the reply was read.
 * That is not a detail of this file: a server writes a subscription's reply and
 * the history it promised in the same turn, so a channel that settled on a
 * microtask would put a client's scrollback ahead of the frame counting it.
 */

const logger = createLogger('error', () => {});

interface Channel {
  readonly sent: readonly HubToServerFrame[];
  readonly settled: readonly StreamOutcome[];
  put(frame: Parameters<ReturnType<typeof createStreamChannel>['put']>[0]): void;
  settle(replyTo: number, outcome: StreamOutcome): boolean;
  settleAll(problem: string): void;
  /** Runs every deadline that is due, as the connection's timer would. */
  fireDeadlines(): void;
}

function channel(): Channel {
  const sent: HubToServerFrame[] = [];
  const settled: StreamOutcome[] = [];
  const timers = createFakeTimers();
  let nextId = 0;

  const built = createStreamChannel({
    timers,
    logger,
    nextFrameId: () => (nextId += 1),
    send: (frame) => void sent.push(frame),
  });

  return {
    get sent(): readonly HubToServerFrame[] {
      return sent;
    },
    get settled(): readonly StreamOutcome[] {
      return settled;
    },
    put(frame): void {
      built.put(frame, (outcome) => settled.push(outcome));
    },
    settle: built.settle,
    settleAll: built.settleAll,
    fireDeadlines(): void {
      timers.fireAll();
    },
  };
}

const TARGET = { by: 'start' as const, startId: 'start-2f9c' as never };

describe('a terminal frame put to a server', () => {
  it('goes out with the connection id it is answered by', () => {
    const held = channel();

    held.put({ type: 'session-subscribe', target: TARGET });

    expect(held.sent).toEqual([{ type: 'session-subscribe', id: 1, target: TARGET }]);
  });

  it('settles where the reply is read, not a microtask later', () => {
    const held = channel();
    held.put({ type: 'session-subscribe', target: TARGET });
    const answer = { type: 'session-unsubscribed', replyTo: 1 } as const;

    const took = held.settle(1, { ok: true, answer });

    expect(took).toBe(true);
    // Already settled, on this line, with nothing awaited. A promise here would
    // reorder a terminal.
    expect(held.settled).toEqual([{ ok: true, answer }]);
  });

  it('says when a reply is not one of its own, so a refusal can go elsewhere', () => {
    const held = channel();

    // A `session-refused` may be answering a start instead. The transport asks
    // the instruction channel first and this second; neither taking it means
    // the frame outlived its deadline.
    expect(held.settle(9, { ok: false, code: 'refused', problem: 'nothing asked' })).toBe(false);
    expect(held.settled).toEqual([]);
  });

  it('answers a silence with a silence, once the deadline has passed', () => {
    const held = channel();
    held.put({ type: 'terminal-input', target: TARGET, data: 'yes\r' });

    held.fireDeadlines();

    // Success for a keystroke is the server saying nothing at all: a terminal
    // acknowledges input by echoing it. The entry is dropped so that typing
    // cannot accumulate correlations without bound.
    expect(held.settled).toEqual([{ ok: true, answer: null }]);
    expect(held.settle(1, { ok: false, code: 'refused', problem: 'too late' })).toBe(false);
  });

  it('keeps a deadline off a frame that was already answered', () => {
    const held = channel();
    held.put({ type: 'session-subscribe', target: TARGET });
    held.settle(1, { ok: false, code: 'refused', problem: 'no such terminal' });

    held.fireDeadlines();

    expect(held.settled).toEqual([{ ok: false, code: 'refused', problem: 'no such terminal' }]);
  });

  it('settles everything still waiting when the connection ends', () => {
    const held = channel();
    held.put({ type: 'session-subscribe', target: TARGET });
    held.put({ type: 'terminal-resize', target: TARGET, size: { cols: 96, rows: 30 } });

    held.settleAll('the connection to the server ended before it answered');

    // A frame whose answer can no longer arrive is not a promise to leave
    // pending: the pane waiting on it is owed a sentence.
    expect(held.settled).toEqual([
      {
        ok: false,
        code: 'internal',
        problem: 'the connection to the server ended before it answered',
      },
      {
        ok: false,
        code: 'internal',
        problem: 'the connection to the server ended before it answered',
      },
    ]);
  });

  it('waits less than an instruction does, because none of these is slow', () => {
    // A subscribe reads a scrollback the server is already holding and a write
    // hands bytes to a pty. Neither scans a store or forks a process.
    expect(DEFAULT_STREAM_TIMEOUT_MS).toBeLessThan(30_000);
  });
});
