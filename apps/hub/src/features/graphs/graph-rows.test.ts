import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emptyGraphDocument, nodeIdSchema, type GraphDocument } from '@agentplex/protocol';
import type { Database } from '../../db/database.js';
import { openMigratedSchema, type MigratedSchema } from '../../db/test-migrated-schema.js';
import {
  GRAPH_KIND,
  insertGraph,
  listPublishedVersions,
  publishDraft,
  readDraft,
  readGraph,
  readVersion,
  replaceDraft,
} from './graph-rows.js';

/**
 * The rows a graph is, against the real schema 0017 makes.
 *
 * What is here is what the migration promises and the code leans on: one
 * draft per graph, a published row that cannot be changed, and version numbers
 * unique per graph. Each is asserted by trying to break it, because a rule
 * stated in a comment and never tried is a rule the next migration can lose.
 */

const NOW = 1_756_000_000_000;
const clock = { now: () => NOW };
const PROJECT = nodeIdSchema.parse('project');

let migrated: MigratedSchema | null = null;
let minted = 0;
const ids = { newId: () => `graph-${String((minted += 1))}` };

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

const TRIGGER_ONLY: GraphDocument = {
  nodes: [
    {
      id: 'start' as GraphDocument['nodes'][number]['id'],
      kind: 'trigger',
      label: 'Start',
      position: { x: 0, y: 0 },
      placement: { kind: 'cheapest' },
      retry: { max: 0, backoff: 1 },
      source: 'manual',
    },
  ],
  edges: [],
};

