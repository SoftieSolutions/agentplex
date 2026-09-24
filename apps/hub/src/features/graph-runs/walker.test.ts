import { describe, expect, it } from 'vitest';
import {
  graphDocumentSchema,
  type GraphDocument,
  type GraphRunStep,
  type RouteInput,
} from '@agentplex/protocol';
import { createFakeTimers } from '@agentplex/node-shared/testing';
import {
  routerExecutor,
  triggerExecutor,
  walk,
  type Executor,
  type ExecutorTable,
  type WalkOutcome,
} from './walker.js';

/**
 * The walk, pure: a document, an input, a table of executors and injected
 * timers, and out come the steps and how the run ended. No database, no
 * machine and no clock anywhere in here -- the AGENT executor is a function
 * this suite writes, so what is under test is the traversal, the retry and
 * the cancel, and nothing an executor does.
 */

const BASE = {
  position: { x: 0, y: 0 },
  placement: { kind: 'cheapest' },
  retry: { max: 0, backoff: 1 },
};
const TRIGGER = { ...BASE, id: 'start', kind: 'trigger', label: 'PR opened', source: 'manual' };
const AGENT = {
  ...BASE,
  id: 'review',
  kind: 'agent',
  label: 'Rust reviewer',
  prompt: 'Review the Rust in this change.',
  provider: 'claude',
  storeId: 'store-work',
};
const DOCS_AGENT = { ...AGENT, id: 'docs', label: 'Docs reviewer' };

function document(value: unknown): GraphDocument {
  return graphDocumentSchema.parse(value);
}

/** An AGENT executor that answers what it is told and records what it saw. */
function agent(
  answer: (attempt: number) => Promise<{ ok: true } | { ok: false; problem: string }>,
): { execute: Executor<'agent'>; readonly calls: { attempt: number; prompt: string }[] } {
  const calls: { attempt: number; prompt: string }[] = [];
  return {
    calls,
    execute: async (node, input, context) => {
      calls.push({ attempt: context.attempt, prompt: node.prompt });
      const answered = await answer(context.attempt);
      if (!answered.ok) return answered;
      return {
        ok: true,
        output: {
          storeId: node.storeId,
          sessionId: `session-${String(context.attempt)}`,
          status: 'idle',
        },
        next: null,
      };
    },
  };
}

function table(execute: Executor<'agent'>): ExecutorTable {
  return { trigger: triggerExecutor, router: routerExecutor, agent: execute };
}

interface Driven {
  readonly steps: GraphRunStep[];
  readonly reached: number[];
  readonly timers: ReturnType<typeof createFakeTimers>;
  readonly done: Promise<WalkOutcome>;
  cancel(): void;
}

function drive(doc: GraphDocument, input: RouteInput, executors: ExecutorTable): Driven {
  const steps: GraphRunStep[] = [];
  const reached: number[] = [];
  const timers = createFakeTimers();
  const handle = walk(doc, input, {
    executors,
    timers,
    onStep: (step, at) => {
      steps.push(step);
      reached.push(at);
    },
  });
  return { steps, reached, timers, done: handle.done, cancel: () => handle.cancel() };
}

