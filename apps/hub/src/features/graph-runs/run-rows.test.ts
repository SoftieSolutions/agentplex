import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  graphDocumentSchema,
  graphRunIdSchema,
  nodeIdSchema,
  type GraphRunStep,
  type NodeId,
} from '@agentplex/protocol';
import { createLogger } from '@agentplex/node-shared';
import type { Database } from '../../db/database.js';
import { openMigratedSchema, type MigratedSchema } from '../../db/test-migrated-schema.js';
import { createGraphs } from '../graphs/graphs.js';
import {
  endRun,
  failRunningRuns,
  insertRun,
  latestRun,
  listRuns,
  readRun,
  replaceSteps,
} from './run-rows.js';

/**
 * The rows a run is, against the real schema 0018 makes.
 *
 * What is here is what the migration promises and the runtime leans on: a
 * number allocated per graph inside the insert's own transaction so two
 * starts in the same instant never collide, steps that read back as the
 * protocol states them, a listing newest first, and a sweep that ends only
 * what was still running. Each is asserted by trying to break it.
 */

const NOW = 1_756_000_000_000;
const clock = { now: () => NOW };
const logger = createLogger('error', () => {});
const PROJECT = nodeIdSchema.parse('project');

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
    [PROJECT, NOW],
  );
  await db().query('INSERT INTO projects (node_id, directory, created_at) VALUES (?, ?, ?)', [
    PROJECT,
    '/srv/work/universe',
    NOW,
  ]);
}

const TRIGGER_ONLY = graphDocumentSchema.parse({
  nodes: [
    {
      id: 'start',
      kind: 'trigger',
      label: 'Start',
      position: { x: 0, y: 0 },
      placement: { kind: 'cheapest' },
      retry: { max: 0, backoff: 1 },
      source: 'manual',
    },
  ],
  edges: [],
});

/** A graph with v1 published, through the feature that owns it, so a run has a version to name. */
async function publishedGraph(name = 'release-pipeline'): Promise<NodeId> {
  const graphs = createGraphs({ database: db(), ids, clock, logger, onTreeChanged: () => {} });
  const made = await graphs.create(PROJECT, name);
  if (!made.ok) throw new Error('the graph was not made');
  await graphs.save(made.nodeId, TRIGGER_ONLY);
  const published = await graphs.publish(made.nodeId);
  if (!published.ok) throw new Error(published.problem);
  return made.nodeId;
}

const STEPS: readonly GraphRunStep[] = [
  {
    nodeId: 'start' as GraphRunStep['nodeId'],
    attempt: 0,
    outcome: 'succeeded',
    output: { kind: 'text', text: '{"language":"rust"}' },
  },
];