describe('the graph rows over a real schema', () => {
  beforeAll(async () => {
    migrated = await openMigratedSchema('graph-rows');
  });

  afterAll(async () => {
    await migrated?.close();
  });

  beforeEach(async () => {
    await db().query('DELETE FROM nodes');
    await makeProject();
    minted = 0;
  });

  it('finds the graph kind seeded by 0017, so nothing has to insert it at startup', async () => {
    const kinds = await db().query(
      "SELECT kind, container, anchors_session FROM node_kinds WHERE kind = 'graph'",
    );
    expect(kinds.rows).toEqual([{ kind: 'graph', container: 0, anchors_session: 0 }]);
    expect(GRAPH_KIND).toBe('graph');
  });

  it('makes a node under the project, a graphs row, and draft version 1 holding the empty document', async () => {
    const made = await insertGraph(db(), ids, clock, { projectNodeId: PROJECT, name: 'release' });

    expect(made).toEqual({ ok: true, nodeId: 'graph-1' });
    if (!made.ok) return;
    const node = await db().query(
      'SELECT kind, parent_id, name, name_source, position FROM nodes WHERE id = ?',
      [made.nodeId],
    );
    expect(node.rows[0]).toEqual({
      kind: 'graph',
      parent_id: PROJECT,
      name: 'release',
      name_source: 'user',
      position: 0,
    });
    expect(await readGraph(db(), made.nodeId)).toEqual({
      nodeId: 'graph-1',
      projectNodeId: PROJECT,
      name: 'release',
    });
    expect(await readDraft(db(), made.nodeId)).toEqual({
      version: 1,
      document: emptyGraphDocument(),
      updatedAt: NOW,
    });
    expect(await listPublishedVersions(db(), made.nodeId)).toEqual([]);
  });

  it('places a second graph after the first under the same project', async () => {
    await insertGraph(db(), ids, clock, { projectNodeId: PROJECT, name: 'release' });
    const second = await insertGraph(db(), ids, clock, { projectNodeId: PROJECT, name: 'matrix' });
    if (!second.ok) throw new Error('the second graph was refused');
    const node = await db().query('SELECT position FROM nodes WHERE id = ?', [second.nodeId]);
    expect(node.rows[0]).toEqual({ position: 1 });
  });

  it('refuses a second graph of one name in one project, and a project that is not one', async () => {
    await insertGraph(db(), ids, clock, { projectNodeId: PROJECT, name: 'release' });
    expect(
      await insertGraph(db(), ids, clock, { projectNodeId: PROJECT, name: 'release' }),
    ).toEqual({ ok: false, duplicate: true });
    expect(
      await insertGraph(db(), ids, clock, {
        projectNodeId: nodeIdSchema.parse('folder-9'),
        name: 'release',
      }),
    ).toEqual({ ok: false, noProject: true });
  });

  it('answers null for a node that is not a graph', async () => {
    expect(await readGraph(db(), PROJECT)).toBeNull();
    expect(await readDraft(db(), PROJECT)).toBeNull();
    expect(await readVersion(db(), PROJECT, 1)).toBeNull();
  });

  it('replaces the draft document and records when', async () => {
    const made = await insertGraph(db(), ids, clock, { projectNodeId: PROJECT, name: 'release' });
    if (!made.ok) throw new Error('refused');

    expect(await replaceDraft(db(), made.nodeId, TRIGGER_ONLY, NOW + 5)).toEqual({ version: 1 });

    expect(await readDraft(db(), made.nodeId)).toEqual({
      version: 1,
      document: TRIGGER_ONLY,
      updatedAt: NOW + 5,
    });
    expect(await replaceDraft(db(), PROJECT, TRIGGER_ONLY, NOW)).toBeNull();
  });

  it('publishes the draft as v1 and opens draft v2 as a copy of it', async () => {
    const made = await insertGraph(db(), ids, clock, { projectNodeId: PROJECT, name: 'release' });
    if (!made.ok) throw new Error('refused');
    await replaceDraft(db(), made.nodeId, TRIGGER_ONLY, NOW + 5);

    expect(await publishDraft(db(), made.nodeId, NOW + 10)).toEqual({ version: 1 });

    expect(await readVersion(db(), made.nodeId, 1)).toEqual({
      version: 1,
      document: TRIGGER_ONLY,
      updatedAt: NOW + 5,
      publishedAt: NOW + 10,
    });
    expect(await readDraft(db(), made.nodeId)).toEqual({
      version: 2,
      document: TRIGGER_ONLY,
      updatedAt: NOW + 10,
    });
    expect(await listPublishedVersions(db(), made.nodeId)).toEqual([
      { version: 1, publishedAt: NOW + 10 },
    ]);

    expect(await publishDraft(db(), made.nodeId, NOW + 20)).toEqual({ version: 2 });
    expect((await listPublishedVersions(db(), made.nodeId)).map((row) => row.version)).toEqual([
      1, 2,
    ]);
    expect(await publishDraft(db(), PROJECT, NOW)).toBeNull();
  });

  it('keeps one draft per graph as a schema fact', async () => {
    const made = await insertGraph(db(), ids, clock, { projectNodeId: PROJECT, name: 'release' });
    if (!made.ok) throw new Error('refused');

    await expect(
      db().query(
        `INSERT INTO graph_versions (graph_node_id, version, document, updated_at, published_at)
         VALUES (?, 7, '{"nodes":[],"edges":[]}', ?, NULL)`,
        [made.nodeId, NOW],
      ),
    ).rejects.toThrow();
  });

  it('refuses any change to a published row, by trigger', async () => {
    const made = await insertGraph(db(), ids, clock, { projectNodeId: PROJECT, name: 'release' });
    if (!made.ok) throw new Error('refused');
    await publishDraft(db(), made.nodeId, NOW + 10);

    await expect(
      db().query(
        `UPDATE graph_versions SET document = '{"nodes":[],"edges":[]}'
          WHERE graph_node_id = ? AND version = 1`,
        [made.nodeId],
      ),
    ).rejects.toThrow('immutable');
    await expect(
      db().query(
        'UPDATE graph_versions SET published_at = NULL WHERE graph_node_id = ? AND version = 1',
        [made.nodeId],
      ),
    ).rejects.toThrow('immutable');
    // The draft is not published, so the trigger leaves it alone.
    await expect(
      db().query(
        'UPDATE graph_versions SET updated_at = ? WHERE graph_node_id = ? AND version = 2',
        [NOW + 11, made.nodeId],
      ),
    ).resolves.toBeDefined();
  });

  it('keeps version numbers unique per graph', async () => {
    const made = await insertGraph(db(), ids, clock, { projectNodeId: PROJECT, name: 'release' });
    if (!made.ok) throw new Error('refused');
    await publishDraft(db(), made.nodeId, NOW + 10);

    await expect(
      db().query(
        `INSERT INTO graph_versions (graph_node_id, version, document, updated_at, published_at)
         VALUES (?, 1, '{"nodes":[],"edges":[]}', ?, ?)`,
        [made.nodeId, NOW, NOW],
      ),
    ).rejects.toThrow();
  });

  it('takes every version with the node when the graph is removed', async () => {
    const made = await insertGraph(db(), ids, clock, { projectNodeId: PROJECT, name: 'release' });
    if (!made.ok) throw new Error('refused');
    await publishDraft(db(), made.nodeId, NOW + 10);

    await db().query('DELETE FROM nodes WHERE id = ?', [made.nodeId]);

    const left = await db().query('SELECT version FROM graph_versions WHERE graph_node_id = ?', [
      made.nodeId,
    ]);
    expect(left.rows).toEqual([]);
    expect(await readGraph(db(), made.nodeId)).toBeNull();
  });

  it('refuses a stored document that does not parse rather than handing it on', async () => {
    const made = await insertGraph(db(), ids, clock, { projectNodeId: PROJECT, name: 'release' });
    if (!made.ok) throw new Error('refused');
    await db().query(
      'UPDATE graph_versions SET document = \'{"nodes":[{"kind":"webhook"}]}\' WHERE graph_node_id = ?',
      [made.nodeId],
    );

    await expect(readDraft(db(), made.nodeId)).rejects.toThrow();
  });
});
