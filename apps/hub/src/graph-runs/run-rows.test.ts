import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  graphDocumentSchema,
  graphNodeIdSchema,
  graphRunIdSchema,
  nodeIdSchema,
  type GraphRunStep,
  type NodeId,
} from '@agentplex/protocol';
import { createLogger } from '@agentplex/node-shared';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from '../db/database.js';
import { loadMigrations } from '../db/migration-files.js';
import { nodeMigrationFileSystem } from '../db/node-migration-files.js';
import { createSqliteDatabase } from '../db/sqlite.js';
import { openMigratedSchema, type MigratedSchema } from '../db/test-migrated-schema.js';
import { createGraphs } from '../graphs/graphs.js';
import {
  childrenOf,
  endRun,
  failRunningRuns,
  insertRun,
  latestRun,
  listRuns,
  readRun,
  replaceSteps,
  runHistory,
  type RunEnd,
  type RunRow,
} from './run-rows.js';

/**
 * The rows a run is, against the real schema 0018 and 0019 make.
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
    child: null,
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
      parentRunId: null,
      parentNodeId: null,
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

  it('admits only a final status as an end, so endRun cannot write an open one', () => {
    const ends: RunEnd[] = [
      { status: 'succeeded', reason: null, steps: [], endedAt: NOW },
      { status: 'failed', reason: 'it broke', steps: [], endedAt: NOW },
      { status: 'cancelled', reason: null, steps: [], endedAt: NOW },
      // @ts-expect-error -- `running` is open: a run ending in it would never end.
      { status: 'running', reason: null, steps: [], endedAt: NOW },
      // @ts-expect-error -- `waiting` is open too, parked on a person.
      { status: 'waiting', reason: null, steps: [], endedAt: NOW },
    ];
    expect(ends).toHaveLength(5);
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

  describe('children', () => {
    it('numbers a child in its own graph, and names the parent run and the step node', async () => {
      const parentGraph = await publishedGraph('parent');
      const childGraph = await publishedGraph('child');
      await insertRun(db(), ids, clock, { graphNodeId: childGraph, version: 1, input: {} });
      const parent = await insertRun(db(), ids, clock, {
        graphNodeId: parentGraph,
        version: 1,
        input: {},
      });

      const child = await insertRun(db(), ids, clock, {
        graphNodeId: childGraph,
        version: 1,
        input: { language: 'rust' },
        parent: { runId: parent.runId, nodeId: graphNodeIdSchema.parse('lint') },
      });

      // The child graph had run once on its own; the child is its second.
      expect(child.number).toBe(2);
      expect(await readRun(db(), child.runId)).toMatchObject({
        graphNodeId: childGraph,
        parentRunId: parent.runId,
        parentNodeId: 'lint',
      });
      expect(await readRun(db(), parent.runId)).toMatchObject({
        parentRunId: null,
        parentNodeId: null,
      });
    });

    it('lists the children one step of a run started, oldest first', async () => {
      const parentGraph = await publishedGraph('parent');
      const childGraph = await publishedGraph('child');
      const parent = await insertRun(db(), ids, clock, {
        graphNodeId: parentGraph,
        version: 1,
        input: {},
      });
      const lint = graphNodeIdSchema.parse('lint');
      const first = await insertRun(db(), ids, clock, {
        graphNodeId: childGraph,
        version: 1,
        input: {},
        parent: { runId: parent.runId, nodeId: lint },
      });
      const retried = await insertRun(db(), ids, clock, {
        graphNodeId: childGraph,
        version: 1,
        input: {},
        parent: { runId: parent.runId, nodeId: lint },
      });
      await insertRun(db(), ids, clock, {
        graphNodeId: childGraph,
        version: 1,
        input: {},
        parent: { runId: parent.runId, nodeId: graphNodeIdSchema.parse('docs') },
      });

      expect((await childrenOf(db(), parent.runId, lint)).map((row) => row.runId)).toEqual([
        first.runId,
        retried.runId,
      ]);
    });

    it('keeps a child in its own graph when the parent graph is removed, naming no run', async () => {
      const parentGraph = await publishedGraph('parent');
      const childGraph = await publishedGraph('child');
      const parent = await insertRun(db(), ids, clock, {
        graphNodeId: parentGraph,
        version: 1,
        input: {},
      });
      const child = await insertRun(db(), ids, clock, {
        graphNodeId: childGraph,
        version: 1,
        input: {},
        parent: { runId: parent.runId, nodeId: graphNodeIdSchema.parse('lint') },
      });

      await db().query('DELETE FROM nodes WHERE id = ?', [parentGraph]);

      // The child graph's history is the child graph's: removing some other
      // graph does not reach into it. The run stays, and no longer names a
      // run nothing can open.
      expect(await readRun(db(), child.runId)).toMatchObject({
        number: 1,
        parentRunId: null,
      });
    });
  });

  describe('history', () => {
    it('lists one graph’s runs newest first as summaries, without their steps', async () => {
      const graph = await publishedGraph();
      const first = await insertRun(db(), ids, clock, {
        graphNodeId: graph,
        version: 1,
        input: {},
      });
      await endRun(db(), first.runId, {
        status: 'failed',
        reason: 'the AGENT node Rust reviewer failed: the box said no',
        steps: STEPS,
        endedAt: NOW + 9,
      });
      const second = await insertRun(db(), ids, clock, {
        graphNodeId: graph,
        version: 1,
        input: {},
      });

      expect(await runHistory(db(), graph, 50)).toEqual([
        {
          runId: second.runId,
          number: 2,
          status: 'running',
          startedAt: NOW,
          endedAt: null,
          reason: null,
        },
        {
          runId: first.runId,
          number: 1,
          status: 'failed',
          startedAt: NOW,
          endedAt: NOW + 9,
          reason: 'the AGENT node Rust reviewer failed: the box said no',
        },
      ]);
    });

    it('keeps to this graph’s own runs: a run its steps started is the child graph’s', async () => {
      const parentGraph = await publishedGraph('parent');
      const childGraph = await publishedGraph('child');
      const parent = await insertRun(db(), ids, clock, {
        graphNodeId: parentGraph,
        version: 1,
        input: {},
      });
      const child = await insertRun(db(), ids, clock, {
        graphNodeId: childGraph,
        version: 1,
        input: {},
        parent: { runId: parent.runId, nodeId: graphNodeIdSchema.parse('lint') },
      });

      expect((await runHistory(db(), parentGraph, 50)).map((run) => run.runId)).toEqual([
        parent.runId,
      ]);
      // And the child is in its own graph's list, where its number is.
      expect(await runHistory(db(), childGraph, 50)).toMatchObject([
        { runId: child.runId, number: 1 },
      ]);
    });

    it('stops at the bound, keeping the newest', async () => {
      const graph = await publishedGraph();
      for (let index = 0; index < 5; index += 1) {
        await insertRun(db(), ids, clock, { graphNodeId: graph, version: 1, input: {} });
      }

      expect((await runHistory(db(), graph, 3)).map((run) => run.number)).toEqual([5, 4, 3]);
    });

    it('is an empty list for a graph never run', async () => {
      const graph = await publishedGraph();

      expect(await runHistory(db(), graph, 50)).toEqual([]);
    });
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

describe('0019 over step lists written before it', () => {
  /**
   * Migrates a fresh database up to 0018, stores one run with these steps as
   * 0018 wrote them, applies 0019 and after, and reads the run back.
   */
  async function migratedOver(legacy: readonly object[]): Promise<RunRow | null> {
    const directory = await mkdtemp(join(tmpdir(), 'agentplex-AGX-265-0019-'));
    const database = createSqliteDatabase(join(directory, 'hub.db'));
    try {
      const migrations = await loadMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
        nodeMigrationFileSystem,
      );
      for (const migration of migrations.filter((each) => each.version < 19)) {
        await database.query(migration.sql);
      }
      const graphs = createGraphs({ database, ids, clock, logger, onTreeChanged: () => {} });
      await database.query(
        `INSERT INTO nodes (id, parent_id, kind, position, name, name_source, created_at)
         VALUES (?, NULL, 'project', 0, 'work', 'user', ?)`,
        [PROJECT, NOW],
      );
      await database.query(
        'INSERT INTO projects (node_id, directory, created_at) VALUES (?, ?, ?)',
        [PROJECT, '/srv/work', NOW],
      );
      const made = await graphs.create(PROJECT, 'old');
      if (!made.ok) throw new Error(made.problem);
      await graphs.save(made.nodeId, TRIGGER_ONLY);
      await graphs.publish(made.nodeId);
      await database.query(
        `INSERT INTO graph_runs (id, graph_node_id, version, number, input, steps, status, reason, started_at, ended_at)
         VALUES ('old-run', ?, 1, 1, '{}', ?, 'succeeded', NULL, ?, ?)`,
        [made.nodeId, JSON.stringify(legacy), NOW, NOW + 1],
      );

      for (const migration of migrations.filter((each) => each.version >= 19)) {
        await database.query(migration.sql);
      }

      return await readRun(database, graphRunIdSchema.parse('old-run'));
    } finally {
      await database.close();
      await rm(directory, { recursive: true, force: true });
    }
  }

  it('gives every stored step a null child, so an old run still reads back', async () => {
    const legacy = [{ nodeId: 'start', attempt: 0, outcome: 'succeeded', output: null }];

    expect(await migratedOver(legacy)).toMatchObject({
      steps: [{ nodeId: 'start', attempt: 0, outcome: 'succeeded', output: null, child: null }],
      parentRunId: null,
      parentNodeId: null,
    });
  });

  /**
   * A step list is the order the run walked, and the strip, LAST OUTPUT and
   * a retry's attempt count all read it by position. Enough steps that an
   * aggregate free to reorder would be caught doing it.
   */
  it('keeps a long step list in the order it was written', async () => {
    const legacy = Array.from({ length: 64 }, (_, index) => ({
      nodeId: `node-${String(63 - index)}`,
      attempt: index % 3,
      outcome: 'succeeded',
      output: null,
    }));

    const run = await migratedOver(legacy);

    expect(run?.steps.map((step) => [step.nodeId, step.attempt])).toEqual(
      legacy.map((step) => [step.nodeId, step.attempt]),
    );
    expect(run?.steps.every((step) => step.child === null)).toBe(true);
  });

  it('leaves an empty step list empty', async () => {
    expect((await migratedOver([]))?.steps).toEqual([]);
  });

  it('carries a step’s nested output through the rewrite as it was, JSON text still text', async () => {
    const legacy = [
      {
        nodeId: 'start',
        attempt: 0,
        outcome: 'succeeded',
        output: { kind: 'text', text: '{"language":"rust"}' },
      },
      {
        nodeId: 'classify',
        attempt: 1,
        outcome: 'succeeded',
        output: { kind: 'route', route: 0, to: 'review' },
      },
    ];

    expect((await migratedOver(legacy))?.steps).toEqual([
      { ...legacy[0], child: null },
      { ...legacy[1], child: null },
    ]);
  });
});
