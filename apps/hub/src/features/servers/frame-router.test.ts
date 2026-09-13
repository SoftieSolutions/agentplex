import { describe, expect, it } from 'vitest';
import {
  encodeTerminalChunk,
  sessionIdSchema,
  storeIdSchema,
  type ServerToHubFrame,
} from '@agentplex/protocol';
import { createLogger, type LogRecord } from '@agentplex/node-shared';
import { routeServerFrame, type StoreReport } from './frame-router.js';
import type { InstructionOutcome, StreamAnswer, TerminalOutputFrame } from './servers.js';

/**
 * What a server says, and where each of it goes.
 *
 * The half of this suite that is about silence is still the half worth having.
 * One frame in the protocol has no handler in this build -- the drain notice --
 * and until the switch became exhaustive it and the three the terminal relay is
 * made of parsed cleanly and vanished with nothing anywhere saying so. A drop
 * is now a debug line that names the frame, which is the difference between
 * "this build does not do that yet" and "something ate a frame".
 *
 * The other three have somewhere to go now, and the thing worth asserting about
 * them is that they go to different places: a subscription's reply is settled
 * by whoever asked for it, and a chunk of output is a stream nobody asked for.
 * Telling those two apart is this file's job, not the transport's.
 */

const STORE = storeIdSchema.parse('store-work');
const SESSION = sessionIdSchema.parse('session-1');

interface Routed {
  readonly answers: readonly { replyTo: number; outcome: InstructionOutcome }[];
  readonly reports: readonly StoreReport[];
  readonly streamAnswers: readonly { replyTo: number; answer: StreamAnswer }[];
  readonly output: readonly TerminalOutputFrame[];
  readonly logged: readonly LogRecord[];
}

function route(frame: ServerToHubFrame): Routed {
  const answers: { replyTo: number; outcome: InstructionOutcome }[] = [];
  const reports: StoreReport[] = [];
  const streamAnswers: { replyTo: number; answer: StreamAnswer }[] = [];
  const output: TerminalOutputFrame[] = [];
  const logged: LogRecord[] = [];
  const logger = createLogger('debug', (record) => logged.push(record));

  routeServerFrame(
    frame,
    {
      onAnswer: (replyTo, outcome) => answers.push({ replyTo, outcome }),
      onReport: (report) => reports.push(report),
      onStreamAnswer: (replyTo, answer) => streamAnswers.push({ replyTo, answer }),
      onOutput: (chunk) => output.push(chunk),
    },
    logger,
  );

  return { answers, reports, streamAnswers, output, logged };
}

describe('an answer to an instruction', () => {
  it('reaches whoever asked, addressed by the frame it replies to', () => {
    const routed = route({
      type: 'session-started',
      replyTo: 4,
      storeId: STORE,
      sessionId: SESSION,
    });

    expect(routed.answers).toEqual([
      {
        replyTo: 4,
        outcome: {
          ok: true,
          answer: { type: 'session-started', replyTo: 4, storeId: STORE, sessionId: SESSION },
        },
      },
    ]);
    expect(routed.reports).toEqual([]);
  });

  it('carries a refusal back as a value, with the hold the server named on it', () => {
    const hold = { sessionId: SESSION, stoppable: true };
    const routed = route({
      type: 'session-refused',
      replyTo: 5,
      code: 'refused',
      message: 'that session is already running here',
      hold,
    });

    expect(routed.answers).toEqual([
      {
        replyTo: 5,
        outcome: {
          ok: false,
          code: 'refused',
          problem: 'that session is already running here',
          hold,
        },
      },
    ]);
  });
});

describe('a store report', () => {
  it('goes to the fleet state whole, and answers nobody', () => {
    const frame: StoreReport = {
      type: 'store-report',
      storeId: STORE,
      sessions: [],
      holding: [],
      starts: [],
    };

    const routed = route(frame);

    expect(routed.reports).toEqual([frame]);
    expect(routed.answers).toEqual([]);
  });
});

describe("a subscription's reply", () => {
  const replies: readonly StreamAnswer[] = [
    {
      type: 'session-subscribed',
      replyTo: 6,
      storeId: STORE,
      sessionId: SESSION,
      startId: null,
      replayChunks: 2,
      droppedBytes: 4_096,
    },
    { type: 'session-unsubscribed', replyTo: 7 },
  ];

  it.each(replies)('goes to whoever asked, and not to the instruction channel', (frame) => {
    const routed = route(frame);

    expect(routed.streamAnswers).toEqual([{ replyTo: frame.replyTo, answer: frame }]);
    // The one thing worth stating twice: a subscription is not an instruction,
    // and a hub that settled one with the other would resolve a start with a
    // reply to a watch.
    expect(routed.answers).toEqual([]);
    expect(routed.logged).toEqual([]);
  });
});

describe('a chunk of terminal output', () => {
  it('goes to the relay whole, answers nobody, and is not read on the way', () => {
    const chunk = encodeTerminalChunk(new TextEncoder().encode('ok\r\n'));
    const frame: TerminalOutputFrame = {
      type: 'terminal-output',
      storeId: STORE,
      sessionId: SESSION,
      startId: null,
      chunk,
      droppedChunks: 0,
    };

    const routed = route(frame);

    expect(routed.output).toEqual([frame]);
    expect(routed.output[0]?.chunk).toBe(chunk);
    expect(routed.answers).toEqual([]);
    expect(routed.streamAnswers).toEqual([]);
  });
});

describe('a frame this build has no handler for', () => {
  it('says so at debug rather than dropping the drain notice in silence', () => {
    const frame: ServerToHubFrame = { type: 'server-draining', graceMs: 15_000, sessions: [] };

    const routed = route(frame);

    expect(routed.answers).toEqual([]);
    expect(routed.reports).toEqual([]);
    expect(routed.logged).toEqual([
      {
        level: 'debug',
        message: 'frame dropped: this hub build does not handle it yet',
        fields: { type: 'server-draining' },
      },
    ]);
  });
});

describe('a frame that belongs to something other than this switch', () => {
  const elsewhere: readonly ServerToHubFrame[] = [
    {
      type: 'handshake-accepted',
      replyTo: 1,
      protocolVersion: 1,
      serverId: 'server-1',
      stores: [],
    },
    { type: 'handshake-rejected', replyTo: 1, reason: 'unauthorized' },
    { type: 'pong', replyTo: 2 },
    { type: 'protocol-error', code: 'bad-request', message: 'unreadable' },
  ] as readonly ServerToHubFrame[];

  it.each(elsewhere)('passes over $type without a word, because it is not a drop', (frame) => {
    // The handshake's frames belong to a handshake that is over and `pong`
    // belongs to the heartbeat reading the same socket. Logging these would
    // make the drop line above mean nothing: it is meant to be read as "this
    // build is behind that server", and a line per heartbeat would bury it.
    const routed = route(frame);

    expect(routed.answers).toEqual([]);
    expect(routed.reports).toEqual([]);
    expect(routed.logged).toEqual([]);
  });
});
