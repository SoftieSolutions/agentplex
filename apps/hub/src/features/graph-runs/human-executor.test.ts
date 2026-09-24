import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GRAPH_HUMAN_TIMEOUT_MAX_MINUTES,
  graphDocumentSchema,
  graphRunIdSchema,
  nodeIdSchema,
  type ApprovalOutcome,
  type ApprovalRequest,
  type GraphDocument,
  type GraphNode,
  type GraphRunId,
} from '@agentplex/protocol';
import { createFakeTimers, type FakeTimers } from '@agentplex/node-shared/testing';
import { createLogger, systemTimers, type Timers } from '@agentplex/node-shared';
import type { GraphRunAbout, GraphRunSubject } from '../approvals/approvals.js';
import { createHumanExecutor, type HumanExecutor } from './human-executor.js';
import type { Cancellation, StepContext, StepResult } from './walker.js';

/**
 * The HUMAN step: raise a request through the approvals feature, wait for
 * the word, and turn it into a step result.
 *
 * The approvals feature is a hand-written seam here, because what this file
 * is about is what the step does with the word -- and with a timeout and a
 * cancel arriving instead of one -- rather than how the word is decided. That
 * is `approvals.test.ts`'s subject. The timers are fake, so a two-minute wait
 * is a value a test fires.
 */

const logger = createLogger('error', () => {});
const RUN = graphRunIdSchema.parse('run-38');
const RELEASE = nodeIdSchema.parse('node-graph-release');

const BASE = {
  position: { x: 0, y: 0 },
  placement: { kind: 'cheapest' },
  retry: { max: 0, backoff: 1 },
};
const DOC: GraphDocument = graphDocumentSchema.parse({
  nodes: [
    { ...BASE, id: 'start', kind: 'trigger', label: 'PR opened', source: 'manual' },
    {
      ...BASE,
      id: 'gate',
      kind: 'human',
      label: 'Ship it',
      approvers: ['robert', 'ana'],
      timeoutMinutes: null,
    },
    {
      ...BASE,
      id: 'timed',
      kind: 'human',
      label: '',
      approvers: ['robert'],
      timeoutMinutes: 2,
    },
    {
      ...BASE,
      id: 'longest',
      kind: 'human',
      label: 'Sign-off',
      approvers: ['robert'],
      timeoutMinutes: GRAPH_HUMAN_TIMEOUT_MAX_MINUTES,
    },
  ],
  edges: [{ from: 'start', to: 'gate' }],
});

function humanNode(id: string): Extract<GraphNode, { kind: 'human' }> {
  const node = DOC.nodes.find((candidate) => candidate.id === id);
  if (node === undefined || node.kind !== 'human') throw new Error(`no HUMAN node ${id}`);
  return node;
}

interface Raised {
  readonly subject: GraphRunSubject;
  readonly request: ApprovalRequest;
  readonly about: GraphRunAbout;
  resolve(outcome: ApprovalOutcome): void;
}

let raised: Raised[];
let withdrawnRuns: GraphRunId[];
let timers: FakeTimers;
/** What the executor schedules on: the fake timers unless a test hands it the real ones. */
let scheduleOn: Timers;
let minted: number;
let waitingCalls: number;
let cancellation: Cancellation & { cancel(): void };

