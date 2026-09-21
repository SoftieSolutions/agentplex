import { describe, expect, it } from 'vitest';
import {
  approvalIdSchema,
  encodeTerminalChunk,
  sessionIdSchema,
  storeIdSchema,
  type ServerToHubFrame,
} from '@agentplex/protocol';
import { routeServerFrame, type DrainingNotice, type StoreReport } from './frame-router.js';
import type { InstructionOutcome, StreamAnswer, TerminalOutputFrame } from './servers.js';

/**
 * What a server says, and where each of it goes.
 *
 * Every frame the protocol carries now has somewhere to go, and the thing
 * worth asserting about them is that they go to different places: a document
 * reply and a start's are both answers to whoever asked, a drain notice is the
 * dial loop's, a subscription's reply is settled by whoever asked for the
 * watch, and a chunk of output is a stream nobody asked for. Telling those
 * apart is this file's job, not the transport's.
 *
 * What used to be the half of this suite worth having was the half about
 * silence: frames that parsed cleanly and vanished, and the debug line that
 * said so. There is nothing left for this build to drop, so that half is gone
 * and the exhaustiveness check is what stands in its place -- a frame added to
 * the protocol with no case fails typecheck rather than a test.
 */

const STORE = storeIdSchema.parse('store-work');
const APPROVAL = approvalIdSchema.parse('approval-1');
const SESSION = sessionIdSchema.parse('session-1');

interface Routed {
  readonly answers: readonly { replyTo: number; outcome: InstructionOutcome }[];
  readonly reports: readonly StoreReport[];
  readonly drains: readonly DrainingNotice[];
  readonly streamAnswers: readonly { replyTo: number; answer: StreamAnswer }[];
  readonly output: readonly TerminalOutputFrame[];
  readonly approvals: readonly ServerToHubFrame[];
}

function route(frame: ServerToHubFrame): Routed {
  const answers: { replyTo: number; outcome: InstructionOutcome }[] = [];
  const reports: StoreReport[] = [];
  const drains: DrainingNotice[] = [];
  const streamAnswers: { replyTo: number; answer: StreamAnswer }[] = [];
  const output: TerminalOutputFrame[] = [];
  const approvals: ServerToHubFrame[] = [];

  routeServerFrame(frame, {
    onAnswer: (replyTo, outcome) => answers.push({ replyTo, outcome }),
    onReport: (report) => reports.push(report),
    onDraining: (notice) => drains.push(notice),
    onStreamAnswer: (replyTo, answer) => streamAnswers.push({ replyTo, answer }),
    onOutput: (chunk) => output.push(chunk),
    onApprovalRequested: (requested) => approvals.push(requested),
    onApprovalWithdrawn: (withdrawn) => approvals.push(withdrawn),
    onApprovalSettled: (settled) => approvals.push(settled),
  });

  return { answers, reports, drains, streamAnswers, output, approvals };
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

  const documentReplies: readonly ServerToHubFrame[] = [
    { type: 'doc-written', replyTo: 6, updatedAt: 1_756_000_000_000 },
    { type: 'doc-content', replyTo: 7, content: '# Plan\n', updatedAt: 1_756_000_000_000 },
    { type: 'doc-listing', replyTo: 8, entries: [] },
  ];

  it.each(documentReplies)('carries the $type back to whoever asked for it', (frame) => {
    // A document reply is an answer like any other: it names the frame that
    // asked, so it goes to the caller and this router says nothing more about
    // documents than that.
    const routed = route(frame);

    expect(routed.answers).toEqual([
      { replyTo: 'replyTo' in frame ? frame.replyTo : 0, outcome: { ok: true, answer: frame } },
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
    // belongs to the heartbeat reading the same socket. Neither is this
    // switch's, and passing over one is not the same as losing it.
    const routed = route(frame);

    expect(routed.answers).toEqual([]);
    expect(routed.reports).toEqual([]);
  });
});

describe('what a machine says about an approval', () => {
  const said: readonly ServerToHubFrame[] = [
    {
      type: 'approval-requested',
      storeId: STORE,
      sessionId: SESSION,
      approval: {
        approvalId: APPROVAL,
        tool: 'Bash',
        proposal: 'prisma migrate deploy --schema ./db',
        suggestions: [],
      },
    },
    {
      type: 'approval-withdrawn',
      storeId: STORE,
      sessionId: SESSION,
      approvalId: APPROVAL,
    },
    {
      type: 'approval-settled',
      storeId: STORE,
      sessionId: SESSION,
      approvalId: APPROVAL,
      outcome: 'granted',
    },
  ];

  it.each(said)('routes $type to the feature holding it, and to no answer', (frame) => {
    // Unsolicited, every one of them: nobody asked, and there is no frame id
    // here to address. They used to fall out of this switch by name, which was
    // the protocol carrying an approval to a hub that did nothing with it.
    const routed = route(frame);

    expect(routed.approvals).toEqual([frame]);
    expect(routed.answers).toEqual([]);
    expect(routed.reports).toEqual([]);
  });
});
