import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  sessionIdSchema,
  storeIdSchema,
  type SessionId,
  type SessionRef,
} from '@agentplex/protocol';
import type { Database } from '../db/database.js';
import { openMigratedSchema, type MigratedSchema } from '../pairing/test-migrated-schema.js';
import { discoverNodes } from './node-discovery.js';
import { pruneNodes } from './node-prune.js';
import {
  createFolder,
  findNodeForSession,
  listNodes,
  listRemovals,
  moveNode,
  removeNode,
} from './node-tree.js';

/**
 * The prune sweep, and the one thing it must never do.
 *
 * A node points at a session no foreign key can check, so something has to
 * notice when the session goes away. The danger is that "I cannot see it" and
 * "it is not there" look identical from the hub, and acting on the first would
 * mean a user's tree quietly dismantling itself while their laptop is shut.
 *
 * So the suite is arranged around the distinction: what a scan reached is
 * evidence, what it did not reach is not, and the case where it reached nothing
 * at all is the one the ticket names.
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

const STORE_A = storeIdSchema.parse('store-a');
const STORE_B = storeIdSchema.parse('store-b');

function session(id: string): SessionId {
  return sessionIdSchema.parse(id);
}

function ref(storeId: typeof STORE_A, sessionId: string): SessionRef {
  return { storeId, sessionId: session(sessionId) };
}

/** Two stores with two sessions each, all four placed in the tree. */
async function twoStoresOfTwo(): Promise<void> {
  await discoverNodes(db(), ids, clock, [
    { ref: ref(STORE_A, 'a1'), title: 'a one' },
    { ref: ref(STORE_A, 'a2'), title: 'a two' },
    { ref: ref(STORE_B, 'b1'), title: 'b one' },
    { ref: ref(STORE_B, 'b2'), title: 'b two' },
  ]);
}

