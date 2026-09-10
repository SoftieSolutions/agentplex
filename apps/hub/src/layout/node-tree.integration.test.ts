import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  nodeIdSchema,
  sessionIdSchema,
  storeIdSchema,
  type NodeId,
  type SessionRef,
} from '@agentplex/protocol';
import type { Database } from '../db/database.js';
import { openMigratedSchema, type MigratedSchema } from '../pairing/test-migrated-schema.js';
import { discoverNodes } from './node-discovery.js';
import {
  createFolder,
  findNode,
  findNodeForSession,
  forgetRemoval,
  listNodeKinds,
  listNodes,
  listRemovals,
  moveNode,
  readLayout,
  removeNode,
  renameNode,
} from './node-tree.js';

/**
 * The node tree's writes, against a real database.
 *
 * What is worth asserting here is the behaviour the engine provides and this
 * module relies on -- the cascade, the partial unique index on an anchor, the
 * kinds being rows -- and the rules SQL cannot express, which this module has
 * to enforce itself: a session holds no children, and a node cannot be moved
 * inside itself.
 */

let migrated: MigratedSchema | null = null;

const NOW = 1_756_000_000_000;
const clock = { now: () => NOW };

let minted = 0;
const ids = { newId: () => `node-${String((minted += 1))}` };

function db(): Database {
  if (migrated === null) throw new Error('no database: beforeAll did not run');
  return migrated.database;
}

const STORE = storeIdSchema.parse('store-a');

function ref(sessionId: string): SessionRef {
  return { storeId: STORE, sessionId: sessionIdSchema.parse(sessionId) };
}

/** An id no node has, for the three "not there" answers below. */
const ABSENT: NodeId = nodeIdSchema.parse('no-such-node');

