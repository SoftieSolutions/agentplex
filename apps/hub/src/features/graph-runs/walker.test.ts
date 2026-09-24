import { describe, expect, it } from 'vitest';
import {
  GRAPH_RUN_OUTPUT_MAX_CHARS,
  graphDocumentSchema,
  sessionIdSchema,
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
const GATE = {
  ...BASE,
  id: 'gate',
  kind: 'human',
  label: 'Ana approves',
  approvers: ['ana'],
  timeoutMinutes: null,
};

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
      const session = {
        storeId: node.storeId,
        sessionId: sessionIdSchema.parse(`session-${String(context.attempt)}`),
        status: 'idle',
      } as const;
      return { ok: true, carried: session, output: { kind: 'session', ...session }, next: null };
    },
  };
}

/** A HUMAN executor a test answers by hand, after saying it is waiting. */
function person(): {
  execute: Executor<'human'>;
  grant(): void;
  deny(): void;
  readonly cancelled: boolean;
} {
  let answer: ((result: { ok: true } | { ok: false; problem: string }) => void) | null = null;
  let cancelled = false;
  return {
    get cancelled() {
      return cancelled;
    },
    grant: () => answer?.({ ok: true }),
    deny: () => answer?.({ ok: false, problem: 'a person denied Ana approves' }),
    execute: (node, input, context) =>
      new Promise((resolve) => {
        context.waiting();
        answer = (result) => {
          if (result.ok) resolve({ ok: true, carried: input, output: null, next: null });
          else resolve(result);
        };
        context.cancellation.onCancel(() => {
          cancelled = true;
          resolve({ ok: false, problem: `the run was cancelled while ${node.label} was waiting` });
        });
      }),
  };
}

const NOBODY: Executor<'human'> = () => Promise.reject(new Error('no HUMAN node here'));

function table(execute: Executor<'agent'>, human: Executor<'human'> = NOBODY): ExecutorTable {
  return { trigger: triggerExecutor, router: routerExecutor, agent: execute, human };
}

interface Driven {
  readonly steps: GraphRunStep[];
  readonly reached: number[];
  /** What `onEnd` was called with, and how many steps had been reported by then. */
  readonly ended: { outcome: WalkOutcome; stepsThen: number }[];
  /** Steps, ends and a microtask queued from each step, in the order they happened. */
  readonly order: string[];
  readonly timers: ReturnType<typeof createFakeTimers>;
  readonly done: Promise<WalkOutcome>;
  cancel(): void;
}

