import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  HOME_PROJECT_ID,
  nodeIdSchema,
  sessionIdSchema,
  storeIdSchema,
  type NodeId,
  type SessionDescriptor,
  type SessionHolder,
  type SessionRef,
  type StoreId,
} from '@agentplex/protocol';
import { createLogger } from '@agentplex/node-shared';
import { openMigratedSchema, type MigratedSchema } from '../db/test-migrated-schema.js';
import { createCatalogue, type Catalogue } from './catalogue.js';
import { findNode, findNodeForSession, listRemovals } from './reads.js';

/**
 * The five edits a client may make to the tree, against a real database.
 *
 * Every refusal here is a sentence somebody reads, which is the whole reason
 * this layer exists on top of `writes.ts`: the writes throw at a caller with a
 * bug, and a person who dropped a folder onto a session card does not have a
 * bug. So each case below asserts the refusal and then asserts that the tree
 * did not move, because a refusal that half-applied would be worse than either.
 *
 * The live-holder refusal is the one that reaches outside the tree. It is
 * driven here by a map standing in for the reducer and end to end over the real
 * protocol in `tests/hub-server/catalogue-mutations.integration.test.ts`.
 */

let migrated: MigratedSchema | null = null;

const NOW = 1_756_000_000_000;
const clock = { now: () => NOW };
const logger = createLogger('error', () => {});

const STORE = storeIdSchema.parse('store-a');
const OTHER_STORE = storeIdSchema.parse('store-b');

let minted = 0;
const ids = { newId: () => `node-${String((minted += 1))}` };

/** What each store currently reads as, so a pass can be driven by hand. */
const stores = new Map<StoreId, readonly SessionDescriptor[] | null>();
/** Who is running what, standing in for the reducer's merge. */
const holders = new Map<string, SessionHolder>();
/** Which directory is which project, standing in for the projects feature. */
const projectDirectories = new Map<string, NodeId>();

function database() {
  if (migrated === null) throw new Error('no database: beforeAll did not run');
  return migrated.database;
}

function catalogue(): Catalogue {
  return createCatalogue({
    database: database(),
    ids,
    clock,
    logger,
    readStore: (storeId) => stores.get(storeId) ?? null,
    projects: {
      findByDirectories: async (directories) =>
        new Map(
          directories.flatMap((directory) => {
            const project = projectDirectories.get(directory);
            return project === undefined ? [] : [[directory, project] as const];
          }),
        ),
      directories: async () => new Map(),
    },
    readFleet: () => ({
      version: 0,
      stores: [],
      servers: [],
      candidates: [],
      graphRunApprovals: [],
    }),
    readHolder: (ref) => holders.get(ref.sessionId) ?? null,
  });
}

function ref(sessionId: string, storeId: StoreId = STORE): SessionRef {
  return { storeId, sessionId: sessionIdSchema.parse(sessionId) };
}

function descriptor(sessionId: string, cwd: string | null = null): SessionDescriptor {
  return {
    storeId: STORE,
    sessionId: sessionIdSchema.parse(sessionId),
    provider: 'claude',
    status: 'idle',
    process: 'none',
    updatedAt: NOW,
    cwd,
    branch: null,
    title: sessionId,
    uncommitted: null,
  };
}

/** Runs one discovery pass over a store that reads as these sessions. */
async function scan(
  tree: Catalogue,
  sessions: readonly SessionDescriptor[],
  storeId: StoreId = STORE,
): Promise<void> {
  stores.set(storeId, sessions);
  await tree.observe(storeId);
}

/** The node one session was placed at, or a failure that says it was not. */
async function nodeFor(sessionId: string): Promise<NodeId> {
  const node = await findNodeForSession(database(), ref(sessionId));
  if (node === null) throw new Error(`no node was placed for ${sessionId}`);
  return node.id;
}

/** A project, inserted the way the projects feature inserts one. */
async function makeProject(nodeId: string, name: string, directory: string): Promise<NodeId> {
  const id = nodeIdSchema.parse(nodeId);
  await database().query(
    `INSERT INTO nodes (id, parent_id, kind, position, name, name_source, created_at)
     SELECT ?, NULL, 'project', coalesce(max(position), -1) + 1, ?, 'user', ?
       FROM nodes WHERE parent_id IS NULL`,
    [id, name, NOW],
  );
  await database().query('INSERT INTO projects (node_id, directory, created_at) VALUES (?, ?, ?)', [
    id,
    directory,
    NOW,
  ]);
  projectDirectories.set(directory, id);
  return id;
}