function fakeCancellation(): Cancellation & { cancel(): void } {
  const listeners = new Set<() => void>();
  let cancelled = false;
  return {
    get cancelled() {
      return cancelled;
    },
    onCancel(listener) {
      if (cancelled) listener();
      else listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    cancel() {
      cancelled = true;
      for (const listener of listeners) listener();
    },
  };
}

function executor(): HumanExecutor {
  return createHumanExecutor({
    approvals: {
      requestedByHub: (subject, request, about) =>
        new Promise((resolve) => raised.push({ subject, request, about, resolve })),
      withdrawnByHub: (runId) => {
        withdrawnRuns.push(runId);
        // The real feature resolves every promise the run holds with the word.
        for (const held of raised.filter((entry) => entry.subject.runId === runId)) {
          held.resolve('withdrawn');
        }
      },
    },
    ids: { newId: () => `approval-${String((minted += 1))}` },
    timers: scheduleOn,
    logger,
  });
}

function context(): StepContext {
  return {
    document: DOC,
    attempt: 0,
    cancellation,
    waiting: () => {
      waitingCalls += 1;
    },
  };
}

function step(id: string): Promise<StepResult> {
  const execute = executor().forRun({
    runId: RUN,
    number: 38,
    graph: RELEASE,
    graphName: 'release',
  });
  return execute(humanNode(id), { language: 'rust' }, context());
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('the HUMAN executor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    raised = [];
    withdrawnRuns = [];
    timers = createFakeTimers();
    scheduleOn = timers;
    minted = 0;
    waitingCalls = 0;
    cancellation = fakeCancellation();
  });

  it('raises one request naming the run, the node, and the graph, node label and approvers in words', async () => {
    void step('gate');
    await settle();

    expect(raised).toHaveLength(1);
    const [only] = raised;
    expect(only?.subject).toEqual({ kind: 'graphRun', runId: RUN, nodeId: 'gate' });
    expect(only?.about).toEqual({ graph: RELEASE, number: 38, nodeLabel: 'Ship it' });
    expect(only?.request.approvalId).toBe('approval-1');
    expect(only?.request.tool).toBe('HUMAN');
    expect(only?.request.proposal).toContain('release');
    expect(only?.request.proposal).toContain('Ship it');
    expect(only?.request.proposal).toContain('robert, ana');
    expect(only?.request.truncated).toBe(false);
    expect(only?.request.suggestions).toEqual([]);
    // And the walk was told the step is waiting, once.
    expect(waitingCalls).toBe(1);
  });

  it('succeeds and passes the input on when a person grants', async () => {
    const result = step('gate');
    await settle();
    raised[0]?.resolve('granted');

    await expect(result).resolves.toEqual({
      ok: true,
      carried: { language: 'rust' },
      output: null,
      next: null,
    });
    expect(timers.pending).toBe(0);
  });

  it('fails naming the node when a person denies', async () => {
    const result = step('gate');
    await settle();
    raised[0]?.resolve('denied');

    await expect(result).resolves.toEqual({ ok: false, problem: 'a person denied Ship it' });
  });

  it('waits as long as it takes when the node has no timeout', async () => {
    void step('gate');
    await settle();
    expect(timers.pending).toBe(0);
  });

  it('schedules the timeout through the injected timers, and on expiry withdraws and fails naming the node and the minutes', async () => {
    const result = step('timed');
    await settle();
    expect(timers.delays).toEqual([2 * 60_000]);

    timers.fireAll();

    expect(withdrawnRuns).toEqual([RUN]);
    await expect(result).resolves.toEqual({
      ok: false,
      // The node has no label, so its id names it.
      problem: 'timed waited 2 minutes for a person and nobody answered',
    });
  });

  it('keeps the longest timeout a node may have on a real timer, rather than firing it at once', async () => {
    // The system timers under vitest's clock: what is under test is the
    // delay Node's setTimeout is handed, which overflows past 2^31 - 1
    // milliseconds and fires after one.
    vi.useFakeTimers();
    scheduleOn = systemTimers;
    const result = step('longest');
    await vi.advanceTimersByTimeAsync(1);
    expect(withdrawnRuns).toEqual([]);

    await vi.advanceTimersByTimeAsync(GRAPH_HUMAN_TIMEOUT_MAX_MINUTES * 60_000 - 2);
    expect(withdrawnRuns).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(withdrawnRuns).toEqual([RUN]);
    await expect(result).resolves.toMatchObject({ ok: false });
  });

  it('cancels the timeout when a person answers first', async () => {
    const result = step('timed');
    await settle();
    raised[0]?.resolve('granted');
    await result;

    expect(timers.pending).toBe(0);
    expect(withdrawnRuns).toEqual([]);
  });

  it('takes the request back when the run is cancelled, and says so', async () => {
    const result = step('gate');
    await settle();

    cancellation.cancel();

    expect(withdrawnRuns).toEqual([RUN]);
    await expect(result).resolves.toEqual({
      ok: false,
      problem: 'the run was cancelled while Ship it was waiting on a person',
    });
  });

  it('fails in words when the request is withdrawn for a reason it did not cause', async () => {
    const result = step('gate');
    await settle();
    raised[0]?.resolve('withdrawn');

    await expect(result).resolves.toEqual({
      ok: false,
      problem: 'the request on Ship it was withdrawn before anybody answered',
    });
  });
});
