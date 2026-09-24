import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  graphDocumentSchema,
  graphRunIdSchema,
  nodeIdSchema,
  sessionIdSchema,
  type GraphDocument,
  type GraphRunState,
  type NodeId,
  type SessionStatus,
} from '@agentplex/protocol';
import { createFakeTimers, type FakeTimers } from '@agentplex/node-shared/testing';
import { createLogger } from '@agentplex/node-shared';
import type { Database } from '../../db/database.js';
import { openMigratedSchema, type MigratedSchema } from '../../db/test-migrated-schema.js';
import { createGraphs, type Graphs } from '../graphs/graphs.js';
import type { AgentExecutor } from './agent-executor.js';
import { createGraphRuns, GRAPH_RUNS_MAX_ACTIVE, type GraphRuns } from './graph-runs.js';
import { readRun } from './run-rows.js';

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
  readonly noted: number;
  /** How many steps have been asked of it, over every run. */
  readonly calls: number;
  answerWith(answer: 'succeed' | 'fail' | 'hang'): void;
  /** The statuses successive successful steps stop on; `idle` once the list is spent. */
  stopOn(statuses: readonly SessionStatus[]): void;
}

function scriptedAgent(): ScriptedAgent {
  const projects: (NodeId | null)[] = [];
  let answer: 'succeed' | 'fail' | 'hang' = 'succeed';
  let statuses: SessionStatus[] = [];
  let noted = 0;
  let calls = 0;
  return {
    projects,
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

interface Harness {
  readonly graphs: Graphs;
  readonly runs: GraphRuns;
  readonly agent: ScriptedAgent;
  readonly timers: FakeTimers;
  /** Every state published through `onState`, in order. */
  readonly published: GraphRunState[];
}

function build(): Harness {
  const graphs = createGraphs({ database: db(), ids, clock, logger, onTreeChanged: () => {} });
  const agent = scriptedAgent();
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
    onState: (state) => published.push(state),
  });
  return { graphs, runs, agent, timers, published };
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
      },
      {
        nodeId: 'classify',
        attempt: 0,
        outcome: 'succeeded',
        output: { kind: 'route', route: 0, to: 'review' },
      },
      {
        nodeId: 'review',
        attempt: 0,
        outcome: 'succeeded',
        output: { kind: 'session', storeId: 'store-work', sessionId: 'session-9', status: 'idle' },
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

  it('hands start tags on to the agent executor', () => {
    const h = build();
    h.runs.noteStarts(nodeIdSchema.parse('store-work') as never, []);
    expect(h.agent.noted).toBe(1);
  });
});
