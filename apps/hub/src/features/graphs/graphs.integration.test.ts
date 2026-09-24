import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  emptyGraphDocument,
  graphDocumentSchema,
  nodeIdSchema,
  type GraphDocument,
} from '@agentplex/protocol';
import { createLogger } from '@agentplex/node-shared';
import type { Database } from '../../db/database.js';
import { openMigratedSchema, type MigratedSchema } from '../../db/test-migrated-schema.js';
import { replaceDraft } from './graph-rows.js';
import { createGraphs, type Graphs } from './graphs.js';

/**
 * The five functions, against a real schema.
 *
 * What is here is everything a graph can do before it runs: be made, be
 * saved, be published under the rules that make a version runnable, and be
 * read back. No machine is involved in any of it -- a graph is the hub's --
 * so unlike the documents suite there is no instruction seam to drive. The
 * socket is `tests/hub-server/src/graphs.integration.test.ts`'s subject.
 */

const logger = createLogger('error', () => {});
const PROJECT = nodeIdSchema.parse('project');

let migrated: MigratedSchema | null = null;
let minted = 0;
let now = 1_756_000_000_000;
/** Every time this feature said the tree had changed. A counter, not a mock. */
let treeChanges = 0;

function db(): Database {
  if (migrated === null) throw new Error('no database: beforeAll did not run');
  return migrated.database;
}