/** The ids in a layout, in the order it lists them. */
function idsIn(layout: readonly { readonly id: NodeId }[]): readonly NodeId[] {
  return layout.map((node) => node.id);
}

/** A folder made through the mutations, or a failure that says it was not. */
async function folderIn(tree: Catalogue, parentId: NodeId, name: string): Promise<NodeId> {
  const made = await tree.createFolder({ parentId, name });
  if (!made.ok) throw new Error(`the folder ${name} should have been made: ${made.problem}`);
  return made.nodeId;
}

/**
 * A node of a kind the mutations never create, written the way its own feature
 * writes one. Docs and graphs are only ever made under a project, which is the
 * one place this puts them.
 */
async function insertNode(
  nodeId: string,
  kind: 'doc' | 'graph',
  parentId: NodeId,
): Promise<NodeId> {
  const id = nodeIdSchema.parse(nodeId);
  await database().query(
    `INSERT INTO nodes (id, parent_id, kind, position, name, name_source, created_at)
     VALUES (?, ?, ?, 0, ?, 'user', ?)`,
    [id, parentId, kind, nodeId, NOW],
  );
  return id;
}

/** Every node's place, so a refusal can be shown to have changed nothing. */
async function treeShape(): Promise<unknown> {
  return (await database().query('SELECT id, parent_id, position FROM nodes ORDER BY id')).rows;
}

/** An id no node has, for every "not there" answer below. */
const ABSENT: NodeId = nodeIdSchema.parse('no-such-node');

beforeAll(async () => {
  migrated = await openMigratedSchema('tree-mutations-probe');
});

afterAll(async () => {
  await migrated?.close();
});

/**
 * HOME survives the reset rather than being deleted and seeded again: what every
 * case here runs against is then the tree migration 0020 actually left, and
 * there is no second copy of its INSERT in this file to drift from the one in
 * the migration.
 */
beforeEach(async () => {
  await database().query('DELETE FROM nodes WHERE id <> ?', [HOME_PROJECT_ID]);
  await database().query('DELETE FROM node_removals');
  await database().query('DELETE FROM projects');
  stores.clear();
  holders.clear();
  projectDirectories.clear();
  minted = 0;
});

describe('making a folder', () => {
  it('makes one inside a project, named by the user from the first millisecond', async () => {
    const tree = catalogue();
    const project = await makeProject('node-project', 'agentplex', '/srv/agentplex');

    const made = await tree.createFolder({ parentId: project, name: '  this week  ' });

    if (!made.ok) throw new Error(`the folder should have been made: ${made.problem}`);
    const node = await findNode(database(), made.nodeId);
    // Trimmed here and not by the client, so that two clients cannot store two
    // spellings of one intent.
    expect(node?.name).toBe('this week');
    expect(node?.named).toBe(true);
    expect(node?.parentId).toBe(project);
  });

  it('makes one inside a folder that is inside a project', async () => {
    const tree = catalogue();
    const project = await makeProject('node-project', 'agentplex', '/srv/agentplex');
    const outer = await folderIn(tree, project, 'this week');

    const made = await tree.createFolder({ parentId: outer, name: 'monday' });

    if (!made.ok) throw new Error(`the folder should have been made: ${made.problem}`);
    expect((await findNode(database(), made.nodeId))?.parentId).toBe(outer);
  });

  it('refuses one at the root, in words, and makes nothing', async () => {
    const tree = catalogue();
    await makeProject('node-project', 'agentplex', '/srv/agentplex');
    const before = await treeShape();

    const made = await tree.createFolder({ parentId: null, name: 'this week' });

    expect(made).toEqual({
      ok: false,
      code: 'refused',
      problem: 'only projects sit at the top level; make the folder inside a project, or in HOME',
      holder: null,
    });
    expect(await treeShape()).toEqual(before);
  });

  it('refuses a name that is nothing but spaces, in words rather than by throwing', async () => {
    const made = await catalogue().createFolder({ parentId: HOME_PROJECT_ID, name: '   ' });

    expect(made).toEqual({
      ok: false,
      code: 'refused',
      problem: 'a folder needs a name',
      holder: null,
    });
  });

  it('refuses a parent this hub does not have', async () => {
    const made = await catalogue().createFolder({ parentId: ABSENT, name: 'anywhere' });

    expect(made).toMatchObject({ ok: false, code: 'refused' });
    expect(await database().query('SELECT id FROM nodes')).toMatchObject({
      rows: [{ id: HOME_PROJECT_ID }],
    });
  });

  it('refuses a parent of a kind that holds no children', async () => {
    const tree = catalogue();
    await scan(tree, [descriptor('session-one')]);

    const made = await tree.createFolder({ parentId: await nodeFor('session-one'), name: 'in it' });

    expect(made).toMatchObject({ ok: false, code: 'refused' });
    if (made.ok) throw new Error('a session holds no children');
    expect(made.problem).toContain('holds no children');
  });
});

