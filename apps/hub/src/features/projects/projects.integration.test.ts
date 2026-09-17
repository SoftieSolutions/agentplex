import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { nodeIdSchema } from '@agentplex/protocol';
import { createLogger } from '@agentplex/node-shared';
import type { Database } from '../../db/database.js';
import { openMigratedSchema, type MigratedSchema } from '../../db/test-migrated-schema.js';
import { createFleetState } from '../fleet-state/fleet-state.js';
import { createProjects, type Projects } from './projects.js';

/**
 * The rows a project is, against a real schema.
 *
 * The browse half of this feature is exercised end to end in
 * `tests/hub-server/src/directory-browse.integration.test.ts`, against a real
 * server over a real handshake, because a relay is only worth testing where
 * there is something at the other end. What is here is the half that is a
 * database: what making a project writes, what it refuses, and the two reads a
 * start and the tree make of it.
 */

let migrated: MigratedSchema | null = null;
let minted = 0;

const NOW = 1_756_000_000_000;
const clock = { now: () => NOW };
const logger = createLogger('error', () => {});

function db(): Database {
  if (migrated === null) throw new Error('no database: beforeAll did not run');
  return migrated.database;
}

function projects(): Projects {
  return createProjects({
    database: db(),
    ids: { newId: () => `node-${String((minted += 1))}` },
    clock,
    // Nothing here browses, and the fleet is what a browse asks about. An empty
    // one is the honest value for a suite whose subject is the rows.
    state: createFleetState({ logger }),
    connections: { ask: () => Promise.reject(new Error('no browse in this suite')) },
    logger,
    // The tree's version is the catalogue's, and no catalogue is running here.
    onTreeChanged: () => undefined,
  });
}

describe('making a project', () => {
  beforeAll(async () => {
    migrated = await openMigratedSchema('projects-probe');
  });

  afterAll(async () => {
    await migrated?.close();
  });

  beforeEach(async () => {
    await db().query('DELETE FROM nodes');
    minted = 0;
  });

  it('writes a node and the row that makes it a project, together', async () => {
    const made = await projects().create({ name: 'agentplex', directory: '/srv/work/agentplex' });

    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const node = await db().query(
      'SELECT kind, parent_id, name, name_source FROM nodes WHERE id = ?',
      [made.nodeId],
    );
    expect(node.rows[0]).toEqual({
      kind: 'project',
      parent_id: null,
      name: 'agentplex',
      // The user made this, so the user owns the name from the first
      // millisecond: nothing discovered it and nothing may retitle it.
      name_source: 'user',
    });
    const row = await db().query('SELECT directory FROM projects WHERE node_id = ?', [made.nodeId]);
    expect(row.rows[0]).toEqual({ directory: '/srv/work/agentplex' });
  });

  it('puts each project after the last, rather than stacking them at 0', async () => {
    const feature = projects();
    await feature.create({ name: 'one', directory: '/srv/one' });
    await feature.create({ name: 'two', directory: '/srv/two' });

    const rows = await db().query<{ position: number }>(
      'SELECT position FROM nodes ORDER BY position',
    );
    expect(rows.rows.map((row) => row.position)).toEqual([0, 1]);
  });

  it('stores the normalised directory, so one directory is one project', async () => {
    const feature = projects();
    const made = await feature.create({ name: 'agentplex', directory: '/srv/./work/../work/' });

    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(await feature.directoryOf(made.nodeId)).toBe('/srv/work');
    // And the lookup asks in the same spelling, whatever a server reported.
    expect(await feature.findByDirectory('/srv/work/')).toBe(made.nodeId);
  });

  it('refuses a second project for one directory, and names the one that has it', async () => {
    const feature = projects();
    const first = await feature.create({ name: 'agentplex', directory: '/srv/work' });
    if (!first.ok) throw new Error('the first project should have been made');

    const second = await feature.create({ name: 'the same thing', directory: '/srv/work/' });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('refused');
    // The sentence names the directory, because that is what the person has to
    // go and look for -- and the first project is still the only one.
    expect(second.problem).toContain('/srv/work');
    expect(await db().query('SELECT node_id FROM projects')).toMatchObject({ rowCount: 1 });
    expect(await feature.findByDirectory('/srv/work')).toBe(first.nodeId);
  });

  it('refuses a name that is nothing but spaces, without closing anything', async () => {
    const made = await projects().create({ name: '   ', directory: '/srv/work' });

    expect(made).toMatchObject({ ok: false, code: 'refused' });
    expect(await db().query('SELECT node_id FROM projects')).toMatchObject({ rowCount: 0 });
  });

  it('trims the name it stores, so two spellings of one intent are one name', async () => {
    const made = await projects().create({ name: '  agentplex  ', directory: '/srv/work' });
    if (!made.ok) throw new Error('the project should have been made');

    const node = await db().query('SELECT name FROM nodes WHERE id = ?', [made.nodeId]);
    expect(node.rows[0]).toEqual({ name: 'agentplex' });
  });
});

