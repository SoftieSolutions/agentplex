import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  graphDocumentSchema,
  graphNodeIdSchema,
  graphRunIdSchema,
  nodeIdSchema,
  serverRegistrationIdSchema,
  sessionIdSchema,
  type GraphDocument,
  type GraphRunState,
  type NodeId,
  type SessionStatus,
} from '@agentplex/protocol';
import { createFakeTimers, type FakeTimers } from '@agentplex/node-shared/testing';
import { createLogger } from '@agentplex/node-shared';
import type { Database } from '../db/database.js';
import { openMigratedSchema, type MigratedSchema } from '../db/test-migrated-schema.js';
import { createGraphs, type Graphs } from '../graphs/graphs.js';
import type { AgentExecutor } from './agent-executor.js';
import { createGraphRuns, GRAPH_RUNS_MAX_ACTIVE, type GraphRuns } from './graph-runs.js';
import type { HumanExecutor, HumanRun } from './human-executor.js';
import { childrenOf, readRun } from './run-rows.js';

/**
 * The runtime's entry: a run from the frame's two fields to a row and a
 * stream of states, over the real graphs feature and a real schema.
 *
 * The AGENT executor is a hand-written seam here, because what this file is
 * about is what the feature does around a step -- number it, persist it,
 * publish it, end it, sweep it at boot, cap it, answer a read of it -- and not
 * what a step does. The real executor is `agent-executor.test.ts`'s subject.
 */

const logger = createLogger('error', () => {});
const PROJECT = nodeIdSchema.parse('project');
let now = 1_756_000_000_000;
const clock = { now: () => now };

let migrated: MigratedSchema | null = null;
let minted = 0;
const ids = { newId: () => `id-${String((minted += 1))}` };

function db(): Database {
  if (migrated === null) throw new Error('no database: beforeAll did not run');
  return migrated.database;
}

async function makeProject(): Promise<void> {
  await db().query(
    `INSERT INTO nodes (id, parent_id, kind, position, name, name_source, created_at)
     VALUES (?, NULL, 'project', 0, 'universe', 'user', ?)`,
    [PROJECT, now],
  );
  await db().query('INSERT INTO projects (node_id, directory, created_at) VALUES (?, ?, ?)', [
    PROJECT,
    '/srv/work/universe',
    now,
  ]);
}

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
const GATED: GraphDocument = graphDocumentSchema.parse({
  nodes: [
    TRIGGER,
    {
      ...BASE,
      id: 'gate',
      kind: 'human',
      label: 'Ship it',
      approvers: ['robert'],
      timeoutMinutes: null,
    },
    AGENT,
  ],
  edges: [
    { from: 'start', to: 'gate' },
    { from: 'gate', to: 'review' },
  ],
});
const RUNNABLE: GraphDocument = graphDocumentSchema.parse({
  nodes: [
    TRIGGER,
    {
      ...BASE,
      id: 'classify',
      kind: 'router',
      label: 'Classify diff',
      model: 'haiku',
      routes: [{ condition: 'language == rust', to: 'review' }],
      otherwise: null,
    },
    AGENT,
  ],
  edges: [{ from: 'start', to: 'classify' }],
});

/**
 * TRIGGER -> AGENT -> ROUTER -> back to the AGENT while it stops idle, else
 * on to a second AGENT: a cycle, so one node is reached twice in one run.
 */
const CYCLIC: GraphDocument = graphDocumentSchema.parse({
  nodes: [
    TRIGGER,
    AGENT,
    {
      ...BASE,
      id: 'again',
      kind: 'router',
      label: 'Done yet',
      model: 'haiku',
      routes: [{ condition: 'status == idle', to: 'review' }],
      otherwise: 'docs',
    },
    { ...AGENT, id: 'docs', label: 'Docs reviewer' },
  ],
  edges: [
    { from: 'start', to: 'review' },
    { from: 'review', to: 'again' },
  ],
});

/** An AGENT executor whose answer the suite chooses, and that records the project it was built for. */
interface ScriptedAgent extends AgentExecutor {
  readonly projects: (NodeId | null)[];
  /** The AGENT nodes a simulation asked where they would be placed. */
  readonly placed: string[];
  readonly noted: number;
  /** How many steps have been asked of it, over every run. */
  readonly calls: number;
  answerWith(answer: 'succeed' | 'fail' | 'hang'): void;
  /** The statuses successive successful steps stop on; `idle` once the list is spent. */
  stopOn(statuses: readonly SessionStatus[]): void;
}