describe('renaming a node', () => {
  it('names it, and takes it out of discovery for good', async () => {
    const tree = catalogue();
    await scan(tree, [descriptor('session-one')]);
    const nodeId = await nodeFor('session-one');

    const renamed = await tree.rename(nodeId, 'the auth refresh one');

    expect(renamed).toEqual({ ok: true });
    expect((await findNode(database(), nodeId))?.named).toBe(true);

    // The same store reads the same way a moment later. The title would have
    // been written again; the user's name is what stands.
    await scan(tree, [{ ...descriptor('session-one'), title: 'something the provider decided' }]);
    expect((await findNode(database(), nodeId))?.name).toBe('the auth refresh one');
  });

  it('refuses a blank name and leaves the old one alone', async () => {
    const tree = catalogue();
    const folder = await folderIn(tree, HOME_PROJECT_ID, 'this week');

    expect(await tree.rename(folder, ' ')).toMatchObject({ ok: false, code: 'refused' });
    expect((await findNode(database(), folder))?.name).toBe('this week');
  });

  it('refuses a node this hub does not have', async () => {
    expect(await catalogue().rename(ABSENT, 'anything')).toMatchObject({
      ok: false,
      code: 'refused',
      holder: null,
    });
  });
});

describe('moving a node', () => {
  it('puts it where it was asked to go, among the siblings it will have', async () => {
    const tree = catalogue();
    const folder = await folderIn(tree, HOME_PROJECT_ID, 'this week');
    await scan(tree, [descriptor('session-one'), descriptor('session-two')]);

    expect(await tree.move(await nodeFor('session-one'), { parentId: folder, position: 0 }));
    const moved = await tree.move(await nodeFor('session-two'), {
      parentId: folder,
      position: 0,
    });

    expect(moved).toEqual({ ok: true });
    const layout = await tree.readLayout();
    expect(layout.filter((node) => node.parentId === folder).map((node) => node.name)).toEqual([
      'session-two',
      'session-one',
    ]);
  });

  it('refuses a move that would put a node inside its own subtree', async () => {
    const tree = catalogue();
    const outer = await folderIn(tree, HOME_PROJECT_ID, 'outer');
    const inner = await folderIn(tree, outer, 'inner');

    const moved = await tree.move(outer, { parentId: inner, position: 0 });

    expect(moved).toMatchObject({ ok: false, code: 'refused' });
    if (moved.ok) throw new Error('a node cannot hold its own ancestor');
    expect(moved.problem).toContain('inside itself');
    expect((await findNode(database(), outer))?.parentId).toBe(HOME_PROJECT_ID);
  });

  it('refuses a parent of a kind that holds no children', async () => {
    const tree = catalogue();
    await scan(tree, [descriptor('session-one'), descriptor('session-two')]);
    const one = await nodeFor('session-one');

    const moved = await tree.move(one, { parentId: await nodeFor('session-two'), position: 0 });

    expect(moved).toMatchObject({ ok: false, code: 'refused' });
    expect((await findNode(database(), one))?.parentId).toBe(HOME_PROJECT_ID);
  });

  it('moves a session and a folder from one project to another, and into HOME', async () => {
    const tree = catalogue();
    const agentplex = await makeProject('node-agentplex', 'agentplex', '/srv/agentplex');
    const docs = await makeProject('node-docs', 'the docs', '/srv/docs');
    await scan(tree, [descriptor('session-one', '/srv/agentplex')]);
    const session = await nodeFor('session-one');
    const folder = await folderIn(tree, agentplex, 'archive');

    expect(await tree.move(session, { parentId: docs, position: 0 })).toEqual({ ok: true });
    expect(await tree.move(folder, { parentId: docs, position: 0 })).toEqual({ ok: true });
    expect((await findNode(database(), session))?.parentId).toBe(docs);
    expect((await findNode(database(), folder))?.parentId).toBe(docs);

    expect(await tree.move(session, { parentId: HOME_PROJECT_ID, position: 0 })).toEqual({
      ok: true,
    });
    expect(await tree.move(folder, { parentId: HOME_PROJECT_ID, position: 0 })).toEqual({
      ok: true,
    });
    expect((await findNode(database(), session))?.parentId).toBe(HOME_PROJECT_ID);
    expect((await findNode(database(), folder))?.parentId).toBe(HOME_PROJECT_ID);
  });

  it('refuses a node this hub does not have', async () => {
    expect(await catalogue().move(ABSENT, { parentId: null, position: 0 })).toMatchObject({
      ok: false,
      code: 'refused',
    });
  });
});