describe('the node tree', () => {
  beforeAll(async () => {
    migrated = await openMigratedSchema('layout-tree-probe');
  });

  afterAll(async () => {
    await migrated?.close();
  });

  beforeEach(async () => {
    await db().query('DELETE FROM nodes');
    await db().query('DELETE FROM node_removals');
    minted = 0;
  });

  it('reads the kinds the migration seeded, as data rather than as an enum', async () => {
    const kinds = await listNodeKinds(db());

    expect(kinds).toEqual([
      { kind: 'folder', container: true, anchorsSession: false },
      { kind: 'session', container: false, anchorsSession: true },
    ]);
  });

  it('creates a folder the user named, owned by the user from the first moment', async () => {
    const folder = await createFolder(db(), ids, clock, { parentId: null, name: 'this week' });

    expect(folder.name).toBe('this week');
    expect(folder.named).toBe(true);
    expect(folder.anchor).toBeNull();
    expect(folder.createdAt).toBe(NOW);
  });

  it('refuses a folder name that is nothing but spaces', async () => {
    await expect(createFolder(db(), ids, clock, { parentId: null, name: '   ' })).rejects.toThrow();
  });

  /** A rule SQL cannot state: a CHECK cannot consult another table's row. */
  it('refuses to put a node inside a kind that holds no children', async () => {
    await discoverNodes(db(), ids, clock, [{ ref: ref('s1'), title: 'one' }]);
    const session = await findNodeForSession(db(), ref('s1'));
    if (session === null) throw new Error('the node discovery just created is missing');

    await expect(
      createFolder(db(), ids, clock, { parentId: session.id, name: 'inside a session' }),
    ).rejects.toThrow(/cannot hold children/);
  });

  it('refuses to move a node inside itself', async () => {
    const outer = await createFolder(db(), ids, clock, { parentId: null, name: 'outer' });
    const inner = await createFolder(db(), ids, clock, { parentId: outer.id, name: 'inner' });

    await expect(moveNode(db(), outer.id, { parentId: inner.id })).rejects.toThrow(/inside itself/);
  });

  it('places a moved node among its new siblings at the position asked for', async () => {
    const folder = await createFolder(db(), ids, clock, { parentId: null, name: 'folder' });
    await discoverNodes(db(), ids, clock, [
      { ref: ref('s1'), title: 'one' },
      { ref: ref('s2'), title: 'two' },
    ]);
    for (const sessionId of ['s1', 's2']) {
      const node = await findNodeForSession(db(), ref(sessionId));
      if (node === null) throw new Error(`the node for ${sessionId} is missing`);
      await moveNode(db(), node.id, { parentId: folder.id });
    }

    const third = await createFolder(db(), ids, clock, { parentId: null, name: 'third' });
    await moveNode(db(), third.id, { parentId: folder.id, position: 0 });

    const layout = await readLayout(db());
    const inFolder = layout.filter((node) => node.parentId === folder.id);
    expect(inFolder.map((node) => node.name)).toEqual(['third', 'one', 'two']);
    expect(inFolder.map((node) => node.position)).toEqual([0, 1, 2]);
  });

  it('clamps a position past the end rather than refusing a client one frame behind', async () => {
    const folder = await createFolder(db(), ids, clock, { parentId: null, name: 'folder' });
    const moving = await createFolder(db(), ids, clock, { parentId: null, name: 'moving' });

    const moved = await moveNode(db(), moving.id, { parentId: folder.id, position: 99 });

    expect(moved?.parentId).toBe(folder.id);
    expect(moved?.position).toBe(0);
  });

  it('closes the gap a departure left, so positions stay dense', async () => {
    await discoverNodes(db(), ids, clock, [
      { ref: ref('s1'), title: 'one' },
      { ref: ref('s2'), title: 'two' },
      { ref: ref('s3'), title: 'three' },
    ]);
    const folder = await createFolder(db(), ids, clock, { parentId: null, name: 'folder' });
    const middle = await findNodeForSession(db(), ref('s2'));
    if (middle === null) throw new Error('the node for s2 is missing');

    await moveNode(db(), middle.id, { parentId: folder.id });

    const roots = (await listNodes(db())).filter((node) => node.parentId === null);
    expect(roots.map((node) => node.position).sort()).toEqual([0, 1, 2]);
  });

  it('answers null when asked to move a node that is not there', async () => {
    expect(await moveNode(db(), ABSENT, { parentId: null })).toBeNull();
  });

  it('answers null when asked to rename a node that is not there', async () => {
    expect(await renameNode(db(), ABSENT, 'a name')).toBeNull();
  });

  it('reports no node and remembers nothing when removing one that is not there', async () => {
    const removed = await removeNode(db(), clock, ABSENT);

    expect(removed).toEqual({ node: null, remembered: [] });
    expect(await listRemovals(db())).toEqual([]);
  });

  /** The cascade, which is why removing a folder is one statement and not a walk. */
  it('takes the subtree with a removed folder', async () => {
    const outer = await createFolder(db(), ids, clock, { parentId: null, name: 'outer' });
    const inner = await createFolder(db(), ids, clock, { parentId: outer.id, name: 'inner' });

    await removeNode(db(), clock, outer.id);

    expect(await findNode(db(), inner.id)).toBeNull();
    expect(await listNodes(db())).toEqual([]);
  });

  it('remembers a session nested two folders deep when the outer one is removed', async () => {
    const outer = await createFolder(db(), ids, clock, { parentId: null, name: 'outer' });
    const inner = await createFolder(db(), ids, clock, { parentId: outer.id, name: 'inner' });
    await discoverNodes(db(), ids, clock, [{ ref: ref('s1'), title: 'one' }]);
    const session = await findNodeForSession(db(), ref('s1'));
    if (session === null) throw new Error('the node discovery just created is missing');
    await moveNode(db(), session.id, { parentId: inner.id });

    const removed = await removeNode(db(), clock, outer.id);

    expect(removed.remembered).toEqual([ref('s1')]);
  });

  it('refuses a second node for the same session', async () => {
    await discoverNodes(db(), ids, clock, [{ ref: ref('s1'), title: 'one' }]);

    await expect(
      db().query(
        `INSERT INTO nodes (id, kind, position, anchor_store_id, anchor_session_id, created_at)
         VALUES ('duplicate', 'session', 9, ?, ?, 1)`,
        [STORE, 's1'],
      ),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it('allows any number of folders, which anchor nothing', async () => {
    for (const name of ['one', 'two', 'three']) {
      await createFolder(db(), ids, clock, { parentId: null, name });
    }

    expect(await listNodes(db())).toHaveLength(3);
  });

  it('forgets nothing when asked to forget a removal that was never remembered', async () => {
    expect(await forgetRemoval(db(), ref('never-removed'))).toBe(false);
  });

  it('stamps a removal with the injected clock, in epoch milliseconds', async () => {
    await discoverNodes(db(), ids, clock, [{ ref: ref('s1'), title: 'one' }]);
    const node = await findNodeForSession(db(), ref('s1'));
    if (node === null) throw new Error('the node discovery just created is missing');

    await removeNode(db(), clock, node.id);

    expect(await listRemovals(db())).toEqual([{ ref: ref('s1'), removedAt: NOW }]);
  });

  it('publishes the tree parents-first, with only what a client needs', async () => {
    const folder = await createFolder(db(), ids, clock, { parentId: null, name: 'folder' });
    await discoverNodes(db(), ids, clock, [{ ref: ref('s1'), title: 'one' }]);
    const session = await findNodeForSession(db(), ref('s1'));
    if (session === null) throw new Error('the node discovery just created is missing');
    await moveNode(db(), session.id, { parentId: folder.id });

    const layout = await readLayout(db());

    expect(layout).toEqual([
      {
        id: folder.id,
        parentId: null,
        kind: 'folder',
        position: 0,
        name: 'folder',
        named: true,
        anchor: null,
      },
      {
        id: session.id,
        parentId: folder.id,
        kind: 'session',
        position: 0,
        name: 'one',
        named: false,
        anchor: ref('s1'),
      },
    ]);
  });
});