function scriptedAgent(): ScriptedAgent {
  const projects: (NodeId | null)[] = [];
  const placed: string[] = [];
  let answer: 'succeed' | 'fail' | 'hang' = 'succeed';
  let statuses: SessionStatus[] = [];
  let noted = 0;
  let calls = 0;
  return {
    projects,
    placed,
    get noted() {
      return noted;
    },
    get calls() {
      return calls;
    },
    answerWith(next) {
      answer = next;
    },
    stopOn(next) {
      statuses = [...next];
    },
    place(node) {
      placed.push(node.id);
      return {
        ok: true,
        server: serverRegistrationIdSchema.parse('registration-attic'),
        label: 'attic',
      };
    },
    forProject(project) {
      projects.push(project);
      return (node, _input, context) => {
        calls += 1;
        if (answer === 'succeed') {
          const session = {
            storeId: node.storeId,
            sessionId: sessionIdSchema.parse('session-9'),
            status: statuses.shift() ?? 'idle',
          } as const;
          return Promise.resolve({
            ok: true,
            carried: session,
            output: { kind: 'session', ...session },
            next: null,
          });
        }
        if (answer === 'fail') return Promise.resolve({ ok: false, problem: 'the box said no' });
        return new Promise((resolve) => {
          context.cancellation.onCancel(() => resolve({ ok: false, problem: 'stopped' }));
        });
      };
    },
    noteStarts() {
      noted += 1;
    },
  };
}

/** A HUMAN executor the suite answers by hand, recording what it was built for. */
interface ScriptedHuman extends HumanExecutor {
  readonly runs: HumanRun[];
  grant(): void;
  deny(): void;
}

function scriptedHuman(): ScriptedHuman {
  const runs: HumanRun[] = [];
  let answer: ((granted: boolean) => void) | null = null;
  return {
    runs,
    grant: () => answer?.(true),
    deny: () => answer?.(false),
    forRun(run) {
      runs.push(run);
      return (node, input, context) =>
        new Promise((resolve) => {
          context.waiting();
          answer = (granted) =>
            resolve(
              granted
                ? { ok: true, carried: input, output: null, next: null }
                : { ok: false, problem: `a person denied ${node.label}` },
            );
        });
    },
  };
}

interface Harness {
  readonly graphs: Graphs;
  readonly runs: GraphRuns;
  readonly agent: ScriptedAgent;
  readonly human: ScriptedHuman;
  readonly timers: FakeTimers;
  /** Every state published through `onState`, in order. */
  readonly published: GraphRunState[];
}

function build(): Harness {
  const graphs = createGraphs({ database: db(), ids, clock, logger, onTreeChanged: () => {} });
  const agent = scriptedAgent();
  const human = scriptedHuman();
  const timers = createFakeTimers();
  const published: GraphRunState[] = [];
  const runs = createGraphRuns({
    database: db(),
    ids,
    clock,
    timers,
    logger,
    graphs,
    agent,
    human,
    onState: (state) => published.push(state),
  });
  return { graphs, runs, agent, human, timers, published };
}

