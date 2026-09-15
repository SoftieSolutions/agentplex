import { describe, expect, it } from 'vitest';
import {
  encodeTerminalChunk,
  sessionIdSchema,
  storeIdSchema,
  type ServerToHubFrame,
} from '@agentplex/protocol';
import { createLogger, type LogRecord } from '@agentplex/node-shared';
import { routeServerFrame, type DrainingNotice, type StoreReport } from './frame-router.js';
import type { InstructionOutcome } from './servers.js';

/**
 * What a server says, and where each of it goes.
 *
 * The half of this suite that is about silence is the half worth having. Three
 * frames in the protocol have no handler in this build -- the ones the terminal
 * relay is made of -- and until the switch became exhaustive they parsed
 * cleanly and vanished with nothing anywhere saying so. A drop is now a debug
 * line that names the frame, which is the difference between "this build does
 * not do that yet" and "something ate a frame".
 */

const STORE = storeIdSchema.parse('store-work');
const SESSION = sessionIdSchema.parse('session-1');

interface Routed {
  readonly answers: readonly { replyTo: number; outcome: InstructionOutcome }[];
  readonly reports: readonly StoreReport[];
  readonly drains: readonly DrainingNotice[];
  readonly logged: readonly LogRecord[];
}

function route(frame: ServerToHubFrame): Routed {
  const answers: { replyTo: number; outcome: InstructionOutcome }[] = [];
  const reports: StoreReport[] = [];
  const drains: DrainingNotice[] = [];
  const logged: LogRecord[] = [];
  const logger = createLogger('debug', (record) => logged.push(record));

  routeServerFrame(
    frame,
    {
      onAnswer: (replyTo, outcome) => answers.push({ replyTo, outcome }),
      onReport: (report) => reports.push(report),
      onDraining: (notice) => drains.push(notice),
    },
    logger,
  );

  return { answers, reports, drains, logged };
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

describe('a drain notice', () => {
  it('goes to the loop that holds the connection, whole, and answers nobody', () => {
    // Whole, because the sessions on it are the point: they are what the
    // server is closing, named rather than left to be read off a store report
    // that may be older than this frame.
    const frame: ServerToHubFrame = {
      type: 'server-draining',
      graceMs: 15_000,
      sessions: [{ storeId: STORE, sessionId: SESSION }],
    };

    const routed = route(frame);

    expect(routed.drains).toEqual([frame]);
    expect(routed.answers).toEqual([]);
    expect(routed.reports).toEqual([]);
    // Not a drop, so nothing says it was one: the debug line below means "this
    // build is behind that server", and a drain that logged it would make the
    // line mean nothing.
    expect(routed.logged).toEqual([]);
  });
});

describe('a frame this build has no handler for', () => {
  const unhandled: readonly ServerToHubFrame[] = [
    {
      type: 'session-subscribed',
      replyTo: 6,
      storeId: STORE,
      sessionId: SESSION,
      startId: null,
      replayChunks: 0,
      droppedBytes: 0,
    },
    { type: 'session-unsubscribed', replyTo: 7 },
    {
      type: 'terminal-output',
      storeId: STORE,
      sessionId: SESSION,
      startId: null,
      chunk: encodeTerminalChunk(new TextEncoder().encode('ok\r\n')),
      droppedChunks: 0,
    },
    { type: 'doc-written', replyTo: 8, updatedAt: 1_700_000_000_000 },
    { type: 'doc-content', replyTo: 9, content: '# plan\n', updatedAt: 1_700_000_000_000 },
    { type: 'doc-listing', replyTo: 10, entries: [] },
  ];

  it.each(unhandled)('says so at debug rather than dropping $type in silence', (frame) => {
    const routed = route(frame);

    expect(routed.answers).toEqual([]);
    expect(routed.reports).toEqual([]);
    expect(routed.logged).toEqual([
      {
        level: 'debug',
        message: 'frame dropped: this hub build does not handle it yet',
        fields: { type: frame.type },
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