/**
 * The root holds projects, and a project is held by nothing.
 *
 * Two rules and one shape: every node that is not a project lives inside one,
 * and every project lives at the top. Each case asserts the sentence and then
 * that the tree did not move, because a refusal that half-applied would be a
 * node in a place the rules say it cannot be.
 */
describe('the top level', () => {
  const NOT_AT_ROOT = 'only projects sit at the top level; move it into a project, or into HOME';
  const NOT_BELOW = 'a project sits at the top level and never inside another node';

  /** One of each kind the mutations can be asked to move, all inside a project. */
  async function oneOfEach(tree: Catalogue): Promise<Record<string, NodeId>> {
    const project = await makeProject('node-project', 'agentplex', '/srv/agentplex');
    await scan(tree, [descriptor('session-one', '/srv/agentplex')]);
    return {
      session: await nodeFor('session-one'),
      folder: await folderIn(tree, project, 'archive'),
      doc: await insertNode('node-doc', 'doc', project),
      graph: await insertNode('node-graph', 'graph', project),
    };
  }

  it.each(['session', 'folder', 'doc', 'graph'])(
    'refuses a %s moved to the top level, and leaves it where it was',
    async (kind) => {
      const tree = catalogue();
      const nodes = await oneOfEach(tree);
      const nodeId = nodes[kind];
      if (nodeId === undefined) throw new Error(`no ${kind} was made`);
      const before = await treeShape();

      expect(await tree.move(nodeId, { parentId: null, position: 1 })).toEqual({
        ok: false,
        code: 'refused',
        problem: NOT_AT_ROOT,
        holder: null,
      });
      expect(await treeShape()).toEqual(before);
    },
  );

  it.each([
    ['a folder', 'folder'],
    ['another project', 'project'],
    ['HOME', 'home'],
  ] as const)('refuses a project moved into %s, and leaves it at the top', async (_, target) => {
    const tree = catalogue();
    const project = await makeProject('node-project', 'agentplex', '/srv/agentplex');
    const other = await makeProject('node-other', 'the docs', '/srv/docs');
    const folder = await folderIn(tree, other, 'archive');
    const parentId = { folder, project: other, home: HOME_PROJECT_ID }[target];
    const before = await treeShape();

    expect(await tree.move(project, { parentId, position: 0 })).toEqual({
      ok: false,
      code: 'refused',
      problem: NOT_BELOW,
      holder: null,
    });
    expect(await treeShape()).toEqual(before);
  });

  /**
   * What the old nested-project rule guarded against -- a folder carrying a
   * project into another one -- cannot be built any more: no folder takes a
   * project in, so there is never one to carry.
   */
  it('refuses a project into a folder in HOME, so no folder ever carries one', async () => {
    const tree = catalogue();
    const project = await makeProject('node-project', 'agentplex', '/srv/agentplex');
    const folder = await folderIn(tree, HOME_PROJECT_ID, 'archive');
    const before = await treeShape();

    const moved = await tree.move(project, { parentId: folder, position: 0 });

    expect(moved).toMatchObject({ ok: false, code: 'refused', problem: NOT_BELOW });
    expect(await treeShape()).toEqual(before);
  });

  it('reorders a project along the top level', async () => {
    const tree = catalogue();
    const one = await makeProject('node-one', 'one', '/srv/one');
    const two = await makeProject('node-two', 'two', '/srv/two');

    expect(await tree.move(two, { parentId: null, position: 1 })).toEqual({ ok: true });

    expect(idsIn(await tree.readLayout())).toEqual([HOME_PROJECT_ID, two, one]);
  });

  /**
   * HOME is first, always, and a reorder that would put a project before it is
   * clamped rather than refused -- the same answer an index past the end gets,
   * for the same reason: the client asked for something reasonable against a
   * tree it may have read a frame ago.
   */
  it.each([0, -3])('puts a project reordered to position %d just after HOME', async (position) => {
    const tree = catalogue();
    const one = await makeProject('node-one', 'one', '/srv/one');
    const two = await makeProject('node-two', 'two', '/srv/two');

    expect(await tree.move(two, { parentId: null, position })).toEqual({ ok: true });

    expect(idsIn(await tree.readLayout())).toEqual([HOME_PROJECT_ID, two, one]);
    // In storage and not only in the order a reading puts things: the layout
    // orders by the stored position, and a HOME renumbered to 1 would read as
    // second in it while a query that sorts HOME first still showed it first.
    expect((await findNode(database(), HOME_PROJECT_ID))?.position).toBe(0);
  });
});