describe('pruning the node tree', () => {
  beforeAll(async () => {
    migrated = await openMigratedSchema('layout-prune-probe');
  });

  afterAll(async () => {
    await migrated?.close();
  });

  beforeEach(async () => {
    await db().query('DELETE FROM nodes');
    await db().query('DELETE FROM node_removals');
    minted = 0;
  });

  /**
   * The ticket's headline safeguard. Every server unreachable is exactly the
   * shape of a scan that reached nothing, and it must cost the user nothing.
   */
  it('prunes nothing at all on an empty scan', async () => {
    await twoStoresOfTwo();
    const before = await listNodes(db());

    const outcome = await pruneNodes(db(), []);

    expect(outcome).toEqual({ pruned: [], forgotten: [] });
    expect(await listNodes(db())).toEqual(before);
  });

  /**
   * The same rule one store at a time: store B being unreachable is not a
   * statement about store B's sessions, even while store A is reporting
   * normally.
   */
  it('leaves the nodes of a store the scan did not reach', async () => {
    await twoStoresOfTwo();

    // A reached store A entirely, and reported both its sessions. Nothing was
    // heard from store B at all, so it is simply not in the scan.
    const outcome = await pruneNodes(db(), [
      { storeId: STORE_A, sessions: [session('a1'), session('a2')] },
    ]);

    expect(outcome.pruned).toEqual([]);
    expect(await findNodeForSession(db(), ref(STORE_B, 'b1'))).not.toBeNull();
    expect(await findNodeForSession(db(), ref(STORE_B, 'b2'))).not.toBeNull();
  });

  it('removes the node of a session a reached store no longer has', async () => {
    await twoStoresOfTwo();

    const outcome = await pruneNodes(db(), [{ storeId: STORE_A, sessions: [session('a1')] }]);

    expect(outcome.pruned).toEqual([ref(STORE_A, 'a2')]);
    expect(await findNodeForSession(db(), ref(STORE_A, 'a2'))).toBeNull();
    expect(await findNodeForSession(db(), ref(STORE_A, 'a1'))).not.toBeNull();
  });

  /**
   * A store that was reached and holds nothing is evidence, unlike a store that
   * was not reached. This is the distinction the `StoreScan` type exists to
   * make it possible for a caller to express.
   */
  it('empties a store that was reached and reported no sessions', async () => {
    await twoStoresOfTwo();

    const outcome = await pruneNodes(db(), [{ storeId: STORE_A, sessions: [] }]);

    expect(outcome.pruned).toEqual(
      expect.arrayContaining([ref(STORE_A, 'a1'), ref(STORE_A, 'a2')]),
    );
    expect(await findNodeForSession(db(), ref(STORE_B, 'b1'))).not.toBeNull();
  });

  /**
   * A prune is not a removal. Recording one would mean an outage permanently
   * suppressing every session of a store that later came back.
   */
  it('remembers nothing about what it pruned, unlike a removal', async () => {
    await twoStoresOfTwo();

    await pruneNodes(db(), [{ storeId: STORE_A, sessions: [] }]);

    expect(await listRemovals(db())).toEqual([]);

    // And the proof that it is not remembered: the store comes back with the
    // session still in it, and the node returns.
    const outcome = await discoverNodes(db(), ids, clock, [
      { ref: ref(STORE_A, 'a1'), title: 'a one' },
    ]);
    expect(outcome.created).toHaveLength(1);
  });

  it('leaves the user folders standing even when everything in them goes', async () => {
    await twoStoresOfTwo();
    const folder = await createFolder(db(), ids, clock, { parentId: null, name: 'store a' });
    for (const sessionId of ['a1', 'a2']) {
      const node = await findNodeForSession(db(), ref(STORE_A, sessionId));
      if (node === null) throw new Error(`the node for ${sessionId} is missing`);
      await moveNode(db(), node.id, { parentId: folder.id });
    }

    await pruneNodes(db(), [{ storeId: STORE_A, sessions: [] }]);

    const remaining = await listNodes(db());
    expect(remaining.map((node) => node.id)).toContain(folder.id);
  });

  /**
   * A removal outlives the node it is about, but not the session. Once the
   * session is gone there is nothing left for the memory to suppress, and a row
   * that can never be consulted again would accumulate forever.
   */
  it('forgets a remembered removal once its session is gone from a reached store', async () => {
    await twoStoresOfTwo();
    const node = await findNodeForSession(db(), ref(STORE_A, 'a1'));
    if (node === null) throw new Error('the node for a1 is missing');
    await removeNode(db(), clock, node.id);
    expect(await listRemovals(db())).toHaveLength(1);

    const outcome = await pruneNodes(db(), [{ storeId: STORE_A, sessions: [session('a2')] }]);

    expect(outcome.forgotten).toEqual([ref(STORE_A, 'a1')]);
    expect(await listRemovals(db())).toEqual([]);
  });

  it('keeps a remembered removal while its session is still there', async () => {
    await twoStoresOfTwo();
    const node = await findNodeForSession(db(), ref(STORE_A, 'a1'));
    if (node === null) throw new Error('the node for a1 is missing');
    await removeNode(db(), clock, node.id);

    const outcome = await pruneNodes(db(), [
      { storeId: STORE_A, sessions: [session('a1'), session('a2')] },
    ]);

    expect(outcome.forgotten).toEqual([]);
    expect(await listRemovals(db())).toHaveLength(1);
  });

  it('keeps a remembered removal for a store the scan did not reach', async () => {
    await twoStoresOfTwo();
    const node = await findNodeForSession(db(), ref(STORE_B, 'b1'));
    if (node === null) throw new Error('the node for b1 is missing');
    await removeNode(db(), clock, node.id);

    await pruneNodes(db(), [{ storeId: STORE_A, sessions: [session('a1'), session('a2')] }]);

    expect(await listRemovals(db())).toHaveLength(1);
  });

  it('changes nothing when every reached store still holds everything', async () => {
    await twoStoresOfTwo();
    const before = await listNodes(db());

    const outcome = await pruneNodes(db(), [
      { storeId: STORE_A, sessions: [session('a1'), session('a2')] },
      { storeId: STORE_B, sessions: [session('b1'), session('b2')] },
    ]);

    expect(outcome).toEqual({ pruned: [], forgotten: [] });
    expect(await listNodes(db())).toEqual(before);
  });
});