describe('reading a project back', () => {
  beforeAll(async () => {
    migrated = await openMigratedSchema('projects-read-probe');
  });

  afterAll(async () => {
    await migrated?.close();
  });

  beforeEach(async () => {
    await db().query('DELETE FROM nodes');
    minted = 0;
  });

  it('answers nothing for a node that is not a project', async () => {
    const feature = projects();
    expect(await feature.directoryOf(nodeIdSchema.parse('node-nowhere'))).toBeNull();
    expect(await feature.findByDirectory('/srv/nothing')).toBeNull();
  });

  /**
   * The delete this schema states rather than a loop above it: a project's row
   * cannot outlive the node it describes, because a row describing a node that
   * is gone is a directory nothing can put on a screen.
   */
  it('takes the project row with the node when the node goes', async () => {
    const feature = projects();
    const made = await feature.create({ name: 'agentplex', directory: '/srv/work' });
    if (!made.ok) throw new Error('the project should have been made');

    await db().query('DELETE FROM nodes WHERE id = ?', [made.nodeId]);

    expect(await feature.directoryOf(made.nodeId)).toBeNull();
    expect(await db().query('SELECT node_id FROM projects')).toMatchObject({ rowCount: 0 });
  });

  /**
   * The listing, which is the join the side table always meant to cost: the
   * name is the node's and the directory is the project row's, and neither is
   * a project on its own.
   */
  it('lists every project with the name off its node and the directory off its row', async () => {
    const feature = projects();
    await feature.create({ name: 'agentplex', directory: '/srv/work/agentplex' });

    expect(await feature.list()).toEqual([
      { nodeId: 'node-1', name: 'agentplex', directory: '/srv/work/agentplex' },
    ]);
  });

  it('lists by name, so two calls hand back one order', async () => {
    const feature = projects();
    await feature.create({ name: 'web', directory: '/srv/work/web' });
    await feature.create({ name: 'agentplex', directory: '/srv/work/agentplex' });

    // Insertion order is the other candidate and it is the wrong one: an agent
    // reads this listing to pick the row it is about to start in, and a list
    // that reorders itself as somebody makes a project is one it has to read
    // twice.
    expect((await feature.list()).map((project) => project.name)).toEqual(['agentplex', 'web']);
  });

  it('answers a hub with no projects with an empty list', async () => {
    expect(await projects().list()).toEqual([]);
  });

  it('drops a project whose node has gone, because the pair is what a project is', async () => {
    const feature = projects();
    const made = await feature.create({ name: 'agentplex', directory: '/srv/work' });
    if (!made.ok) throw new Error('the project should have been made');

    await db().query('DELETE FROM nodes WHERE id = ?', [made.nodeId]);

    // The cascade above is what makes this true, and the join is what makes it
    // true even if that cascade ever stopped being: a row with no node has no
    // name, and a project with no name is not something to put in a listing.
    expect(await feature.list()).toEqual([]);
  });
});