async function publishedGraph(
  h: Harness,
  document: GraphDocument = RUNNABLE,
  name = 'release-pipeline',
): Promise<NodeId> {
  const made = await h.graphs.create(PROJECT, name);
  if (!made.ok) throw new Error(made.problem);
  await h.graphs.save(made.nodeId, document);
  const published = await h.graphs.publish(made.nodeId);
  if (!published.ok) throw new Error(published.problem);
  return made.nodeId;
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** The strip's reading of each published state, in order. */
function readings(h: Harness): string[] {
  return h.published.map((state) => `${state.status}:${String(state.step)}/${String(state.of)}`);
}

describe('graph runs', () => {
  beforeAll(async () => {
    migrated = await openMigratedSchema('graph-runs');
  });

  afterAll(async () => {
    await migrated?.close();
  });

  beforeEach(async () => {
    await db().query('DELETE FROM nodes');
    now = 1_756_000_000_000;
    minted = 0;
    await makeProject();
  });

  describe('simulate', () => {
    it('walks the draft, never published, and starts, numbers and writes nothing', async () => {
      const h = build();
      const made = await h.graphs.create(PROJECT, 'draft-only');
      if (!made.ok) throw new Error(made.problem);
      await h.graphs.save(made.nodeId, RUNNABLE);

      const simulated = await h.runs.simulate(made.nodeId, { language: 'rust' });

      expect(simulated).toEqual({
        ok: true,
        path: [
          expect.objectContaining({ nodeId: 'start', outcome: 'would-run' }),
          expect.objectContaining({
            nodeId: 'classify',
            outcome: 'would-run',
            why: 'route 1, language == rust, would send it to Rust reviewer: language is "rust"',
          }),
          {
            nodeId: 'review',
            kind: 'agent',
            depth: 0,
            outcome: 'would-run',
            why: 'would run claude on attic',
          },
        ],
        reason: null,
      });
      // Placement was asked; no executor was built, so nothing could start.
      expect(h.agent.placed).toEqual(['review']);
      expect(h.agent.projects).toEqual([]);
      expect(h.agent.calls).toBe(0);
      expect(h.human.runs).toEqual([]);
      expect(h.published).toEqual([]);
      expect(h.timers.pending).toBe(0);
      expect((await db().query('SELECT id FROM graph_runs')).rows).toEqual([]);
      expect(await h.runs.latest(made.nodeId)).toBeNull();
    });

    it('reads the draft, not the newest published version', async () => {
      const h = build();
      const nodeId = await publishedGraph(h, RUNNABLE);
      await h.graphs.save(nodeId, GATED);

      const simulated = await h.runs.simulate(nodeId, {});
      if (!simulated.ok) throw new Error(simulated.problem);
      expect(simulated.path.map((step) => step.nodeId)).toEqual(['start', 'gate', 'review']);
      expect(simulated.path[1]).toEqual({
        nodeId: 'gate',
        kind: 'human',
        depth: 0,
        outcome: 'would-wait',
        why: 'would wait on a person for as long as it takes, for robert',
      });
      expect(h.human.runs).toEqual([]);
    });

    it('refuses a node that is no graph', async () => {
      const h = build();
      expect(await h.runs.simulate(PROJECT, {})).toEqual({
        ok: false,
        code: 'refused',
        problem: 'this hub has no graph by that id',
      });
    });
  });

  it('refuses a node that is no graph, and a graph nothing has been published of', async () => {
    const h = build();
    const made = await h.graphs.create(PROJECT, 'draft-only');
    if (!made.ok) throw new Error(made.problem);

    expect(await h.runs.start(PROJECT, {})).toEqual({
      ok: false,
      code: 'refused',
      problem: 'this hub has no graph by that id',
    });
    expect(await h.runs.start(made.nodeId, {})).toEqual({
      ok: false,
      code: 'refused',
      problem: 'this graph has no published version to run; publish it first',
    });
    expect(h.published).toEqual([]);
  });

  it('runs the newest published version to the end, publishing one state per change and persisting the row', async () => {
    const h = build();
    const graph = await publishedGraph(h);

    const started = await h.runs.start(graph, { language: 'rust' });
    // The graph node took id-1; the run is the next thing this hub named.
    expect(started).toEqual({ ok: true, runId: 'id-2', number: 1 });
    if (!started.ok) return;
    await settle();

    // One frame per change, not per record: a step's outcome and the next
    // step's start are one change, and so are the last outcome and the end.
    expect(readings(h)).toEqual(['running:1/3', 'running:2/3', 'running:3/3', 'succeeded:3/3']);
    for (const state of h.published) expect(state.nodeId).toBe(graph);
    const last = h.published.at(-1);
    expect(last?.steps).toEqual([
      {
        nodeId: 'start',
        attempt: 0,
        outcome: 'succeeded',
        output: { kind: 'text', text: '{"language":"rust"}' },
        child: null,
      },
      {
        nodeId: 'classify',
        attempt: 0,
        outcome: 'succeeded',
        output: { kind: 'route', route: 0, to: 'review' },
        child: null,
      },
      {
        nodeId: 'review',
        attempt: 0,
        outcome: 'succeeded',
        output: { kind: 'session', storeId: 'store-work', sessionId: 'session-9', status: 'idle' },
        child: null,
      },
    ]);
    expect(last?.reason).toBeNull();
    // Each state replaces the running record with the outcome, so no step is
    // both running and done.
    for (const state of h.published) {
      const keys = state.steps.map((step) => `${step.nodeId}#${String(step.attempt)}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
    // The agent was built for the graph's project, so its session starts there.
    expect(h.agent.projects).toEqual([PROJECT]);

    expect(await readRun(db(), started.runId)).toMatchObject({
      number: 1,
      version: 1,
      status: 'succeeded',
      input: { language: 'rust' },
      steps: last?.steps,
      endedAt: now,
    });
  });

  it('numbers a second run 2, and the strip reads its number', async () => {
    const h = build();
    const graph = await publishedGraph(h);
    await h.runs.start(graph, { language: 'rust' });
    await settle();

    const second = await h.runs.start(graph, { language: 'rust' });

    expect(second).toMatchObject({ ok: true, number: 2 });
    await settle();
    expect(h.published.at(-1)?.number).toBe(2);
  });

  it('keeps every visit of a node a cycle reaches twice, in the order the walk made them', async () => {
    const h = build();
    const graph = await publishedGraph(h, CYCLIC);
    h.agent.stopOn(['idle', 'awaiting-input']);

    await h.runs.start(graph, {});
    await settle();

    const last = h.published.at(-1);
    expect(last).toMatchObject({ status: 'succeeded', step: 6, of: 4 });
    expect(last?.steps.map((step) => `${step.nodeId}:${step.outcome}`)).toEqual([
      'start:succeeded',
      'review:succeeded',
      'again:succeeded',
      'review:succeeded',
      'again:succeeded',
      'docs:succeeded',
    ]);
    // Both visits of the reviewer are there, each with what it stopped on.
    expect(
      last?.steps
        .filter((step) => step.nodeId === 'review')
        .map((step) => (step.output?.kind === 'session' ? step.output.status : null)),
    ).toEqual(['idle', 'awaiting-input']);
    expect(last?.steps.map((step) => step.output)).toContainEqual({
      kind: 'route',
      route: null,
      to: 'docs',
    });
  });

  it('ends failed with the walker’s sentence when a step fails, and keeps it on the row', async () => {
    const h = build();
    const graph = await publishedGraph(h);
    h.agent.answerWith('fail');

    const started = await h.runs.start(graph, { language: 'rust' });
    if (!started.ok) throw new Error(started.problem);
    await settle();

    const last = h.published.at(-1);
    expect(last).toMatchObject({
      status: 'failed',
      reason: 'the AGENT node Rust reviewer failed: the box said no',
      step: 3,
    });
    expect(last?.steps.at(-1)).toEqual({
      nodeId: 'review',
      attempt: 0,
      outcome: 'failed',
      output: null,
      child: null,
    });
    expect(await readRun(db(), started.runId)).toMatchObject({
      status: 'failed',
      reason: 'the AGENT node Rust reviewer failed: the box said no',
    });
  });

  it('fails a run that routes nowhere, naming the router', async () => {
    const h = build();
    const graph = await publishedGraph(h);

    await h.runs.start(graph, { language: 'go' });
    await settle();

    expect(h.published.at(-1)).toMatchObject({
      status: 'failed',
      reason:
        'the ROUTER node Classify diff failed: no route on Classify diff matched and it has no otherwise',
    });
  });

  it('cancels a run in flight: the step ends, the run is cancelled, the row says so', async () => {
    const h = build();
    const graph = await publishedGraph(h);
    h.agent.answerWith('hang');
    const started = await h.runs.start(graph, { language: 'rust' });
    if (!started.ok) throw new Error(started.problem);
    await settle();
    expect(h.published.at(-1)).toMatchObject({ status: 'running', step: 3 });

    expect(await h.runs.cancel(started.runId)).toEqual({ ok: true });
    await settle();

    expect(h.published.at(-1)).toMatchObject({ status: 'cancelled', reason: null });
    expect(h.published.at(-1)?.steps.at(-1)).toEqual({
      nodeId: 'review',
      attempt: 0,
      outcome: 'cancelled',
      output: null,
      child: null,
    });
    expect(await readRun(db(), started.runId)).toMatchObject({ status: 'cancelled', endedAt: now });
  });

  it('refuses a cancel of a run that is not in flight', async () => {
    const h = build();
    const graph = await publishedGraph(h);
    const started = await h.runs.start(graph, { language: 'rust' });
    if (!started.ok) throw new Error(started.problem);
    await settle();

    expect(await h.runs.cancel(started.runId)).toEqual({
      ok: false,
      code: 'refused',
      problem: 'no run by that id is in flight',
    });
    expect(await h.runs.cancel(graphRunIdSchema.parse('nowhere'))).toMatchObject({ ok: false });
  });

  it('refuses a cancel that arrives after the end was published and before it was written, as already ended', async () => {
    const h = build();
    const graph = await publishedGraph(h);
    const started = await h.runs.start(graph, { language: 'rust' });
    if (!started.ok) throw new Error(started.problem);
    // Wait for the end to be published, one microtask at a time, and not for
    // the row: the gap between the two is what a cancel could otherwise be
    // acknowledged into.
    for (let turn = 0; turn < 200 && h.published.at(-1)?.status !== 'succeeded'; turn += 1) {
      await Promise.resolve();
    }
    expect(h.published.at(-1)?.status).toBe('succeeded');

    expect(await h.runs.cancel(started.runId)).toEqual({
      ok: false,
      code: 'refused',
      problem: 'run #1 has already ended',
    });
    await settle();
    expect(await readRun(db(), started.runId)).toMatchObject({ status: 'succeeded' });
  });

  describe('the caps', () => {
    it('refuses a second run of a graph while one is in flight, naming the run', async () => {
      const h = build();
      const graph = await publishedGraph(h);
      h.agent.answerWith('hang');
      const first = await h.runs.start(graph, { language: 'rust' });
      if (!first.ok) throw new Error(first.problem);
      await settle();

      expect(await h.runs.start(graph, { language: 'rust' })).toEqual({
        ok: false,
        code: 'refused',
        problem: 'run #1 of this graph is still in flight; cancel it or wait for it to end',
      });
      // Nothing was numbered for the refused start.
      expect(h.published.every((state) => state.number === 1)).toBe(true);

      await h.runs.cancel(first.runId);
      await settle();
      expect(await h.runs.start(graph, { language: 'rust' })).toMatchObject({
        ok: true,
        number: 2,
      });
    });

    it('lets two starts of one graph in the same instant through once, not twice', async () => {
      const h = build();
      const graph = await publishedGraph(h);
      h.agent.answerWith('hang');

      const [a, b] = await Promise.all([
        h.runs.start(graph, { language: 'rust' }),
        h.runs.start(graph, { language: 'rust' }),
      ]);

      expect([a.ok, b.ok].sort()).toEqual([false, true]);
    });

    it(`refuses a run past ${String(GRAPH_RUNS_MAX_ACTIVE)} in flight across the hub, in words`, async () => {
      const h = build();
      h.agent.answerWith('hang');
      const graphs: NodeId[] = [];
      for (let index = 0; index <= GRAPH_RUNS_MAX_ACTIVE; index += 1) {
        graphs.push(await publishedGraph(h, RUNNABLE, `pipeline-${String(index)}`));
      }
      for (const graph of graphs.slice(0, GRAPH_RUNS_MAX_ACTIVE)) {
        expect(await h.runs.start(graph, { language: 'rust' })).toMatchObject({ ok: true });
      }

      const over = graphs[GRAPH_RUNS_MAX_ACTIVE];
      if (over === undefined) throw new Error('no graph over the cap');
      expect(await h.runs.start(over, { language: 'rust' })).toEqual({
        ok: false,
        code: 'refused',
        problem: `this hub is running ${String(GRAPH_RUNS_MAX_ACTIVE)} graphs at once, the most it runs; wait for one to end`,
      });
      expect(await h.runs.latest(over)).toBeNull();

      const first = h.published[0];
      if (first === undefined) throw new Error('nothing was published');
      await h.runs.cancel(first.runId);
      await settle();
      expect(await h.runs.start(over, { language: 'rust' })).toMatchObject({ ok: true });
    });
  });

  describe('latest', () => {
    it('answers the run in flight, then the row once it has ended', async () => {
      const h = build();
      const graph = await publishedGraph(h);
      h.agent.answerWith('hang');
      const started = await h.runs.start(graph, { language: 'rust' });
      if (!started.ok) throw new Error(started.problem);
      await settle();

      expect(await h.runs.latest(graph)).toEqual(h.published.at(-1));

      await h.runs.cancel(started.runId);
      await settle();
      const ended = await h.runs.latest(graph);
      expect(ended).toEqual(h.published.at(-1));
      expect(ended).toMatchObject({
        nodeId: graph,
        runId: started.runId,
        number: 1,
        status: 'cancelled',
        step: 3,
        of: 3,
      });
    });

    it('answers the newest run of the graph, not an older one', async () => {
      const h = build();
      const graph = await publishedGraph(h);
      await h.runs.start(graph, { language: 'rust' });
      await settle();
      await h.runs.start(graph, { language: 'go' });
      await settle();

      expect(await h.runs.latest(graph)).toMatchObject({ number: 2, status: 'failed' });
    });

    it('answers null for a graph never run, and for a node that is no graph', async () => {
      const h = build();
      const graph = await publishedGraph(h);

      expect(await h.runs.latest(graph)).toBeNull();
      expect(await h.runs.latest(PROJECT)).toBeNull();
    });

    it('answers the end, from memory, while the end is still being written', async () => {
      const h = build();
      const graph = await publishedGraph(h);
      await h.runs.start(graph, { language: 'rust' });
      for (let turn = 0; turn < 200 && h.published.at(-1)?.status !== 'succeeded'; turn += 1) {
        await Promise.resolve();
      }

      const latest = h.runs.latest(graph);

      await expect(latest).resolves.toMatchObject({ status: 'succeeded' });
    });
  });

  it('ends a run left running at boot as failed, naming the restart', async () => {
    const h = build();
    const graph = await publishedGraph(h);
    h.agent.answerWith('hang');
    const started = await h.runs.start(graph, { language: 'rust' });
    if (!started.ok) throw new Error(started.problem);
    await settle();

    // A new process over the same rows.
    now += 60_000;
    const rebooted = build();
    await rebooted.runs.load();

    expect(await readRun(db(), started.runId)).toMatchObject({
      status: 'failed',
      reason:
        'the hub restarted while this run was in flight; a waiting run does not survive a restart',
      endedAt: now,
    });
  });

  describe('stop', () => {
    it('cancels the walks in flight, and neither publishes nor writes anything after', async () => {
      const h = build();
      const graph = await publishedGraph(h);
      h.agent.answerWith('hang');
      const started = await h.runs.start(graph, { language: 'rust' });
      if (!started.ok) throw new Error(started.problem);
      await settle();
      const publishedBefore = h.published.length;

      h.runs.stop();
      await settle();

      // The step was told and ended, but nothing left this feature for it:
      // the database is being closed behind this call, and a client is gone.
      expect(h.published).toHaveLength(publishedBefore);
      // The row is left running for the next boot's sweep to end, naming the
      // restart, which is the truth of what happened to it.
      expect(await readRun(db(), started.runId)).toMatchObject({ status: 'running' });
    });

    it('refuses a start once stopped', async () => {
      const h = build();
      const graph = await publishedGraph(h);
      h.runs.stop();

      expect(await h.runs.start(graph, {})).toMatchObject({
        ok: false,
        problem: 'the hub is stopping',
      });
    });

    it('refuses a start that was already reading when the stop came, and walks nothing', async () => {
      const h = build();
      const graph = await publishedGraph(h);
      h.agent.answerWith('hang');

      // Past the first check and awaiting the graph's rows when the stop
      // lands: stop() has already snapshotted what is in flight, so a run
      // that joined afterwards would be walked by nobody's stop.
      const starting = h.runs.start(graph, { language: 'rust' });
      h.runs.stop();

      await expect(starting).resolves.toMatchObject({
        ok: false,
        problem: 'the hub is stopping',
      });
      await settle();
      expect(h.published).toEqual([]);
      expect(await h.runs.latest(graph)).toBeNull();
    });
  });

  it('publishes waiting while a HUMAN node waits, and running again once a person allows', async () => {
    const h = build();
    const nodeId = await publishedGraph(h, GATED);
    const started = await h.runs.start(nodeId, { language: 'rust' });
    if (!started.ok) throw new Error(started.problem);
    await settle();

    // The executor was built for this run, with the graph's name for the words.
    expect(h.human.runs).toEqual([
      { runId: started.runId, number: 1, graph: nodeId, graphName: 'release-pipeline' },
    ]);
    expect(h.published.at(-1)).toMatchObject({
      status: 'waiting',
      step: 2,
      steps: [
        { nodeId: 'start', outcome: 'succeeded' },
        { nodeId: 'gate', attempt: 0, outcome: 'waiting', output: null, child: null },
      ],
    });

    h.human.grant();
    await settle();

    expect(h.published.map((state) => state.status)).toEqual(
      expect.arrayContaining(['waiting', 'running', 'succeeded']),
    );
    expect(h.published.at(-1)).toMatchObject({ status: 'succeeded' });
    expect((await readRun(db(), started.runId))?.status).toBe('succeeded');
  });

  it('answers a read of a run parked at a HUMAN node with waiting, not running', async () => {
    const h = build();
    const nodeId = await publishedGraph(h, GATED);
    const started = await h.runs.start(nodeId, {});
    if (!started.ok) throw new Error(started.problem);
    await settle();

    // A screen that reconnects mid-wait reads the run rather than being sent
    // it, and must be told the same word a watcher was.
    expect(await h.runs.latest(nodeId)).toMatchObject({
      runId: started.runId,
      status: 'waiting',
      steps: [
        { nodeId: 'start', outcome: 'succeeded' },
        { nodeId: 'gate', attempt: 0, outcome: 'waiting', output: null, child: null },
      ],
    });
  });

  it('ends a run failed naming the node when a person denies', async () => {
    const h = build();
    const nodeId = await publishedGraph(h, GATED);
    const started = await h.runs.start(nodeId, {});
    if (!started.ok) throw new Error(started.problem);
    await settle();

    h.human.deny();
    await settle();

    expect(h.published.at(-1)).toMatchObject({
      status: 'failed',
      reason: 'the HUMAN node Ship it failed: a person denied Ship it',
    });
  });

  describe('SUB-GRAPH', () => {
    const AGENT_ONLY: GraphDocument = graphDocumentSchema.parse({
      nodes: [TRIGGER, AGENT],
      edges: [{ from: 'start', to: 'review' }],
    });
    const TRIGGER_ONLY: GraphDocument = graphDocumentSchema.parse({
      nodes: [TRIGGER],
      edges: [],
    });

    function pinning(
      graph: NodeId,
      version: number,
      retry = { max: 0, backoff: 1 },
    ): GraphDocument {
      return graphDocumentSchema.parse({
        nodes: [
          TRIGGER,
          { ...BASE, retry, id: 'lint', kind: 'subgraph', label: 'Lint suite', graph, version },
        ],
        edges: [{ from: 'start', to: 'lint' }],
      });
    }

    /** A child graph published twice: v1 runs an AGENT, v2 is the TRIGGER alone. */
    async function childGraph(h: Harness): Promise<NodeId> {
      const child = await publishedGraph(h, AGENT_ONLY, 'lint-suite');
      await h.graphs.save(child, TRIGGER_ONLY);
      const second = await h.graphs.publish(child);
      if (!second.ok) throw new Error(second.problem);
      return child;
    }

    it('runs the child at the pinned version, numbered in its own graph, named on the parent step', async () => {
      const h = build();
      const child = await childGraph(h);
      const parent = await publishedGraph(h, pinning(child, 1), 'release-pipeline');

      const started = await h.runs.start(parent, { language: 'rust' });
      if (!started.ok) throw new Error(started.problem);
      await settle();

      const parentEnd = h.published.filter((state) => state.nodeId === parent).at(-1);
      expect(parentEnd).toMatchObject({ status: 'succeeded', number: 1 });
      const lintSteps = parentEnd?.steps.filter((step) => step.nodeId === 'lint') ?? [];
      const named = lintSteps.at(-1)?.child;
      expect(named).toMatchObject({ number: 1 });
      if (named === null || named === undefined) throw new Error('the step named no child');

      // The child is a run of the child graph: its states go to that graph's
      // watchers, and it ran v1 -- the AGENT -- not the newer v2.
      const childEnd = h.published.filter((state) => state.nodeId === child).at(-1);
      expect(childEnd).toMatchObject({
        runId: named.runId,
        number: 1,
        status: 'succeeded',
        of: 2,
      });
      expect(childEnd?.steps.map((step) => step.nodeId)).toEqual(['start', 'review']);
      expect(await readRun(db(), named.runId)).toMatchObject({
        graphNodeId: child,
        version: 1,
        number: 1,
        status: 'succeeded',
        parentRunId: started.runId,
        parentNodeId: 'lint',
      });
      expect((await childrenOf(db(), started.runId, graphNodeIdSchema.parse('lint'))).length).toBe(
        1,
      );
      // One AGENT executor per run, the parent's and the child's, each built
      // for its own graph's project -- here both are under the one project.
      expect(h.agent.projects).toEqual([PROJECT, PROJECT]);
      // And the child is in its own graph's history, where its number is.
      expect(await h.runs.history(child)).toMatchObject([{ runId: named.runId, number: 1 }]);
      expect((await h.runs.history(parent)).map((run) => run.runId)).toEqual([started.runId]);
    });

    it('fails a chain that reaches its own graph, naming the node', async () => {
      const h = build();
      const graph = await publishedGraph(h, TRIGGER_ONLY, 'release-pipeline');
      // v2 of the graph pins v1 of itself: publish allows it, the run refuses it.
      await h.graphs.save(graph, pinning(graph, 1));
      const second = await h.graphs.publish(graph);
      if (!second.ok) throw new Error(second.problem);

      const started = await h.runs.start(graph, {});
      if (!started.ok) throw new Error(started.problem);
      await settle();

      expect(h.published.at(-1)).toMatchObject({
        runId: started.runId,
        status: 'failed',
        reason:
          'the SUB-GRAPH node Lint suite failed: it would run release-pipeline, which is already running above it in this chain: release-pipeline → release-pipeline',
      });
      // No child was numbered for it.
      expect(await h.runs.history(graph)).toHaveLength(1);
    });

    it('cascades a cancel of the parent to the child, and both end cancelled', async () => {
      const h = build();
      const child = await childGraph(h);
      const parent = await publishedGraph(h, pinning(child, 1));
      h.agent.answerWith('hang');
      const started = await h.runs.start(parent, {});
      if (!started.ok) throw new Error(started.problem);
      await settle();
      const running = await h.runs.latest(child);
      expect(running).toMatchObject({ status: 'running' });

      expect(await h.runs.cancel(started.runId)).toEqual({ ok: true });
      await settle();

      expect(h.published.filter((state) => state.nodeId === child).at(-1)).toMatchObject({
        status: 'cancelled',
      });
      expect(h.published.filter((state) => state.nodeId === parent).at(-1)).toMatchObject({
        status: 'cancelled',
      });
      expect(await readRun(db(), running?.runId ?? started.runId)).toMatchObject({
        status: 'cancelled',
      });
    });

    it('counts a child toward the one-run-per-graph cap, and retries under the node’s policy', async () => {
      const h = build();
      const child = await publishedGraph(h, AGENT_ONLY, 'lint-suite');
      const parent = await publishedGraph(h, pinning(child, 1, { max: 1, backoff: 5 }));
      h.agent.answerWith('hang');
      const own = await h.runs.start(child, {});
      if (!own.ok) throw new Error(own.problem);
      await settle();

      const started = await h.runs.start(parent, {});
      if (!started.ok) throw new Error(started.problem);
      await settle();
      // The child graph's own run is in flight, so the first try is refused.
      expect(h.timers.delays).toEqual([5_000]);

      await h.runs.cancel(own.runId);
      await settle();
      h.agent.answerWith('succeed');
      h.timers.fireAll();
      await settle();

      const parentEnd = h.published.filter((state) => state.nodeId === parent).at(-1);
      expect(parentEnd).toMatchObject({ status: 'succeeded' });
      expect(
        parentEnd?.steps
          .filter((step) => step.nodeId === 'lint')
          .map((step) => `${String(step.attempt)} ${step.outcome} ${String(step.child?.number)}`),
      ).toEqual(['0 failed undefined', '1 succeeded 2']);
    });
  });

  describe('history and open', () => {
    it('lists a graph’s runs newest first, an in-flight one with its live status', async () => {
      const h = build();
      const graph = await publishedGraph(h, GATED);
      const first = await h.runs.start(graph, {});
      if (!first.ok) throw new Error(first.problem);
      await settle();
      h.human.deny();
      await settle();
      now += 1_000;
      const second = await h.runs.start(graph, {});
      if (!second.ok) throw new Error(second.problem);
      await settle();

      expect(await h.runs.history(graph)).toEqual([
        {
          runId: second.runId,
          number: 2,
          // The row says running; the run is parked at a person.
          status: 'waiting',
          startedAt: now,
          endedAt: null,
          reason: null,
        },
        {
          runId: first.runId,
          number: 1,
          status: 'failed',
          startedAt: now - 1_000,
          endedAt: now - 1_000,
          reason: 'the HUMAN node Ship it failed: a person denied Ship it',
        },
      ]);
    });

    it('is an empty list for a graph never run, and for a node that is no graph', async () => {
      const h = build();
      const graph = await publishedGraph(h);

      expect(await h.runs.history(graph)).toEqual([]);
      expect(await h.runs.history(PROJECT)).toEqual([]);
    });

    it('opens one run of the graph whole, in flight or ended, and nothing of another graph', async () => {
      const h = build();
      const graph = await publishedGraph(h);
      const other = await publishedGraph(h, RUNNABLE, 'other');
      const first = await h.runs.start(graph, { language: 'rust' });
      if (!first.ok) throw new Error(first.problem);
      await settle();
      const firstEnd = h.published.at(-1);
      h.agent.answerWith('hang');
      const second = await h.runs.start(graph, { language: 'rust' });
      if (!second.ok) throw new Error(second.problem);
      await settle();

      expect(await h.runs.open(graph, first.runId)).toEqual(firstEnd);
      expect(await h.runs.open(graph, second.runId)).toMatchObject({
        runId: second.runId,
        status: 'running',
      });
      expect(await h.runs.open(other, first.runId)).toBeNull();
      expect(await h.runs.open(graph, graphRunIdSchema.parse('nowhere'))).toBeNull();
    });
  });

  it('hands start tags on to the agent executor', () => {
    const h = build();
    h.runs.noteStarts(nodeIdSchema.parse('store-work') as never, []);
    expect(h.agent.noted).toBe(1);
  });
});
