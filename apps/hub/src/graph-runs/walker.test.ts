import { describe, expect, it } from 'vitest';
import {
  GRAPH_RUN_OUTPUT_MAX_CHARS,
  graphDocumentSchema,
  graphRunIdSchema,
  nodeIdSchema,
  type ApprovalOutcome,
  sessionIdSchema,
  type GraphDocument,
  type GraphRunStep,
  type RouteInput,
} from '@agentplex/protocol';
import { createFakeTimers } from '@agentplex/node-shared/testing';
import { createLogger } from '@agentplex/node-shared';
import { createFakeApprovals } from '../approvals/fake-approvals.js';
import { createHumanExecutor } from './human-executor.js';
import {
  joinExecutor,
  routerExecutor,
  triggerExecutor,
  walk,
  type Executor,
  type ExecutorTable,
  type WalkOutcome,
  type WalkTable,
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
const NO_CHILD: Executor<'subgraph'> = () => Promise.reject(new Error('no SUB-GRAPH node here'));

function table(
  execute: Executor<'agent'>,
  human: Executor<'human'> = NOBODY,
  subgraph: Executor<'subgraph'> = NO_CHILD,
): ExecutorTable {
  return {
    trigger: triggerExecutor,
    router: routerExecutor,
    agent: execute,
    human,
    subgraph,
    join: joinExecutor,
  };
}

const LINT = {
  ...BASE,
  id: 'lint',
  kind: 'subgraph',
  label: 'Lint suite',
  graph: 'graph-lint',
  version: 3,
};

/**
 * A SUB-GRAPH executor that names a child per attempt and answers what the
 * test says: the child's run id is `child-<attempt>`, numbered from 7.
 */
function subgraph(
  answer: (attempt: number) => { ok: true } | { ok: false; problem: string },
): Executor<'subgraph'> {
  return async (_node, input, context) => {
    context.child({
      runId: graphRunIdSchema.parse(`child-${String(context.attempt)}`),
      number: 7 + context.attempt,
    });
    const answered = answer(context.attempt);
    if (!answered.ok) return answered;
    return { ok: true, carried: { ...input, linted: true }, output: null, next: null };
  };
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

function drive(doc: GraphDocument, input: RouteInput, executors: WalkTable): Driven {
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
      { nodeId: 'start', attempt: 0, outcome: 'running', output: null, child: null },
      {
        nodeId: 'start',
        attempt: 0,
        outcome: 'succeeded',
        output: { kind: 'text', text: '{"language":"rust"}' },
        child: null,
      },
      { nodeId: 'review', attempt: 0, outcome: 'running', output: null, child: null },
      {
        nodeId: 'review',
        attempt: 0,
        outcome: 'succeeded',
        output: { kind: 'session', storeId: 'store-work', sessionId: 'session-0', status: 'idle' },
        child: null,
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
      subgraph: NO_CHILD,
      agent: async (_node, input) => {
        seen.push(input);
        return { ok: true, carried: input, output: null, next: null };
      },
      human: NOBODY,
      join: joinExecutor,
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
      subgraph: NO_CHILD,
      join: joinExecutor,
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
        child: null,
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
        child: null,
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
        { nodeId: 'review', attempt: 0, outcome: 'running', output: null, child: null },
        { nodeId: 'review', attempt: 0, outcome: 'failed', output: null, child: null },
        { nodeId: 'review', attempt: 1, outcome: 'running', output: null, child: null },
        { nodeId: 'review', attempt: 1, outcome: 'failed', output: null, child: null },
        { nodeId: 'review', attempt: 2, outcome: 'running', output: null, child: null },
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
          child: null,
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

    it('fails at once on a failure its executor says is final, without consulting retry', async () => {
      const reviewer = agent(async () => ({ ok: false, problem: 'refused for good' }));
      const final: Executor<'agent'> = async (node, input, context) => {
        const result = await reviewer.execute(node, input, context);
        return result.ok ? result : { ...result, retryable: false };
      };
      const run = drive(retried, {}, table(final));
      await settle();

      // The run's end says so as well, so a SUB-GRAPH step whose child this
      // run is can pass the same answer up rather than retry it.
      await expect(run.done).resolves.toEqual({
        status: 'failed',
        reason: 'the AGENT node Rust reviewer failed: refused for good',
        retryable: false,
      });
      expect(reviewer.calls).toHaveLength(1);
      expect(run.timers.pending).toBe(0);
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
        subgraph: NO_CHILD,
        join: joinExecutor,
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
        child: null,
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
        { nodeId: 'gate', attempt: 0, outcome: 'running', output: null, child: null },
        { nodeId: 'gate', attempt: 0, outcome: 'waiting', output: null, child: null },
      ]);
      expect(reviewer.calls).toEqual([]);

      ana.grant();
      await expect(run.done).resolves.toMatchObject({ status: 'succeeded' });
      expect(run.steps.filter((step) => step.nodeId === 'gate').at(-1)).toEqual({
        nodeId: 'gate',
        attempt: 0,
        outcome: 'succeeded',
        output: null,
        child: null,
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

    it("fails at once on a person's answer, even with retries left, and asks nobody twice", async () => {
      // The real HUMAN executor over a hand-written approvals seam: every
      // request raised is one approval id minted and one push sent, so the
      // count of requests is the count of both.
      const requested: string[] = [];
      const answers: ((outcome: ApprovalOutcome) => void)[] = [];
      let minted = 0;
      const human = createHumanExecutor({
        approvals: {
          requestedByHub: (_subject, request) =>
            new Promise((resolve) => {
              requested.push(request.approvalId);
              answers.push(resolve);
            }),
          withdrawnByHub: () => {},
          withdrawnOneByHub: () => {},
        },
        ids: { newId: () => `approval-${String((minted += 1))}` },
        timers: createFakeTimers(),
        logger: createLogger('error', () => {}),
      }).forRun({
        runId: graphRunIdSchema.parse('run-38'),
        number: 38,
        graph: nodeIdSchema.parse('node-graph-release'),
        graphName: 'release',
      });
      const patient = document({
        nodes: [TRIGGER, { ...GATE, retry: { max: 2, backoff: 30 } }],
        edges: [{ from: 'start', to: 'gate' }],
      });
      const run = drive(patient, {}, table(agent(async () => ({ ok: true })).execute, human));
      await settle();

      answers[0]?.('denied');

      await expect(run.done).resolves.toEqual({
        status: 'failed',
        reason: 'the HUMAN node Ana approves failed: a person denied Ana approves',
        retryable: false,
      });
      expect(requested).toEqual(['approval-1']);
      expect(minted).toBe(1);
      expect(run.timers.pending).toBe(0);
      expect(
        run.steps.filter((step) => step.nodeId === 'gate').map((step) => step.attempt),
      ).toEqual([0, 0, 0]);
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
        child: null,
      });
    });
  });

  describe('SUB-GRAPH', () => {
    it('names the child on the running record and on the outcome, and hands its output on', async () => {
      const doc = document({
        nodes: [TRIGGER, LINT, AGENT],
        edges: [
          { from: 'start', to: 'lint' },
          { from: 'lint', to: 'review' },
        ],
      });
      const reviewer = agent(async () => ({ ok: true }));
      const seen: RouteInput[] = [];
      const run = drive(
        doc,
        { language: 'rust' },
        table(
          async (node, input, context) => {
            seen.push(input);
            return reviewer.execute(node, input, context);
          },
          NOBODY,
          subgraph(() => ({ ok: true })),
        ),
      );

      await expect(run.done).resolves.toMatchObject({ status: 'succeeded' });
      expect(run.steps.filter((step) => step.nodeId === 'lint')).toEqual([
        { nodeId: 'lint', attempt: 0, outcome: 'running', output: null, child: null },
        {
          nodeId: 'lint',
          attempt: 0,
          outcome: 'running',
          output: null,
          child: { runId: 'child-0', number: 7 },
        },
        {
          nodeId: 'lint',
          attempt: 0,
          outcome: 'succeeded',
          output: null,
          child: { runId: 'child-0', number: 7 },
        },
      ]);
      // Every other step names no child.
      expect(
        run.steps.filter((step) => step.nodeId !== 'lint').every((s) => s.child === null),
      ).toBe(true);
      expect(seen).toEqual([{ language: 'rust', linted: true }]);
    });

    it('retries a failed child under the node’s policy, a new child per attempt', async () => {
      const doc = document({
        nodes: [TRIGGER, { ...LINT, retry: { max: 1, backoff: 5 } }],
        edges: [{ from: 'start', to: 'lint' }],
      });
      const run = drive(
        doc,
        {},
        table(
          agent(async () => ({ ok: true })).execute,
          NOBODY,
          subgraph((attempt) =>
            attempt === 0
              ? { ok: false, problem: 'child run #7 of graph-lint failed: the lint said no' }
              : { ok: true },
          ),
        ),
      );

      await settle();
      expect(run.timers.delays).toEqual([5_000]);
      run.timers.fireAll();

      await expect(run.done).resolves.toMatchObject({ status: 'succeeded' });
      expect(
        run.steps
          .filter((step) => step.nodeId === 'lint' && step.child !== null)
          .map((step) => `${String(step.attempt)} ${step.outcome} #${String(step.child?.number)}`),
      ).toEqual(['0 running #7', '0 failed #7', '1 running #8', '1 succeeded #8']);
    });

    it('fails the run naming the node when the child fails on every attempt', async () => {
      const doc = document({ nodes: [TRIGGER, LINT], edges: [{ from: 'start', to: 'lint' }] });
      const run = drive(
        doc,
        {},
        table(
          agent(async () => ({ ok: true })).execute,
          NOBODY,
          subgraph(() => ({ ok: false, problem: 'child run #7 of graph-lint failed' })),
        ),
      );

      await expect(run.done).resolves.toEqual({
        status: 'failed',
        reason: 'the SUB-GRAPH node Lint suite failed: child run #7 of graph-lint failed',
      });
    });
  });

  describe('branches and a JOIN', () => {
    const JOIN = { ...BASE, id: 'both', kind: 'join', label: 'Both reviews' };
    const MERGE = { ...AGENT, id: 'merge', label: 'Merge notes' };
    /** TRIGGER fans out to the two reviewers, who meet at the join, which goes on to one agent. */
    const FANNED = document({
      nodes: [TRIGGER, AGENT, DOCS_AGENT, JOIN, MERGE],
      edges: [
        { from: 'start', to: 'review' },
        { from: 'start', to: 'docs' },
        { from: 'review', to: 'both' },
        { from: 'docs', to: 'both' },
        { from: 'both', to: 'merge' },
      ],
    });

    /**
     * An AGENT executor each call of which a test answers by node id, and
     * which stops early on a cancel the way the real one asks a session to.
     */
    function gated(): {
      execute: Executor<'agent'>;
      readonly started: string[];
      readonly inputs: Map<string, RouteInput>;
      pass(id: string): void;
      fail(id: string, problem: string): void;
    } {
      const started: string[] = [];
      const inputs = new Map<string, RouteInput>();
      const answers = new Map<
        string,
        (answer: { ok: true } | { ok: false; problem: string }) => void
      >();
      return {
        started,
        inputs,
        pass: (id) => answers.get(id)?.({ ok: true }),
        fail: (id, problem) => answers.get(id)?.({ ok: false, problem }),
        execute: (node, input, context) =>
          new Promise((resolve) => {
            started.push(node.id);
            inputs.set(node.id, input);
            answers.set(node.id, (answer) =>
              resolve(
                answer.ok
                  ? { ok: true, carried: { by: node.id }, output: null, next: null }
                  : answer,
              ),
            );
            context.cancellation.onCancel(() =>
              resolve({ ok: false, problem: `${node.label} was stopped` }),
            );
          }),
      };
    }

    /** The nodes whose latest record is open, in the order the records say. */
    function inFlight(steps: readonly GraphRunStep[]): string[] {
      const latest = new Map<string, GraphRunStep>();
      for (const step of steps) latest.set(step.nodeId, step);
      return [...latest.values()]
        .filter((step) => step.outcome === 'running' || step.outcome === 'waiting')
        .map((step) => step.nodeId);
    }

    it('runs every outgoing branch of a node at once, in the order the edges are listed', async () => {
      const agents = gated();
      const run = drive(FANNED, { language: 'rust' }, table(agents.execute));
      await settle();

      // Both reviewers started before either answered: two steps in flight.
      expect(agents.started).toEqual(['review', 'docs']);
      expect(inFlight(run.steps)).toEqual(['review', 'docs']);
      // Each branch was handed what the node before the fan-out carried.
      expect(agents.inputs.get('review')).toEqual({ language: 'rust' });
      expect(agents.inputs.get('docs')).toEqual({ language: 'rust' });
    });

    it('waits at the JOIN for every incoming branch, then goes on once with each output by node', async () => {
      const agents = gated();
      const run = drive(FANNED, {}, table(agents.execute));
      await settle();

      agents.pass('docs');
      await settle();
      // One branch in: the join has not been reached, and nothing after it has.
      expect(run.steps.some((step) => step.nodeId === 'both')).toBe(false);
      expect(agents.started).toEqual(['review', 'docs']);

      agents.pass('review');
      await settle();
      expect(agents.started).toEqual(['review', 'docs', 'merge']);
      // The join hands on what each branch made, under the node it came from,
      // in the order the edges into it are listed.
      expect(agents.inputs.get('merge')).toEqual({
        branches: { review: { by: 'review' }, docs: { by: 'docs' } },
      });
      expect(run.steps.filter((step) => step.nodeId === 'both')).toEqual([
        { nodeId: 'both', attempt: 0, outcome: 'running', output: null, child: null },
        { nodeId: 'both', attempt: 0, outcome: 'succeeded', output: null, child: null },
      ]);

      agents.pass('merge');
      await expect(run.done).resolves.toEqual({ status: 'succeeded', output: { by: 'merge' } });
      // The join counts once: trigger, two reviewers, join, merge.
      expect(run.reached.at(-1)).toBe(5);
      expect(run.ended).toHaveLength(1);
    });

    it('fails the run naming the branch that failed, and cancels the branch still running', async () => {
      const agents = gated();
      const run = drive(FANNED, {}, table(agents.execute));
      await settle();

      agents.fail('review', 'the review found nothing to review');

      // Failed, not cancelled: the sibling was stopped because of the
      // failure, and the failure is what the run ended on.
      await expect(run.done).resolves.toEqual({
        status: 'failed',
        reason: 'the AGENT node Rust reviewer failed: the review found nothing to review',
      });
      expect(run.steps.filter((step) => step.nodeId === 'docs').at(-1)).toEqual({
        nodeId: 'docs',
        attempt: 0,
        outcome: 'cancelled',
        output: null,
        child: null,
      });
      expect(agents.started).toEqual(['review', 'docs']);
      expect(run.ended).toHaveLength(1);
      expect(inFlight(run.steps)).toEqual([]);
    });

    it('does not retry a sibling cancelled by a failure, nor wait out its backoff', async () => {
      const agents = gated();
      const patient = document({
        ...FANNED,
        nodes: FANNED.nodes.map((node) =>
          node.id === 'docs' ? { ...node, retry: { max: 3, backoff: 30 } } : node,
        ),
      });
      const run = drive(patient, {}, table(agents.execute));
      await settle();

      agents.fail('review', 'no');

      await expect(run.done).resolves.toMatchObject({ status: 'failed' });
      expect(run.timers.pending).toBe(0);
      expect(agents.started).toEqual(['review', 'docs']);
    });

    it('ends cancelled on a cancel during a fan-out, telling every branch in flight', async () => {
      const agents = gated();
      const run = drive(FANNED, {}, table(agents.execute));
      await settle();

      run.cancel();

      await expect(run.done).resolves.toEqual({ status: 'cancelled' });
      expect(
        run.steps
          .filter((step) => step.outcome === 'cancelled')
          .map((step) => step.nodeId)
          .sort(),
      ).toEqual(['docs', 'review']);
      expect(agents.started).toEqual(['review', 'docs']);
      expect(run.ended).toEqual([
        { outcome: { status: 'cancelled' }, stepsThen: run.steps.length },
      ]);
    });

    it('says how it ended in the same synchronous stretch as the last branch’s last step', async () => {
      const agents = gated();
      const run = drive(FANNED, {}, table(agents.execute));
      await settle();
      agents.pass('review');
      agents.pass('docs');
      await settle();

      agents.pass('merge');
      await run.done;

      expect(run.order.slice(-3)).toEqual(['step merge succeeded', 'end succeeded', 'tick']);
    });

    it('succeeds a run whose branches end apart with each last output under its node id', async () => {
      const agents = gated();
      const open = document({
        nodes: [TRIGGER, AGENT, DOCS_AGENT],
        edges: [
          { from: 'start', to: 'review' },
          { from: 'start', to: 'docs' },
        ],
      });
      const run = drive(open, {}, table(agents.execute));
      await settle();

      agents.pass('docs');
      await settle();
      expect(run.ended).toEqual([]);
      agents.pass('review');

      await expect(run.done).resolves.toEqual({
        status: 'succeeded',
        output: { branches: { review: { by: 'review' }, docs: { by: 'docs' } } },
      });
    });

    it('fails a JOIN that one of its branches never reached, naming the join and the branch', async () => {
      // The router sends the run down one side only, so the join's other
      // side never arrives: said as a failure rather than a run that sits.
      const routedJoin = document({
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
          JOIN,
          MERGE,
        ],
        edges: [
          { from: 'start', to: 'classify' },
          { from: 'review', to: 'both' },
          { from: 'docs', to: 'both' },
          { from: 'both', to: 'merge' },
        ],
      });
      const reviewer = agent(async () => ({ ok: true }));
      const run = drive(routedJoin, { language: 'rust' }, table(reviewer.execute));

      await expect(run.done).resolves.toEqual({
        status: 'failed',
        reason:
          'the JOIN node Both reviews waits for every incoming branch, and Docs reviewer never reached it',
      });
      expect(reviewer.calls).toHaveLength(1);
    });

    it('fails naming the HUMAN node whose wait ran out, while a HUMAN on another branch waits unbounded', async () => {
      // The real HUMAN executor over the approvals fake. The untimed gate's
      // edge is listed first, so were the timeout to take back every request
      // the run holds, the untimed gate's "withdrawn" would reach the run's
      // end first and name the wrong node.
      const waitingOn: string[][] = [];
      const approvals = createFakeApprovals({
        onGraphRunChanged: (waiting) => waitingOn.push(waiting.map((entry) => entry.nodeLabel)),
      });
      const humanTimers = createFakeTimers();
      let minted = 0;
      const human = createHumanExecutor({
        approvals,
        ids: { newId: () => `approval-${String((minted += 1))}` },
        timers: humanTimers,
        logger: createLogger('error', () => {}),
      }).forRun({
        runId: graphRunIdSchema.parse('run-38'),
        number: 38,
        graph: nodeIdSchema.parse('node-graph-release'),
        graphName: 'release',
      });
      const gates = document({
        nodes: [
          TRIGGER,
          { ...GATE, id: 'untimed', label: 'Untimed' },
          { ...GATE, id: 'timed', label: 'Timed', timeoutMinutes: 2 },
          JOIN,
        ],
        edges: [
          { from: 'start', to: 'untimed' },
          { from: 'start', to: 'timed' },
          { from: 'untimed', to: 'both' },
          { from: 'timed', to: 'both' },
        ],
      });
      const run = drive(gates, {}, table(agent(async () => ({ ok: true })).execute, human));
      await settle();
      expect(waitingOn.at(-1)).toEqual(['Untimed', 'Timed']);

      humanTimers.fireAll();

      await expect(run.done).resolves.toEqual({
        status: 'failed',
        reason:
          'the HUMAN node Timed failed: Timed waited 2 minutes for a person and nobody answered',
        retryable: false,
      });
      // The untimed gate was stopped because the run failed, and its request
      // went with it: nobody is left being asked about a run that has ended.
      expect(run.steps.filter((step) => step.nodeId === 'untimed').at(-1)?.outcome).toBe(
        'cancelled',
      );
      expect(run.steps.filter((step) => step.nodeId === 'timed').at(-1)?.outcome).toBe('failed');
      expect(waitingOn.at(-1)).toEqual([]);
    });

    it('walks the branches one after another, in edge order, when told to take them in turn', async () => {
      const order: string[] = [];
      const executors = table(async (node, input) => {
        order.push(`start ${node.id}`);
        await settle();
        order.push(`end ${node.id}`);
        return { ok: true, carried: input, output: null, next: null };
      });
      const handle = walk(
        FANNED,
        {},
        {
          executors,
          timers: createFakeTimers(),
          branches: 'in-turn',
          onStep: () => {},
          onEnd: () => {},
        },
      );

      await expect(handle.done).resolves.toMatchObject({ status: 'succeeded' });
      expect(order).toEqual([
        'start review',
        'end review',
        'start docs',
        'end docs',
        'start merge',
        'end merge',
      ]);
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

    it('runs an ACTION through the table only when the table has one, as a simulation does', async () => {
      const doc = document({
        nodes: [TRIGGER, { ...BASE, id: 'ship', kind: 'action', label: 'Ship it', name: 'ship' }],
        edges: [{ from: 'start', to: 'ship' }],
      });
      const named: string[] = [];
      const run = drive(
        doc,
        {},
        {
          ...table(agent(async () => ({ ok: true })).execute),
          action: async (node, input) => {
            named.push(node.name);
            return { ok: true, carried: input, output: null, next: null };
          },
        },
      );

      await expect(run.done).resolves.toEqual({ status: 'succeeded', output: {} });
      expect(named).toEqual(['ship']);
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