describe('removing a node', () => {
  it('takes it out and remembers the session, so discovery does not undo it', async () => {
    const tree = catalogue();
    await scan(tree, [descriptor('session-one'), descriptor('session-two')]);

    const removed = await tree.remove(await nodeFor('session-one'));

    expect(removed).toEqual({ ok: true });
    expect(await findNodeForSession(database(), ref('session-one'))).toBeNull();
    expect((await listRemovals(database())).map((removal) => removal.ref.sessionId)).toEqual([
      'session-one',
    ]);

    // The store still has the transcript -- nothing was deleted on any disk --
    // and the next pass declines to place it rather than putting it back.
    await scan(tree, [descriptor('session-one'), descriptor('session-two')]);
    expect(await findNodeForSession(database(), ref('session-one'))).toBeNull();
  });

  it('remembers every session under a folder, not the folder', async () => {
    const tree = catalogue();
    const folder = await tree.createFolder({ parentId: HOME_PROJECT_ID, name: 'this week' });
    if (!folder.ok) throw new Error('the folder should have been made');
    await scan(tree, [descriptor('session-one'), descriptor('session-two')]);
    for (const sessionId of ['session-one', 'session-two']) {
      await tree.move(await nodeFor(sessionId), { parentId: folder.nodeId, position: 0 });
    }

    expect(await tree.remove(folder.nodeId)).toEqual({ ok: true });

    // A folder is the one thing a removal takes away for good: nothing on any
    // disk describes one, so there is nothing for discovery to put back. What
    // it can put back is every session that was inside, which is why those and
    // not the folder are what is remembered.
    expect((await listRemovals(database())).map((removal) => removal.ref.sessionId).sort()).toEqual(
      ['session-one', 'session-two'],
    );
    await scan(tree, [descriptor('session-one'), descriptor('session-two')]);
    expect(idsIn(await tree.readLayout())).toEqual([HOME_PROJECT_ID]);
  });

  it('refuses while a session in the subtree is still running, and names the holder', async () => {
    const tree = catalogue();
    const folder = await tree.createFolder({ parentId: HOME_PROJECT_ID, name: 'this week' });
    if (!folder.ok) throw new Error('the folder should have been made');
    await scan(tree, [descriptor('session-one')]);
    await tree.move(await nodeFor('session-one'), { parentId: folder.nodeId, position: 0 });
    holders.set('session-one', {
      server: 'registration-mbp' as never,
      stoppable: true,
      pause: 'none',
    });

    const removed = await tree.remove(folder.nodeId);

    expect(removed).toEqual({
      ok: false,
      code: 'refused',
      problem: 'the session session-one inside is still running; stop it first, and then remove it',
      // Named rather than merely refused: the way out is stopping the holder,
      // and a client cannot offer that without knowing which machine to aim at.
      holder: { server: 'registration-mbp', stoppable: true, pause: 'none' },
    });
    expect(await findNode(database(), folder.nodeId)).not.toBeNull();
    expect(await listRemovals(database())).toEqual([]);
  });

  it('says it of the session itself when the session itself is what was named', async () => {
    const tree = catalogue();
    await scan(tree, [descriptor('session-one')]);
    holders.set('session-one', {
      server: 'registration-mbp' as never,
      stoppable: false,
      pause: 'none',
    });

    const removed = await tree.remove(await nodeFor('session-one'));

    if (removed.ok) throw new Error('a running session is not removable');
    expect(removed.problem).toBe(
      'this session is still running; stop it first, and then remove it',
    );
    expect(removed.holder).toEqual({ server: 'registration-mbp', stoppable: false, pause: 'none' });
  });

  it('removes a project, and the projects row goes with the node', async () => {
    const tree = catalogue();
    const project = await makeProject('node-project', 'agentplex', '/srv/agentplex');
    await scan(tree, [descriptor('session-one', '/srv/agentplex')]);
    expect((await findNodeForSession(database(), ref('session-one')))?.parentId).toBe(project);

    expect(await tree.remove(project)).toEqual({ ok: true });

    // By cascade, which is the schema's own statement of the rule: there is no
    // row in `projects` describing a node that is gone.
    expect(await database().query('SELECT node_id FROM projects')).toMatchObject({ rows: [] });
    expect((await listRemovals(database())).map((removal) => removal.ref.sessionId)).toEqual([
      'session-one',
    ]);
  });

  it('refuses a node this hub does not have', async () => {
    expect(await catalogue().remove(ABSENT)).toMatchObject({ ok: false, code: 'refused' });
  });
});

