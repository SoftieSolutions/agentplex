import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sessionIdSchema, storeIdSchema, type SessionRef } from '@agentplex/protocol';
import type { Database } from '../db/database.js';
import { openMigratedSchema, type MigratedSchema } from '../pairing/test-migrated-schema.js';
import { discoverNodes } from './node-discovery.js';
import {
  createFolder,
  findNodeForSession,
  listNodes,
  listRemovals,
  moveNode,
  removeNode,
  renameNode,
  forgetRemoval,
} from './node-tree.js';

/**
 * Discovery against a real database, and the four things it must not do.
 *
 * Every assertion here is a version of the same rule: a background scan may not
 * undo an edit the user made. The user removed something, moved something, or
 * named something, and a scan a few seconds later must leave all three alone.
 * These are the failures that would be invisible in review and obvious --
 * infuriating -- in use.
 */

let migrated: MigratedSchema | null = null;

const NOW = 1_756_000_000_000;
const clock = { now: () => NOW };

/** Counted rather than random, so a failure names the node it is about. */
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

describe('discovery and the node tree', () => {
  beforeAll(async () => {
    migrated = await openMigratedSchema('layout-discovery-probe');
  });

  afterAll(async () => {
    await migrated?.close();
  });

  beforeEach(async () => {
    await db().query('DELETE FROM nodes');
    await db().query('DELETE FROM node_removals');
    minted = 0;
  });

  it('places a newly discovered session at the root, named by its title', async () => {
    const outcome = await discoverNodes(db(), ids, clock, [
      { ref: ref('s1'), title: 'fixing the parser' },
    ]);

    expect(outcome.created).toHaveLength(1);
    expect(outcome.suppressed).toEqual([]);
    const node = outcome.created[0];
    expect(node?.parentId).toBeNull();
    expect(node?.name).toBe('fixing the parser');
    expect(node?.named).toBe(false);
    expect(node?.anchor).toEqual(ref('s1'));
  });

  it('places each session once, however often it is discovered', async () => {
    await discoverNodes(db(), ids, clock, [{ ref: ref('s1'), title: 'one' }]);
    const second = await discoverNodes(db(), ids, clock, [{ ref: ref('s1'), title: 'one' }]);

    expect(second.created).toEqual([]);
    expect(await listNodes(db())).toHaveLength(1);
  });

  it('appends discovered sessions after each other rather than stacking them at 0', async () => {
    await discoverNodes(db(), ids, clock, [
      { ref: ref('s1'), title: 'one' },
      { ref: ref('s2'), title: 'two' },
      { ref: ref('s3'), title: 'three' },
    ]);

    const positions = (await listNodes(db())).map((node) => node.position).sort();
    expect(positions).toEqual([0, 1, 2]);
  });

  it('follows the transcript title while nobody has renamed the node', async () => {
    await discoverNodes(db(), ids, clock, [{ ref: ref('s1'), title: 'first guess' }]);

    const outcome = await discoverNodes(db(), ids, clock, [
      { ref: ref('s1'), title: 'what it turned out to be' },
    ]);

    expect(outcome.retitled).toHaveLength(1);
    const node = await findNodeForSession(db(), ref('s1'));
    expect(node?.name).toBe('what it turned out to be');
    expect(node?.named).toBe(false);
  });

  it('lets a node with no title stay nameless rather than inventing one', async () => {
    await discoverNodes(db(), ids, clock, [{ ref: ref('s1'), title: null }]);

    const node = await findNodeForSession(db(), ref('s1'));
    expect(node?.name).toBeNull();
  });

  /** The rename wins permanently. This is the one that would be maddening. */
  it('never renames a node the user named, however the title changes', async () => {
    await discoverNodes(db(), ids, clock, [{ ref: ref('s1'), title: 'first guess' }]);
    const node = await findNodeForSession(db(), ref('s1'));
    if (node === null) throw new Error('the node discovery just created is missing');
    await renameNode(db(), node.id, 'the payments bug');

    const outcome = await discoverNodes(db(), ids, clock, [
      { ref: ref('s1'), title: 'a completely different title' },
    ]);

    expect(outcome.retitled).toEqual([]);
    const after = await findNodeForSession(db(), ref('s1'));
    expect(after?.name).toBe('the payments bug');
    expect(after?.named).toBe(true);
  });

  /** And it stays won across many scans, not just the next one. */
  it('keeps the rename through repeated scans', async () => {
    await discoverNodes(db(), ids, clock, [{ ref: ref('s1'), title: 'first' }]);
    const node = await findNodeForSession(db(), ref('s1'));
    if (node === null) throw new Error('the node discovery just created is missing');
    await renameNode(db(), node.id, 'mine');

    for (const title of ['second', 'third', 'fourth']) {
      await discoverNodes(db(), ids, clock, [{ ref: ref('s1'), title }]);
    }

    expect((await findNodeForSession(db(), ref('s1')))?.name).toBe('mine');
  });

  it('never moves a node the user placed', async () => {
    await discoverNodes(db(), ids, clock, [{ ref: ref('s1'), title: 'one' }]);
    const folder = await createFolder(db(), ids, clock, { parentId: null, name: 'this week' });
    const node = await findNodeForSession(db(), ref('s1'));
    if (node === null) throw new Error('the node discovery just created is missing');
    await moveNode(db(), node.id, { parentId: folder.id });

    await discoverNodes(db(), ids, clock, [{ ref: ref('s1'), title: 'one' }]);

    expect((await findNodeForSession(db(), ref('s1')))?.parentId).toBe(folder.id);
  });

  it('leaves a user-placed node where it is even while following its title', async () => {
    await discoverNodes(db(), ids, clock, [{ ref: ref('s1'), title: 'one' }]);
    const folder = await createFolder(db(), ids, clock, { parentId: null, name: 'this week' });
    const node = await findNodeForSession(db(), ref('s1'));
    if (node === null) throw new Error('the node discovery just created is missing');
    await moveNode(db(), node.id, { parentId: folder.id });

    await discoverNodes(db(), ids, clock, [{ ref: ref('s1'), title: 'retitled' }]);

    const after = await findNodeForSession(db(), ref('s1'));
    expect(after?.name).toBe('retitled');
    expect(after?.parentId).toBe(folder.id);
  });

  /**
   * The ticket's "no third state", exercised: the session is still on disk and
   * still discovered on every scan, and it stays gone because the removal is
   * remembered.
   */
  it('does not restore a removed session, because the removal is remembered', async () => {
    await discoverNodes(db(), ids, clock, [{ ref: ref('s1'), title: 'one' }]);
    const node = await findNodeForSession(db(), ref('s1'));
    if (node === null) throw new Error('the node discovery just created is missing');
    const removed = await removeNode(db(), clock, node.id);
    expect(removed.remembered).toEqual([ref('s1')]);

    const outcome = await discoverNodes(db(), ids, clock, [{ ref: ref('s1'), title: 'one' }]);

    expect(outcome.created).toEqual([]);
    expect(outcome.suppressed).toEqual([ref('s1')]);
    expect(await findNodeForSession(db(), ref('s1'))).toBeNull();
  });

  it('keeps it removed over many scans, not merely the next one', async () => {
    await discoverNodes(db(), ids, clock, [{ ref: ref('s1'), title: 'one' }]);
    const node = await findNodeForSession(db(), ref('s1'));
    if (node === null) throw new Error('the node discovery just created is missing');
    await removeNode(db(), clock, node.id);

    for (let scan = 0; scan < 5; scan += 1) {
      await discoverNodes(db(), ids, clock, [{ ref: ref('s1'), title: 'one' }]);
    }

    expect(await listNodes(db())).toEqual([]);
    expect(await listRemovals(db())).toHaveLength(1);
  });

  it('places the session again once the removal is forgotten', async () => {
    await discoverNodes(db(), ids, clock, [{ ref: ref('s1'), title: 'one' }]);
    const node = await findNodeForSession(db(), ref('s1'));
    if (node === null) throw new Error('the node discovery just created is missing');
    await removeNode(db(), clock, node.id);

    expect(await forgetRemoval(db(), ref('s1'))).toBe(true);
    const outcome = await discoverNodes(db(), ids, clock, [{ ref: ref('s1'), title: 'one' }]);

    expect(outcome.created).toHaveLength(1);
    expect(await findNodeForSession(db(), ref('s1'))).not.toBeNull();
  });

  /**
   * Removing a folder remembers what was inside it. Without this the cascade
   * would delete the children and the next scan would put every one of them
   * back at the root: the user's folder gone and their removal undone, which is
   * a worse outcome than the removal simply not working.
   */
  it('remembers the sessions inside a removed folder, not just the folder', async () => {
    await discoverNodes(db(), ids, clock, [
      { ref: ref('s1'), title: 'one' },
      { ref: ref('s2'), title: 'two' },
    ]);
    const folder = await createFolder(db(), ids, clock, { parentId: null, name: 'done' });
    for (const sessionId of ['s1', 's2']) {
      const node = await findNodeForSession(db(), ref(sessionId));
      if (node === null) throw new Error(`the node for ${sessionId} is missing`);
      await moveNode(db(), node.id, { parentId: folder.id });
    }

    const removed = await removeNode(db(), clock, folder.id);
    expect(removed.remembered).toEqual(expect.arrayContaining([ref('s1'), ref('s2')]));

    const outcome = await discoverNodes(db(), ids, clock, [
      { ref: ref('s1'), title: 'one' },
      { ref: ref('s2'), title: 'two' },
    ]);

    expect(outcome.created).toEqual([]);
    expect(await listNodes(db())).toEqual([]);
  });

  it('reports nothing and writes nothing when a scan found no sessions', async () => {
    const outcome = await discoverNodes(db(), ids, clock, []);

    expect(outcome).toEqual({ created: [], retitled: [], suppressed: [] });
    expect(await listNodes(db())).toEqual([]);
  });

  /**
   * A session id is unique only within its store, so two stores may each hold
   * one called `s1`. They are two sessions and must be two nodes.
   */
  it('treats the same session id in two stores as two sessions', async () => {
    const other = storeIdSchema.parse('store-b');
    await discoverNodes(db(), ids, clock, [
      { ref: ref('s1'), title: 'in a' },
      { ref: { storeId: other, sessionId: sessionIdSchema.parse('s1') }, title: 'in b' },
    ]);

    expect(await listNodes(db())).toHaveLength(2);
  });
});