function drive(doc: GraphDocument, input: RouteInput, executors: ExecutorTable): Driven {
  const steps: GraphRunStep[] = [];
  const reached: number[] = [];
  const ended: { outcome: WalkOutcome; stepsThen: number }[] = [];
  const order: string[] = [];
  const timers = createFakeTimers();
  const handle = walk(doc, input, {
    executors,
    timers,
    onStep: (step, at) => {
      steps.push(step);
      reached.push(at);
      order.push(`step ${step.nodeId} ${step.outcome}`);
      queueMicrotask(() => order.push('tick'));
    },
    onEnd: (outcome) => {
      ended.push({ outcome, stepsThen: steps.length });
      order.push(`end ${outcome.status}`);
    },
  });
  return {
    steps,
    reached,
    ended,
    order,
    timers,
    done: handle.done,
    cancel: () => handle.cancel(),
  };
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
      {
        nodeId: 'start',
        attempt: 0,
        outcome: 'succeeded',
        output: { kind: 'text', text: '{"language":"rust"}' },
      },
      { nodeId: 'review', attempt: 0, outcome: 'running', output: null },
      {
        nodeId: 'review',
        attempt: 0,
        outcome: 'succeeded',
        output: { kind: 'session', storeId: 'store-work', sessionId: 'session-0', status: 'idle' },
      },
    ]);
    // The step count is the nodes reached: 1 at the trigger, 2 at the agent.
    expect(run.reached).toEqual([1, 1, 2, 2]);
    expect(reviewer.calls).toEqual([{ attempt: 0, prompt: 'Review the Rust in this change.' }]);
  });

  it('says how it ended synchronously, once, after the last step and before done resolves', async () => {
    const doc = document({ nodes: [TRIGGER, AGENT], edges: [{ from: 'start', to: 'review' }] });
    const run = drive(doc, {}, table(agent(async () => ({ ok: true })).execute));

    const outcome = await run.done;

    // The end was reported with every step already in the list -- so whoever
    // publishes the steps can fold the end into the same change -- exactly
    // once, and in the same synchronous stretch as the last step: no
    // microtask ran between the two.
    expect(run.ended).toEqual([{ outcome, stepsThen: 4 }]);
    expect(run.order.slice(-3)).toEqual(['step review succeeded', 'end succeeded', 'tick']);
  });

  it('cuts the TRIGGER’s record of the input at the output bound, and hands the input on whole', async () => {
    const doc = document({ nodes: [TRIGGER, AGENT], edges: [{ from: 'start', to: 'review' }] });
    const seen: RouteInput[] = [];
    const executors: ExecutorTable = {
      trigger: triggerExecutor,
      router: routerExecutor,
      agent: async (_node, input) => {
        seen.push(input);
        return { ok: true, carried: input, output: null, next: null };
      },
      human: NOBODY,
    };
    const input = { body: 'x'.repeat(GRAPH_RUN_OUTPUT_MAX_CHARS + 500) };

    const run = drive(doc, input, executors);
    await run.done;

    expect(seen).toEqual([input]);
    const record = run.steps[1]?.output;
    expect(record?.kind).toBe('text');
    if (record?.kind !== 'text') return;
    expect(record.text).toHaveLength(GRAPH_RUN_OUTPUT_MAX_CHARS);
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
      human: NOBODY,
      agent: async (node, input) => {
        seen.push(input);
        return { ok: true, carried: { ran: node.id }, output: null, next: null };
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
      // The router records which route it took and where that led, and not
      // the input it read: that can be 16 000 characters, and this cannot.
      expect(
        run.steps.find((step) => step.nodeId === 'classify' && step.outcome === 'succeeded'),
      ).toEqual({
        nodeId: 'classify',
        attempt: 0,
        outcome: 'succeeded',
        output: { kind: 'route', route: 0, to: 'review' },
      });
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
      expect(
        run.steps.find((step) => step.nodeId === 'classify' && step.outcome === 'succeeded'),
      ).toMatchObject({ output: { kind: 'route', route: null, to: 'docs' } });
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
          output: {
            kind: 'session',
            storeId: 'store-work',
            sessionId: 'session-2',
            status: 'idle',
          },
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
      // Held on an object, because an assignment inside the promise callback
      // is one the type checker cannot see at the call below.
      const gate: { release: (() => void) | null } = { release: null };
      const reviewer = agent(
        () =>
          new Promise((resolve) => {
            gate.release = () => resolve({ ok: true });
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

      gate.release?.();
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
        human: NOBODY,
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

  describe('a HUMAN node', () => {
    const GATED = document({
      nodes: [TRIGGER, GATE, AGENT],
      edges: [
        { from: 'start', to: 'gate' },
        { from: 'gate', to: 'review' },
      ],
    });

    it('records the step as waiting while a person is asked, then succeeded when they allow', async () => {
      const ana = person();
      const reviewer = agent(async () => ({ ok: true }));
      const run = drive(GATED, { language: 'rust' }, table(reviewer.execute, ana.execute));
      await settle();

      // `running` when the attempt begins, `waiting` the moment the executor
      // says so: the same nodeId and attempt, so the record is replaced.
      expect(run.steps.filter((step) => step.nodeId === 'gate')).toEqual([
        { nodeId: 'gate', attempt: 0, outcome: 'running', output: null },
        { nodeId: 'gate', attempt: 0, outcome: 'waiting', output: null },
      ]);
      expect(reviewer.calls).toEqual([]);

      ana.grant();
      await expect(run.done).resolves.toMatchObject({ status: 'succeeded' });
      expect(run.steps.filter((step) => step.nodeId === 'gate').at(-1)).toEqual({
        nodeId: 'gate',
        attempt: 0,
        outcome: 'succeeded',
        output: null,
      });
      // The run went on to the node after the gate.
      expect(reviewer.calls).toHaveLength(1);
    });

    it('fails the run naming the node when a person denies', async () => {
      const ana = person();
      const run = drive(GATED, {}, table(agent(async () => ({ ok: true })).execute, ana.execute));
      await settle();

      ana.deny();

      await expect(run.done).resolves.toEqual({
        status: 'failed',
        reason: 'the HUMAN node Ana approves failed: a person denied Ana approves',
      });
    });

    it('ends cancelled while waiting, telling the executor so it can take the request back', async () => {
      const ana = person();
      const run = drive(GATED, {}, table(agent(async () => ({ ok: true })).execute, ana.execute));
      await settle();

      run.cancel();

      await expect(run.done).resolves.toEqual({ status: 'cancelled' });
      expect(ana.cancelled).toBe(true);
      expect(run.steps.at(-1)).toEqual({
        nodeId: 'gate',
        attempt: 0,
        outcome: 'cancelled',
        output: null,
      });
    });
  });

  describe('the shape of the document', () => {
    it('fails a node whose kind the table has no executor for, naming it', async () => {
      const doc = document({
        nodes: [TRIGGER, { ...BASE, id: 'ship', kind: 'action', label: 'Ship it', name: 'ship' }],
        edges: [{ from: 'start', to: 'ship' }],
      });
      const run = drive(doc, {}, table(agent(async () => ({ ok: true })).execute));

      await expect(run.done).resolves.toEqual({
        status: 'failed',
        reason: 'the ACTION node Ship it is a kind this runtime cannot execute yet',
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