describe('forgetting a removal', () => {
  it('puts the session back on the pass it runs, rather than on the next report', async () => {
    const tree = catalogue();
    await scan(tree, [descriptor('session-one')]);
    expect(await tree.remove(await nodeFor('session-one'))).toEqual({ ok: true });

    const forgotten = await tree.forgetRemoval(ref('session-one'));

    expect(forgotten).toEqual({ ok: true });
    expect(await listRemovals(database())).toEqual([]);
    // The pass ran on the way to the answer: the layout a client asks for next
    // already holds the node, rather than holding it whenever a server's timer
    // next comes round.
    expect(await findNodeForSession(database(), ref('session-one'))).not.toBeNull();
  });

  it('refuses a session whose removal this hub does not remember', async () => {
    const forgotten = await catalogue().forgetRemoval(ref('session-nobody-removed'));

    expect(forgotten).toEqual({
      ok: false,
      code: 'refused',
      problem: 'this hub remembers no removal of that session',
      holder: null,
    });
  });

  it('forgets it even when no server has that store, and places nothing', async () => {
    const tree = catalogue();
    await scan(tree, [descriptor('session-one')]);
    expect(await tree.remove(await nodeFor('session-one'))).toEqual({ ok: true });
    // The machine went away. There is no reading of the store, so there is
    // nothing to place -- and saying no here would leave the user unable to
    // undo a removal until a laptop came back.
    stores.set(STORE, null);

    expect(await tree.forgetRemoval(ref('session-one'))).toEqual({ ok: true });
    expect(await listRemovals(database())).toEqual([]);
    expect(idsIn(await tree.readLayout())).toEqual([HOME_PROJECT_ID]);
  });
});