function graphs(database: Database = db()): Graphs {
  return createGraphs({
    database,
    ids: { newId: () => `node-${String((minted += 1))}` },
    clock: { now: () => now },
    logger,
    onTreeChanged: () => {
      treeChanges += 1;
    },
  });
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

/** Documents this suite publishes, parsed once so every field is the schema's. */
function document(value: unknown): GraphDocument {
  return graphDocumentSchema.parse(value);
}

const BASE = {
  position: { x: 0, y: 0 },
  placement: { kind: 'cheapest' },
  retry: { max: 0, backoff: 1 },
};
const TRIGGER = { ...BASE, id: 'start', kind: 'trigger', label: 'Start', source: 'manual' };
const AGENT = {
  ...BASE,
  id: 'review',
  kind: 'agent',
  label: 'Reviewer',
  prompt: 'Review it.',
  provider: 'claude',
  storeId: 'store-universe',
};

const RUNNABLE = document({
  nodes: [TRIGGER, AGENT],
  edges: [{ from: 'start', to: 'review' }],
});

describe('the graphs feature over a real schema', () => {
  beforeAll(async () => {
    migrated = await openMigratedSchema('graphs-probe');
  });

  afterAll(async () => {
    await migrated?.close();
  });

  beforeEach(async () => {
    await db().query('DELETE FROM nodes');
    now = 1_756_000_000_000;
    await makeProject();
    minted = 0;
    treeChanges = 0;
  });

  describe('create', () => {
    it('makes a graph node under the project with draft v1 holding the empty document', async () => {
      const made = await graphs().create(PROJECT, 'release-pipeline');

      expect(made).toEqual({ ok: true, nodeId: 'node-1' });
      if (!made.ok) return;
      const node = await db().query('SELECT kind, parent_id, name FROM nodes WHERE id = ?', [
        made.nodeId,
      ]);
      expect(node.rows[0]).toEqual({ kind: 'graph', parent_id: PROJECT, name: 'release-pipeline' });
      expect(await graphs().open(made.nodeId)).toEqual({
        ok: true,
        nodeId: 'node-1',
        name: 'release-pipeline',
        draftVersion: 1,
        document: emptyGraphDocument(),
        published: [],
      });
    });

    it('says the tree changed once the node is there, and not for a refusal', async () => {
      const feature = graphs();
      await feature.create(PROJECT, 'release-pipeline');
      expect(treeChanges).toBe(1);

      await feature.create(PROJECT, 'release-pipeline');
      expect(treeChanges).toBe(1);
    });

    it('trims the name and refuses one that is only space', async () => {
      const made = await graphs().create(PROJECT, '  nightly  ');
      if (!made.ok) throw new Error('refused');
      const node = await db().query('SELECT name FROM nodes WHERE id = ?', [made.nodeId]);
      expect(node.rows[0]).toEqual({ name: 'nightly' });

      expect(await graphs().create(PROJECT, '   ')).toEqual({
        ok: false,
        code: 'refused',
        problem: 'a graph needs a name',
      });
    });

    it('refuses a node that is not a project, and a second graph of one name', async () => {
      expect(await graphs().create(nodeIdSchema.parse('folder-1'), 'release')).toEqual({
        ok: false,
        code: 'refused',
        problem: 'this hub has no project by that id',
      });

      await graphs().create(PROJECT, 'release');
      const second = await graphs().create(PROJECT, 'release');
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.problem).toContain('already has a graph called release');
    });
  });

  describe('save', () => {
    it('replaces the draft and answers when, on the hub’s clock', async () => {
      const feature = graphs();
      const made = await feature.create(PROJECT, 'release');
      if (!made.ok) throw new Error('refused');
      now += 5_000;

      expect(await feature.save(made.nodeId, RUNNABLE)).toEqual({
        ok: true,
        version: 1,
        updatedAt: 1_756_000_005_000,
      });

      const opened = await feature.open(made.nodeId);
      expect(opened.ok && opened.document).toEqual(RUNNABLE);
      // A save changes no row the tree carries.
      expect(treeChanges).toBe(1);
    });

    it('refuses a node that is not a graph', async () => {
      expect(await graphs().save(PROJECT, RUNNABLE)).toEqual({
        ok: false,
        code: 'refused',
        problem: 'this hub has no graph by that id',
      });
      expect(await graphs().open(PROJECT)).toEqual({
        ok: false,
        code: 'refused',
        problem: 'this hub has no graph by that id',
      });
    });
  });

  describe('publish', () => {
    it('stamps the draft as v1 and opens draft v2 as a copy of it', async () => {
      const feature = graphs();
      const made = await feature.create(PROJECT, 'release');
      if (!made.ok) throw new Error('refused');
      await feature.save(made.nodeId, RUNNABLE);
      now += 10_000;

      expect(await feature.publish(made.nodeId)).toEqual({ ok: true, version: 1 });

      expect(await feature.open(made.nodeId)).toEqual({
        ok: true,
        nodeId: made.nodeId,
        name: 'release',
        draftVersion: 2,
        document: RUNNABLE,
        published: [{ version: 1, publishedAt: 1_756_000_010_000 }],
      });
      expect(await feature.publishedVersion(made.nodeId, 1)).toEqual(RUNNABLE);
      // The draft is not a published version, and neither is a number nobody
      // has reached.
      expect(await feature.publishedVersion(made.nodeId, 2)).toBeNull();
      expect(await feature.publishedVersion(made.nodeId, 9)).toBeNull();
      expect(await feature.publishedVersion(PROJECT, 1)).toBeNull();
    });

    it('numbers each publish after the last', async () => {
      const feature = graphs();
      const made = await feature.create(PROJECT, 'release');
      if (!made.ok) throw new Error('refused');
      await feature.save(made.nodeId, RUNNABLE);

      await feature.publish(made.nodeId);
      expect(await feature.publish(made.nodeId)).toEqual({ ok: true, version: 2 });
      const opened = await feature.open(made.nodeId);
      expect(opened.ok && opened.draftVersion).toBe(3);
      expect(opened.ok && opened.published.map((row) => row.version)).toEqual([1, 2]);
    });

    it('refuses a document with an ACTION node, since no build performs one yet', async () => {
      const feature = graphs();
      const made = await feature.create(PROJECT, 'release');
      if (!made.ok) throw new Error('refused');
      await feature.save(
        made.nodeId,
        document({
          nodes: [
            TRIGGER,
            { ...BASE, id: 'merge', kind: 'action', label: 'Merge + tag', name: 'merge-and-tag' },
          ],
          edges: [{ from: 'start', to: 'merge' }],
        }),
      );

      const refused = await feature.publish(made.nodeId);

      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.code).toBe('refused');
      expect(refused.problem).toContain('no action of that name exists on this build');
      expect(refused.problem).toContain('merge-and-tag');
      // The draft is left as it was, and nothing was published.
      const opened = await feature.open(made.nodeId);
      expect(opened.ok && opened.draftVersion).toBe(1);
      expect(opened.ok && opened.published).toEqual([]);
    });

    it("refuses a HUMAN node that retries, since a person's answer is not asked twice", async () => {
      const feature = graphs();
      const made = await feature.create(PROJECT, 'release');
      if (!made.ok) throw new Error('refused');
      await feature.save(
        made.nodeId,
        document({
          nodes: [
            TRIGGER,
            {
              ...BASE,
              id: 'gate',
              kind: 'human',
              label: 'Sign-off',
              approvers: ['ana'],
              timeoutMinutes: null,
              retry: { max: 2, backoff: 30 },
            },
          ],
          edges: [{ from: 'start', to: 'gate' }],
        }),
      );

      const refused = await feature.publish(made.nodeId);

      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.code).toBe('refused');
      expect(refused.problem).toBe(
        "the HUMAN node Sign-off retries 2 times, and a person's answer is not retried",
      );
      const opened = await feature.open(made.nodeId);
      expect(opened.ok && opened.published).toEqual([]);
    });

    it('checks the draft it freezes, not the one it read before another save landed', async () => {
      const feature = graphs();
      const made = await feature.create(PROJECT, 'release');
      if (!made.ok) throw new Error('refused');
      await feature.save(made.nodeId, RUNNABLE);
      const unrunnable = document({
        nodes: [
          TRIGGER,
          { ...BASE, id: 'merge', kind: 'action', label: 'Merge + tag', name: 'merge-and-tag' },
        ],
        edges: [{ from: 'start', to: 'merge' }],
      });

      // Another client's save lands between whatever this publish read first
      // and the transaction that freezes the draft. A database that does that
      // once, at the transaction's door, is the interleaving written down.
      let landed = false;
      const racing: Database = {
        query: (text, values) => db().query(text, values),
        close: () => db().close(),
        async transaction(body) {
          if (!landed) {
            landed = true;
            await replaceDraft(db(), made.nodeId, unrunnable, now);
          }
          return db().transaction(body);
        },
      };

      const refused = await graphs(racing).publish(made.nodeId);

      expect(landed).toBe(true);
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.problem).toContain('merge-and-tag');
      const opened = await feature.open(made.nodeId);
      expect(opened.ok && opened.draftVersion).toBe(1);
      expect(opened.ok && opened.published).toEqual([]);
    });

    it('refuses a document with no TRIGGER, and one with two', async () => {
      const feature = graphs();
      const made = await feature.create(PROJECT, 'release');
      if (!made.ok) throw new Error('refused');

      await feature.save(made.nodeId, document({ nodes: [AGENT], edges: [] }));
      const none = await feature.publish(made.nodeId);
      expect(none.ok).toBe(false);
      if (none.ok) return;
      expect(none.problem).toContain('TRIGGER');

      await feature.save(
        made.nodeId,
        document({ nodes: [TRIGGER, { ...TRIGGER, id: 'again' }], edges: [] }),
      );
      const two = await feature.publish(made.nodeId);
      expect(two.ok).toBe(false);
      if (two.ok) return;
      expect(two.problem).toContain('one TRIGGER');
    });

    it('refuses a SUB-GRAPH pinned to a version nobody published, and takes one that is', async () => {
      const feature = graphs();
      const child = await feature.create(PROJECT, 'test-matrix');
      const parent = await feature.create(PROJECT, 'release');
      if (!child.ok || !parent.ok) throw new Error('refused');
      const pinned = (version: number): GraphDocument =>
        document({
          nodes: [
            TRIGGER,
            {
              ...BASE,
              id: 'matrix',
              kind: 'subgraph',
              label: 'test-matrix',
              graph: child.nodeId,
              version,
            },
          ],
          edges: [{ from: 'start', to: 'matrix' }],
        });

      await feature.save(parent.nodeId, pinned(1));
      const early = await feature.publish(parent.nodeId);
      expect(early.ok).toBe(false);
      if (early.ok) return;
      expect(early.problem).toContain('test-matrix');
      expect(early.problem).toContain('v1');

      await feature.save(child.nodeId, RUNNABLE);
      await feature.publish(child.nodeId);
      expect(await feature.publish(parent.nodeId)).toEqual({ ok: true, version: 1 });

      // A pin at a graph that is not one is the same refusal, in the same words.
      await feature.save(
        parent.nodeId,
        document({
          nodes: [
            TRIGGER,
            {
              ...BASE,
              id: 'gone',
              kind: 'subgraph',
              label: 'nowhere',
              graph: 'node-99',
              version: 1,
            },
          ],
          edges: [],
        }),
      );
      const missing = await feature.publish(parent.nodeId);
      expect(missing.ok).toBe(false);
      if (missing.ok) return;
      expect(missing.problem).toContain('nowhere');
    });

    it('refuses a node that is not a graph', async () => {
      expect(await graphs().publish(PROJECT)).toEqual({
        ok: false,
        code: 'refused',
        problem: 'this hub has no graph by that id',
      });
    });
  });

  describe('what a run reads', () => {
    it('names the project a graph belongs to, and null for a node that is no graph', async () => {
      const feature = graphs();
      const made = await feature.create(PROJECT, 'release-pipeline');
      if (!made.ok) return;

      expect(await feature.projectOf(made.nodeId)).toBe(PROJECT);
      expect(await feature.projectOf(PROJECT)).toBeNull();
    });

    it('answers the newest published version and never the draft', async () => {
      const feature = graphs();
      const made = await feature.create(PROJECT, 'release-pipeline');
      if (!made.ok) return;

      expect(await feature.latestPublished(made.nodeId)).toBeNull();

      await feature.save(made.nodeId, RUNNABLE);
      await feature.publish(made.nodeId);
      const edited = document({ nodes: [TRIGGER], edges: [] });
      await feature.save(made.nodeId, edited);

      expect(await feature.latestPublished(made.nodeId)).toEqual({
        version: 1,
        document: RUNNABLE,
      });

      await feature.publish(made.nodeId);
      expect(await feature.latestPublished(made.nodeId)).toEqual({ version: 2, document: edited });
      expect(await feature.latestPublished(PROJECT)).toBeNull();
    });
  });
});