/** Lets promise chains settle without a timer firing. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('walk', () => {
  it('starts at the TRIGGER, passes the input on, and succeeds at the last node', async () => {
    const doc = document({ nodes: [TRIGGER, AGENT], edges: [{ from: 'start', to: 'review' }] });
    const reviewer = agent(async () => ({ ok: true }));

    const run = drive(doc, { language: 'rust' }, table(reviewer.execute));

    await expect(run.done).resolves.toEqual({
      status: 'succeeded',
      output: { storeId: 'store-work', sessionId: 'session-0', status: 'idle' },
    });
    expect(run.steps).toEqual([
      { nodeId: 'start', attempt: 0, outcome: 'running', output: null },
      { nodeId: 'start', attempt: 0, outcome: 'succeeded', output: { language: 'rust' } },
      { nodeId: 'review', attempt: 0, outcome: 'running', output: null },
      {
        nodeId: 'review',
        attempt: 0,
        outcome: 'succeeded',
        output: { storeId: 'store-work', sessionId: 'session-0', status: 'idle' },
      },
    ]);
    // The step count is the nodes reached: 1 at the trigger, 2 at the agent.
    expect(run.reached).toEqual([1, 1, 2, 2]);
    expect(reviewer.calls).toEqual([{ attempt: 0, prompt: 'Review the Rust in this change.' }]);
  });

  it('hands each executor the previous step’s output as its input', async () => {
    const doc = document({
      nodes: [
        TRIGGER,
        {
          ...BASE,
          id: 'classify',
          kind: 'router',
          label: 'Classify',
          model: 'haiku',
          routes: [{ condition: 'language == rust', to: 'review' }],
          otherwise: 'docs',
        },
        AGENT,
        DOCS_AGENT,
      ],
      edges: [{ from: 'start', to: 'classify' }],
    });
    const seen: RouteInput[] = [];
    const executors: ExecutorTable = {
      trigger: triggerExecutor,
      router: routerExecutor,
      agent: async (node, input) => {
        seen.push(input);
        return { ok: true, output: { ran: node.id }, next: null };
      },
    };

    await drive(doc, { language: 'rust' }, executors).done;

    expect(seen).toEqual([{ language: 'rust' }]);
  });

  describe('ROUTER', () => {
    const routed = document({
      nodes: [
        TRIGGER,
        {
          ...BASE,
          id: 'classify',
          kind: 'router',
          label: 'Classify diff',
          model: 'haiku',
          routes: [
            { condition: 'language == rust', to: 'review' },
            { condition: 'only docs/**', to: 'docs' },
          ],
          otherwise: null,
        },
        AGENT,
        DOCS_AGENT,
      ],
      edges: [{ from: 'start', to: 'classify' }],
    });

    it('takes the first route whose condition holds', async () => {
      const reviewer = agent(async () => ({ ok: true }));
      const run = drive(
        routed,
        { language: 'rust', files: ['docs/a.md'] },
        table(reviewer.execute),
      );

      await expect(run.done).resolves.toMatchObject({ status: 'succeeded' });
      expect(
        run.steps.filter((step) => step.outcome === 'succeeded').map((step) => step.nodeId),
      ).toEqual(['start', 'classify', 'review']);
    });

    it('falls through to the next route when the first does not hold', async () => {
      const reviewer = agent(async () => ({ ok: true }));
      const run = drive(routed, { language: 'go', files: ['docs/a.md'] }, table(reviewer.execute));

      await expect(run.done).resolves.toMatchObject({ status: 'succeeded' });
      expect(run.steps.at(-1)?.nodeId).toBe('docs');
    });

    it('takes otherwise when no route holds', async () => {
      const doc = document({
        ...routed,
        nodes: routed.nodes.map((node) =>
          node.kind === 'router' ? { ...node, otherwise: 'docs' } : node,
        ),
      });
      const reviewer = agent(async () => ({ ok: true }));
      const run = drive(doc, { language: 'go', files: ['src/a.go'] }, table(reviewer.execute));

      await expect(run.done).resolves.toMatchObject({ status: 'succeeded' });
      expect(run.steps.at(-1)?.nodeId).toBe('docs');
    });

    it('fails the run naming the node when nothing holds and there is no otherwise', async () => {
      const reviewer = agent(async () => ({ ok: true }));
      const run = drive(routed, { language: 'go', files: ['src/a.go'] }, table(reviewer.execute));

      await expect(run.done).resolves.toEqual({
        status: 'failed',
        reason:
          'the ROUTER node Classify diff failed: no route on Classify diff matched and it has no otherwise',
      });
      expect(run.steps.at(-1)).toEqual({
        nodeId: 'classify',
        attempt: 0,
        outcome: 'failed',
        output: null,
      });
      expect(reviewer.calls).toEqual([]);
    });
  });

  describe('retry', () => {
    const retried = document({
      nodes: [TRIGGER, { ...AGENT, retry: { max: 2, backoff: 30 } }],
      edges: [{ from: 'start', to: 'review' }],
    });

    it('tries again after the backoff, through the injected timers, up to max', async () => {
      const reviewer = agent(async (attempt) =>
        attempt < 2 ? { ok: false, problem: `try ${String(attempt)} broke` } : { ok: true },
      );
      const run = drive(retried, {}, table(reviewer.execute));

      await settle();
      expect(reviewer.calls.map((call) => call.attempt)).toEqual([0]);
      expect(run.timers.delays).toEqual([30_000]);
      run.timers.fireAll();
      await settle();
      expect(reviewer.calls.map((call) => call.attempt)).toEqual([0, 1]);
      run.timers.fireAll();

      await expect(run.done).resolves.toMatchObject({ status: 'succeeded' });
      expect(run.steps.filter((step) => step.nodeId === 'review')).toEqual([
        { nodeId: 'review', attempt: 0, outcome: 'running', output: null },
        { nodeId: 'review', attempt: 0, outcome: 'failed', output: null },
        { nodeId: 'review', attempt: 1, outcome: 'running', output: null },
        { nodeId: 'review', attempt: 1, outcome: 'failed', output: null },
        { nodeId: 'review', attempt: 2, outcome: 'running', output: null },
        {
          nodeId: 'review',
          attempt: 2,
          outcome: 'succeeded',
          output: { storeId: 'store-work', sessionId: 'session-2', status: 'idle' },
        },
      ]);
    });

    it('fails the run after the last attempt, with the last problem in the sentence', async () => {
      const reviewer = agent(async (attempt) => ({
        ok: false,
        problem: `try ${String(attempt)} broke`,
      }));
      const run = drive(retried, {}, table(reviewer.execute));

      for (let round = 0; round < 3; round += 1) {
        await settle();
        run.timers.fireAll();
      }

      await expect(run.done).resolves.toEqual({
        status: 'failed',
        reason: 'the AGENT node Rust reviewer failed on all 3 attempts; the last said: try 2 broke',
      });
      expect(reviewer.calls).toHaveLength(3);
    });

    it('treats an executor that throws as a failed attempt rather than a crashed run', async () => {
      const reviewer = agent(async () => {
        throw new Error('the seam exploded');
      });
      const run = drive(
        document({ nodes: [TRIGGER, AGENT], edges: [{ from: 'start', to: 'review' }] }),
        {},
        table(reviewer.execute),
      );

      await expect(run.done).resolves.toEqual({
        status: 'failed',
        reason: 'the AGENT node Rust reviewer failed: Error: the seam exploded',
      });
    });
  });

  describe('cancel', () => {
    it('stops before the next step and ends cancelled, leaving the step in flight to finish', async () => {
      let release: (() => void) | null = null;
      const reviewer = agent(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ ok: true });
          }),
      );
      const doc = document({
        nodes: [TRIGGER, AGENT, DOCS_AGENT],
        edges: [
          { from: 'start', to: 'review' },
          { from: 'review', to: 'docs' },
        ],
      });
      const run = drive(doc, {}, table(reviewer.execute));
      await settle();
      expect(reviewer.calls).toHaveLength(1);

      run.cancel();
      await settle();
      // The step in flight is not interrupted: nothing has ended yet.
      expect(run.steps.at(-1)?.outcome).toBe('running');

      release?.();
      await expect(run.done).resolves.toEqual({ status: 'cancelled' });
      // The reviewer's step kept its outcome; the docs agent was never started.
      expect(run.steps.at(-1)).toMatchObject({ nodeId: 'review', outcome: 'succeeded' });
      expect(reviewer.calls).toHaveLength(1);
    });

    it('ends a cancel during a backoff wait without trying again', async () => {
      const reviewer = agent(async () => ({ ok: false, problem: 'no' }));
      const run = drive(
        document({
          nodes: [TRIGGER, { ...AGENT, retry: { max: 3, backoff: 5 } }],
          edges: [{ from: 'start', to: 'review' }],
        }),
        {},
        table(reviewer.execute),
      );
      await settle();
      expect(run.timers.pending).toBe(1);

      run.cancel();

      await expect(run.done).resolves.toEqual({ status: 'cancelled' });
      expect(run.timers.pending).toBe(0);
      expect(reviewer.calls).toHaveLength(1);
    });

    it('tells the executor, so a step that can stop early does', async () => {
      let sawCancel = false;
      const executors: ExecutorTable = {
        trigger: triggerExecutor,
        router: routerExecutor,
        agent: (_node, _input, context) =>
          new Promise((resolve) => {
            context.cancellation.onCancel(() => {
              sawCancel = true;
              resolve({ ok: false, problem: 'stopped early' });
            });
          }),
      };
      const run = drive(
        document({ nodes: [TRIGGER, AGENT], edges: [{ from: 'start', to: 'review' }] }),
        {},
        executors,
      );
      await settle();

      run.cancel();

      await expect(run.done).resolves.toEqual({ status: 'cancelled' });
      expect(sawCancel).toBe(true);
      expect(run.steps.at(-1)).toEqual({
        nodeId: 'review',
        attempt: 0,
        outcome: 'cancelled',
        output: null,
      });
    });
  });

  describe('the shape of the document', () => {
    it('fails a node whose kind the table has no executor for, naming it', async () => {
      const doc = document({
        nodes: [
          TRIGGER,
          {
            ...BASE,
            id: 'gate',
            kind: 'human',
            label: 'Ana approves',
            approvers: ['ana'],
            timeoutMinutes: null,
          },
        ],
        edges: [{ from: 'start', to: 'gate' }],
      });
      const run = drive(doc, {}, table(agent(async () => ({ ok: true })).execute));

      await expect(run.done).resolves.toEqual({
        status: 'failed',
        reason: 'the HUMAN node Ana approves is a kind this runtime cannot execute yet',
      });
    });

    it('fails a document with no TRIGGER, or two, before any step', async () => {
      const none = drive(
        document({ nodes: [AGENT], edges: [] }),
        {},
        table(agent(async () => ({ ok: true })).execute),
      );
      await expect(none.done).resolves.toEqual({
        status: 'failed',
        reason: 'a run starts at the one TRIGGER node, and this document has 0',
      });
      expect(none.steps).toEqual([]);

      const two = drive(
        document({ nodes: [TRIGGER, { ...TRIGGER, id: 'again' }], edges: [] }),
        {},
        table(agent(async () => ({ ok: true })).execute),
      );
      await expect(two.done).resolves.toMatchObject({
        status: 'failed',
        reason: 'a run starts at the one TRIGGER node, and this document has 2',
      });
    });

    it('fails a node with two plain outgoing edges, because only a ROUTER chooses', async () => {
      const doc = document({
        nodes: [TRIGGER, AGENT, DOCS_AGENT],
        edges: [
          { from: 'start', to: 'review' },
          { from: 'start', to: 'docs' },
        ],
      });
      const run = drive(doc, {}, table(agent(async () => ({ ok: true })).execute));

      await expect(run.done).resolves.toEqual({
        status: 'failed',
        reason:
          'the TRIGGER node PR opened has 2 outgoing edges, and only a ROUTER chooses between them',
      });
    });

    it('stops a run that loops once it has visited more nodes than a graph may hold', async () => {
      const doc = document({
        nodes: [TRIGGER, AGENT],
        edges: [
          { from: 'start', to: 'review' },
          { from: 'review', to: 'review' },
        ],
      });
      const reviewer = agent(async () => ({ ok: true }));
      const run = drive(doc, {}, table(reviewer.execute));

      await expect(run.done).resolves.toMatchObject({ status: 'failed' });
      const outcome = await run.done;
      if (outcome.status !== 'failed') return;
      expect(outcome.reason).toContain('Rust reviewer');
      expect(outcome.reason).toContain('looping');
    });
  });
});