describe('run rows', () => {
  beforeAll(async () => {
    migrated = await openMigratedSchema('graph-run-rows');
  });

  afterAll(async () => {
    await migrated?.close();
  });

  beforeEach(async () => {
    await db().query('DELETE FROM nodes');
    minted = 0;
    await makeProject();
  });

  it('numbers runs per graph from 1, and a second graph starts its own count', async () => {
    const first = await publishedGraph('one');
    const second = await publishedGraph('two');

    const a = await insertRun(db(), ids, clock, { graphNodeId: first, version: 1, input: {} });
    const b = await insertRun(db(), ids, clock, { graphNodeId: first, version: 1, input: {} });
    const c = await insertRun(db(), ids, clock, { graphNodeId: second, version: 1, input: {} });

    expect([a.number, b.number, c.number]).toEqual([1, 2, 1]);
    expect(a.runId).not.toBe(b.runId);
  });

  it('gives two starts in the same instant two numbers, with UNIQUE as the last word', async () => {
    const graph = await publishedGraph();

    const [a, b] = await Promise.all([
      insertRun(db(), ids, clock, { graphNodeId: graph, version: 1, input: { n: 1 } }),
      insertRun(db(), ids, clock, { graphNodeId: graph, version: 1, input: { n: 2 } }),
    ]);

    expect(new Set([a.number, b.number])).toEqual(new Set([1, 2]));
    // And the constraint itself holds when the allocation is bypassed.
    await expect(
      db().query(
        `INSERT INTO graph_runs (id, graph_node_id, version, number, input, steps, status, reason, started_at, ended_at)
         VALUES ('dup', ?, 1, 1, '{}', '[]', 'running', NULL, ?, NULL)`,
        [graph, NOW],
      ),
    ).rejects.toThrow(/UNIQUE/);
  });

  it('reads a run back whole: input, steps and status as the schema states them', async () => {
    const graph = await publishedGraph();
    const { runId } = await insertRun(db(), ids, clock, {
      graphNodeId: graph,
      version: 1,
      input: { language: 'rust' },
    });

    await replaceSteps(db(), runId, STEPS);
    const running = await readRun(db(), runId);
    expect(running).toEqual({
      runId,
      graphNodeId: graph,
      version: 1,
      number: 1,
      input: { language: 'rust' },
      steps: STEPS,
      status: 'running',
      reason: null,
      startedAt: NOW,
      endedAt: null,
    });

    await endRun(db(), runId, {
      status: 'succeeded',
      reason: null,
      steps: STEPS,
      endedAt: NOW + 5,
    });
    expect(await readRun(db(), runId)).toMatchObject({
      status: 'succeeded',
      reason: null,
      endedAt: NOW + 5,
    });
  });

  it('keeps the sentence a failed run ended with', async () => {
    const graph = await publishedGraph();
    const { runId } = await insertRun(db(), ids, clock, {
      graphNodeId: graph,
      version: 1,
      input: {},
    });

    await endRun(db(), runId, {
      status: 'failed',
      reason: 'no route on classify matched and it has no otherwise',
      steps: [],
      endedAt: NOW + 1,
    });

    expect((await readRun(db(), runId))?.reason).toBe(
      'no route on classify matched and it has no otherwise',
    );
  });

  it('lists one graph’s runs newest first, and nothing for a graph never run', async () => {
    const graph = await publishedGraph();
    const other = await publishedGraph('other');
    await insertRun(db(), ids, clock, { graphNodeId: graph, version: 1, input: {} });
    await insertRun(db(), ids, clock, { graphNodeId: graph, version: 1, input: {} });
    await insertRun(db(), ids, clock, { graphNodeId: graph, version: 1, input: {} });

    expect((await listRuns(db(), graph)).map((run) => run.number)).toEqual([3, 2, 1]);
    expect(await listRuns(db(), other)).toEqual([]);
  });

  it('reads one graph’s newest run alone, and null for a graph never run', async () => {
    const graph = await publishedGraph();
    const other = await publishedGraph('other');
    await insertRun(db(), ids, clock, { graphNodeId: graph, version: 1, input: {} });
    const second = await insertRun(db(), ids, clock, { graphNodeId: graph, version: 1, input: {} });

    expect(await latestRun(db(), graph)).toMatchObject({ runId: second.runId, number: 2 });
    expect(await latestRun(db(), other)).toBeNull();
  });

  it('answers null for a run id nobody minted', async () => {
    expect(await readRun(db(), graphRunIdSchema.parse('nowhere'))).toBeNull();
  });

  it('refuses a run of a version the graph never published', async () => {
    const graph = await publishedGraph();

    await expect(
      insertRun(db(), ids, clock, { graphNodeId: graph, version: 7, input: {} }),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it('ends every running row at a sweep, names the restart, and leaves the finished alone', async () => {
    const graph = await publishedGraph();
    const left = await insertRun(db(), ids, clock, { graphNodeId: graph, version: 1, input: {} });
    const done = await insertRun(db(), ids, clock, { graphNodeId: graph, version: 1, input: {} });
    await endRun(db(), done.runId, { status: 'succeeded', reason: null, steps: [], endedAt: NOW });

    const swept = await failRunningRuns(
      db(),
      NOW + 60_000,
      'the hub restarted while this run was in flight',
    );

    expect(swept).toBe(1);
    expect(await readRun(db(), left.runId)).toMatchObject({
      status: 'failed',
      reason: 'the hub restarted while this run was in flight',
      endedAt: NOW + 60_000,
    });
    expect(await readRun(db(), done.runId)).toMatchObject({ status: 'succeeded', endedAt: NOW });
    expect(await failRunningRuns(db(), NOW + 60_001, 'again')).toBe(0);
  });

  it('goes with its graph when the graph is removed', async () => {
    const graph = await publishedGraph();
    const { runId } = await insertRun(db(), ids, clock, {
      graphNodeId: graph,
      version: 1,
      input: {},
    });

    await db().query('DELETE FROM nodes WHERE id = ?', [graph]);

    expect(await readRun(db(), runId)).toBeNull();
  });
});
