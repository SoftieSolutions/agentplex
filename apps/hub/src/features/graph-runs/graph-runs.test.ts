import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  graphDocumentSchema,
  graphRunIdSchema,
  nodeIdSchema,
  type GraphDocument,
  type GraphRunState,
  type NodeId,
} from '@agentplex/protocol';
import { createFakeTimers, type FakeTimers } from '@agentplex/node-shared/testing';
import { createLogger } from '@agentplex/node-shared';
import type { Database } from '../../db/database.js';
import { openMigratedSchema, type MigratedSchema } from '../../db/test-migrated-schema.js';
import { createGraphs, type Graphs } from '../graphs/graphs.js';
import type { AgentExecutor } from './agent-executor.js';
import { createGraphRuns, type GraphRuns } from './graph-runs.js';
import { readRun } from './run-rows.js';

/**
 * The runtime's entry: a run from the frame's two fields to a row and a
 * stream of states, over the real graphs feature and a real schema.
 *
 * The AGENT executor is a hand-written seam here, because what this file is
 * about is what the feature does around a step -- number it, persist it,
 * publish it, end it, sweep it at boot -- and not what a step does. The real
 * executor is `agent-executor.test.ts`'s subject.
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

/** An AGENT executor whose answer the suite chooses, and that records the project it was built for. */
interface ScriptedAgent extends AgentExecutor {
  readonly projects: (NodeId | null)[];
  readonly noted: number;
  answerWith(answer: 'succeed' | 'fail' | 'hang'): void;
}

function scriptedAgent(): ScriptedAgent {
  const projects: (NodeId | null)[] = [];
  let answer: 'succeed' | 'fail' | 'hang' = 'succeed';
  let noted = 0;
  return {
    projects,
    get noted() {
      return noted;
    },
    answerWith(next) {
      answer = next;
    },
    forProject(project) {
      projects.push(project);
      return (node, _input, context) => {
        if (answer === 'succeed') {
          return Promise.resolve({
            ok: true,
            output: { storeId: node.storeId, sessionId: 'session-9', status: 'idle' },
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

async function publishedGraph(h: Harness, document: GraphDocument = RUNNABLE): Promise<NodeId> {
  const made = await h.graphs.create(PROJECT, 'release-pipeline');
  if (!made.ok) throw new Error(made.problem);
  await h.graphs.save(made.nodeId, document);
  const published = await h.graphs.publish(made.nodeId);
  if (!published.ok) throw new Error(published.problem);
  return made.nodeId;
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
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

  it('runs the newest published version to the end, publishing every state and persisting the row', async () => {
    const h = build();
    const graph = await publishedGraph(h);

    const started = await h.runs.start(graph, { language: 'rust' });
    // The graph node took id-1; the run is the next thing this hub named.
    expect(started).toEqual({ ok: true, runId: 'id-2', number: 1 });
    if (!started.ok) return;
    await settle();

    const statuses = h.published.map(
      (state) => `${state.status}:${String(state.step)}/${String(state.of)}`,
    );
    expect(statuses[0]).toBe('running:0/3');
    expect(statuses.at(-1)).toBe('succeeded:3/3');
    const last = h.published.at(-1);
    expect(last?.steps).toEqual([
      { nodeId: 'start', attempt: 0, outcome: 'succeeded', output: { language: 'rust' } },
      { nodeId: 'classify', attempt: 0, outcome: 'succeeded', output: { language: 'rust' } },
      {
        nodeId: 'review',
        attempt: 0,
        outcome: 'succeeded',
        output: { storeId: 'store-work', sessionId: 'session-9', status: 'idle' },
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

  it('tells a subscriber of one run about that run and no other, until it ends', async () => {
    const h = build();
    const graph = await publishedGraph(h);
    h.agent.answerWith('hang');
    const first = await h.runs.start(graph, { language: 'rust' });
    if (!first.ok) throw new Error(first.problem);
    const seen: GraphRunState[] = [];
    const stop = h.runs.subscribe(first.runId, (state) => seen.push(state));

    await h.runs.start(graph, { language: 'rust' });
    await settle();
    expect(seen.every((state) => state.runId === first.runId)).toBe(true);
    expect(seen.length).toBeGreaterThan(0);

    await h.runs.cancel(first.runId);
    await settle();
    expect(seen.at(-1)?.status).toBe('cancelled');
    stop();
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

  it('hands start tags on to the agent executor', () => {
    const h = build();
    h.runs.noteStarts(nodeIdSchema.parse('store-work') as never, []);
    expect(h.agent.noted).toBe(1);
  });
});