describe('HOME', () => {
  /** HOME as the migration left it, read back so a refusal can be shown to have changed nothing. */
  async function home(): Promise<unknown> {
    return findNode(database(), HOME_PROJECT_ID);
  }

  it('refuses a rename, in words, and keeps its name', async () => {
    const before = await home();

    expect(await catalogue().rename(HOME_PROJECT_ID, 'somewhere else')).toEqual({
      ok: false,
      code: 'refused',
      problem: 'HOME is where every session without a project goes, so its name stays HOME',
      holder: null,
    });
    expect(await home()).toEqual(before);
  });

  it('refuses a blank rename in its own words, not as a blank name', async () => {
    const before = await home();

    expect(await catalogue().rename(HOME_PROJECT_ID, '   ')).toEqual({
      ok: false,
      code: 'refused',
      problem: 'HOME is where every session without a project goes, so its name stays HOME',
      holder: null,
    });
    expect(await home()).toEqual(before);
  });

  it('refuses a move into a folder, in words, and stays where it is', async () => {
    const tree = catalogue();
    const folder = await tree.createFolder({ parentId: HOME_PROJECT_ID, name: 'elsewhere' });
    if (!folder.ok) throw new Error('the folder should have been made');
    const before = await home();

    expect(await tree.move(HOME_PROJECT_ID, { parentId: folder.nodeId, position: 0 })).toEqual({
      ok: false,
      code: 'refused',
      problem: 'HOME stays at the top level',
      holder: null,
    });
    expect(await home()).toEqual(before);
  });

  it('refuses a move along the top level too, so it stays first', async () => {
    const tree = catalogue();
    await makeProject('project-one', 'one', '/srv/one');
    const before = await home();

    expect(await tree.move(HOME_PROJECT_ID, { parentId: null, position: 1 })).toEqual({
      ok: false,
      code: 'refused',
      problem: 'HOME stays at the top level',
      holder: null,
    });
    expect(await home()).toEqual(before);
  });

  it('refuses a removal, in words, and keeps everything in it', async () => {
    const tree = catalogue();
    await scan(tree, [descriptor('session-one')]);
    const session = await nodeFor('session-one');
    expect(await tree.move(session, { parentId: HOME_PROJECT_ID, position: 0 })).toEqual({
      ok: true,
    });
    const before = await home();

    expect(await tree.remove(HOME_PROJECT_ID)).toEqual({
      ok: false,
      code: 'refused',
      problem: 'HOME holds every session without a project, so it cannot be removed',
      holder: null,
    });
    expect(await home()).toEqual(before);
    expect((await findNode(database(), session))?.parentId).toBe(HOME_PROJECT_ID);
    expect(await listRemovals(database())).toEqual([]);
  });

  it('takes a session moved into it', async () => {
    const tree = catalogue();
    await scan(tree, [descriptor('session-one')]);
    const session = await nodeFor('session-one');

    expect(await tree.move(session, { parentId: HOME_PROJECT_ID, position: 0 })).toEqual({
      ok: true,
    });
    expect((await findNode(database(), session))?.parentId).toBe(HOME_PROJECT_ID);
  });

  it('takes a folder made inside it', async () => {
    const made = await catalogue().createFolder({ parentId: HOME_PROJECT_ID, name: 'drafts' });

    if (!made.ok) throw new Error(`the folder should have been made: ${made.problem}`);
    expect((await findNode(database(), made.nodeId))?.parentId).toBe(HOME_PROJECT_ID);
  });
});

describe('the version every attached client is told', () => {
  it('is bumped once per change and never by a refusal', async () => {
    const tree = catalogue();
    const versions: number[] = [];
    const stop = tree.subscribe((version) => versions.push(version));

    const folder = await tree.createFolder({ parentId: HOME_PROJECT_ID, name: 'this week' });
    if (!folder.ok) throw new Error('the folder should have been made');
    await tree.rename(folder.nodeId, 'last week');
    await tree.rename(folder.nodeId, '   ');
    await tree.move(ABSENT, { parentId: null, position: 0 });
    await tree.remove(folder.nodeId);

    expect(versions).toEqual([1, 2, 3]);
    stop();
    await tree.createFolder({ parentId: HOME_PROJECT_ID, name: 'after' });
    expect(versions).toEqual([1, 2, 3]);
  });

  it('is bumped by a discovery pass that actually changed something', async () => {
    const tree = catalogue();
    const versions: number[] = [];
    tree.subscribe((version) => versions.push(version));

    await scan(tree, [descriptor('session-one')], OTHER_STORE);
    expect(versions).toEqual([1]);

    // The same store reading the same way is not a change, and a version that
    // moved on every report would mean "a datagram arrived" rather than
    // "something is different".
    await scan(tree, [descriptor('session-one')], OTHER_STORE);
    expect(versions).toEqual([1]);
  });
});
