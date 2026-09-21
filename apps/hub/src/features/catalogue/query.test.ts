import { describe, expect, it } from 'vitest';
import {
  CATALOGUE_PAGE_MAX_LIMIT,
  nodeIdSchema,
  nodeKindSchema,
  serverAddressSchema,
  serverRegistrationIdSchema,
  sessionIdSchema,
  storeIdSchema,
  type CatalogueItem,
  type CatalogueQuery,
  type MachineState,
  type NodeId,
  type NodeKind,
  type ServerRegistrationId,
  type SessionRow,
  type StoreId,
} from '@agentplex/protocol';
import { createFakeDatabase } from '../../db/fake-database.js';
import { sessionKey } from '../fleet-state/fleet-state.js';
import { queryCatalogue, sessionProjectsIn, type CataloguePageOutcome } from './query.js';
import { nodeRowSchema } from './rows.js';

/**
 * The catalogue query, over a few hundred nodes and no database.
 *
 * The whole of the ordering, the paging and the grouping is a walk over rows
 * one statement brought back -- see `query.ts` for why it is not SQL -- and
 * this is what that decision buys: the fake database answers the two statements
 * with scripted rows, and every rule is reachable from here rather than only
 * from a migrated schema.
 *
 * What is deliberately not here is whether those two statements are right. That
 * is `reads.test` and the integration suites' subject, and a fake that answered
 * SQL would be a second SQLite nobody wrote.
 */

const STORE: StoreId = storeIdSchema.parse('store-agentplex');
const LAPTOP: ServerRegistrationId = serverRegistrationIdSchema.parse('registration-laptop');
const BOX: ServerRegistrationId = serverRegistrationIdSchema.parse('registration-box');
const START = 1_756_000_000_000;

/** A node as the `nodes` table hands it back: column names, not parsed shapes. */
interface NodeRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly kind: string;
  readonly position: number;
  readonly name: string | null;
  readonly name_source: 'discovered' | 'user';
  readonly anchor_store_id: string | null;
  readonly anchor_session_id: string | null;
  readonly created_at: number;
}

function folder(id: string, parentId: string | null, position: number, name: string): NodeRow {
  return {
    id,
    parent_id: parentId,
    kind: 'folder',
    position,
    name,
    name_source: 'user',
    anchor_store_id: null,
    anchor_session_id: null,
    created_at: START,
  };
}

function project(id: string, parentId: string | null, position: number, name: string): NodeRow {
  return { ...folder(id, parentId, position, name), kind: 'project' };
}

function session(
  id: string,
  parentId: string | null,
  position: number,
  sessionId: string,
  name: string | null = null,
): NodeRow {
  return {
    id,
    parent_id: parentId,
    kind: 'session',
    position,
    name,
    name_source: name === null ? 'discovered' : 'user',
    anchor_store_id: STORE,
    anchor_session_id: sessionId,
    created_at: START,
  };
}

interface Reading {
  readonly sessionId: string;
  readonly source?: ServerRegistrationId;
  readonly title?: string | null;
  readonly status?: SessionRow['descriptor']['status'];
  readonly provider?: SessionRow['descriptor']['provider'];
  readonly updatedAt?: number;
  readonly cwd?: string | null;
}

/** The fleet as a client reads it: the one shape a query joins against. */
function fleet(readings: readonly Reading[]): MachineState {
  return {
    version: 1,
    servers: [
      {
        registrationId: LAPTOP,
        label: 'mbp-robert',
        address: serverAddressSchema.parse('wss://mbp-robert.example:8443'),
        serverId: null,
        phase: 'connected',
        stores: [STORE],
        providers: [],
        connectedSince: START,
        staleSince: null,
        lastConnectedAt: START,
        staleReason: null,
        problem: null,
        draining: null,
      },
      {
        registrationId: BOX,
        label: 'gpu-box-01',
        address: serverAddressSchema.parse('wss://gpu-box-01.example:8443'),
        serverId: null,
        phase: 'connected',
        stores: [STORE],
        providers: [],
        connectedSince: START,
        staleSince: null,
        lastConnectedAt: START,
        staleReason: null,
        problem: null,
        draining: null,
      },
    ],
    candidates: [],
    stores: [
      {
        storeId: STORE,
        servers: [LAPTOP, BOX],
        reachable: true,
        unreachableSince: null,
        lastReachableAt: START,
        sessions: readings.map((reading) => ({
          descriptor: {
            storeId: STORE,
            sessionId: sessionIdSchema.parse(reading.sessionId),
            provider: reading.provider ?? 'claude',
            status: reading.status ?? 'idle',
            updatedAt: reading.updatedAt ?? START,
            cwd: reading.cwd ?? null,
            branch: null,
            title: reading.title ?? null,
            uncommitted: null,
          },
          source: reading.source ?? LAPTOP,
          reportedBy: [reading.source ?? LAPTOP],
          reportedAt: START,
          reachable: true,
          holder: null,
          acknowledgedThrough: null,
          mutedAt: null,
          project: null,
        })),
      },
    ],
  };
}

const BASE: CatalogueQuery = {
  view: 'list',
  groupBy: 'none',
  sort: { key: 'name', direction: 'asc' },
  filter: {},
  cursor: null,
  limit: 50,
};

interface Answered {
  ask(query: Partial<CatalogueQuery>): Promise<CataloguePageOutcome>;
  page(query: Partial<CatalogueQuery>): Promise<Extract<CataloguePageOutcome, { ok: true }>>;
}

function over(
  rows: readonly NodeRow[],
  readings: readonly Reading[] = [],
  options: { readonly version?: number; readonly directories?: ReadonlyMap<NodeId, string> } = {},
): Answered {
  const database = createFakeDatabase({
    respondWith: [
      {
        match: /FROM node_kinds/,
        // Exactly what migrations 0004 and 0006 seeded, read back the way the
        // hub reads it: the list view flattens by this and not by a set of
        // kinds spelled out in code.
        rows: [
          { kind: 'doc', container: 0, anchors_session: 0 },
          { kind: 'folder', container: 1, anchors_session: 0 },
          { kind: 'project', container: 1, anchors_session: 0 },
          { kind: 'session', container: 0, anchors_session: 1 },
        ],
      },
      { match: /FROM nodes/, rows },
    ],
  });
  const context = {
    database,
    fleet: fleet(readings),
    directories: options.directories ?? new Map<NodeId, string>(),
    version: options.version ?? 7,
  };
  const ask = (query: Partial<CatalogueQuery>): Promise<CataloguePageOutcome> =>
    queryCatalogue(context, { ...BASE, ...query });
  return {
    ask,
    async page(query: Partial<CatalogueQuery>) {
      const outcome = await ask(query);
      if (!outcome.ok) throw new Error(`the query was refused: ${outcome.problem}`);
      return outcome;
    },
  };
}

function idsOf(items: readonly CatalogueItem[]): readonly string[] {
  return items.map((item) => item.id);
}

/**
 * A catalogue of a few hundred nodes: sixteen projects of twenty sessions each,
 * under two folders, with a few loose sessions at the root.
 *
 * Built rather than written out, because what the paging rules have to be true
 * of is a tree bigger than a page, and a tree written by hand big enough to
 * page is a tree nobody reads.
 */
function bigCatalogue(): { readonly rows: readonly NodeRow[]; readonly readings: Reading[] } {
  const rows: NodeRow[] = [];
  const readings: Reading[] = [];
  rows.push(folder('folder-a', null, 0, 'archive'));
  rows.push(folder('folder-b', null, 1, 'this week'));
  for (let index = 0; index < 16; index += 1) {
    const parent = index < 8 ? 'folder-a' : 'folder-b';
    const projectId = `project-${String(index)}`;
    rows.push(project(projectId, parent, index, `project ${String(index).padStart(2, '0')}`));
    for (let inner = 0; inner < 20; inner += 1) {
      const nodeId = `node-${String(index)}-${String(inner).padStart(2, '0')}`;
      const sessionId = `session-${String(index)}-${String(inner).padStart(2, '0')}`;
      rows.push(session(nodeId, projectId, inner, sessionId));
      readings.push({
        sessionId,
        source: inner % 2 === 0 ? LAPTOP : BOX,
        title: `work ${String(index)}-${String(inner).padStart(2, '0')}`,
        updatedAt: START - index * 1_000 - inner,
      });
    }
  }
  for (let loose = 0; loose < 6; loose += 1) {
    const sessionId = `session-loose-${String(loose)}`;
    rows.push(session(`node-loose-${String(loose)}`, null, 2 + loose, sessionId));
    readings.push({ sessionId, source: LAPTOP, title: `loose ${String(loose)}` });
  }
  return { rows, readings };
}

describe('the catalogue query', () => {
  it('counts the whole answer and cuts the page, so a client can say 12 of 340', async () => {
    const { rows, readings } = bigCatalogue();
    const answered = await over(rows, readings).page({ limit: 12 });

    // 16 projects of 20 plus 6 loose: the containers are not rows in a list.
    expect(answered.total).toBe(326);
    expect(answered.items).toHaveLength(12);
    expect(answered.nextCursor).not.toBeNull();
    expect(answered.version).toBe(7);
  });

  it('clamps a limit nobody could draw rather than refusing it', async () => {
    const { rows, readings } = bigCatalogue();
    const answered = await over(rows, readings).page({ limit: 10_000 });

    expect(answered.items.length).toBe(CATALOGUE_PAGE_MAX_LIMIT);
  });

  it('walks the whole answer through its cursors without repeating or skipping', async () => {
    const { rows, readings } = bigCatalogue();
    const catalogue = over(rows, readings);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 100; guard += 1) {
      const answered: Extract<CataloguePageOutcome, { ok: true }> = await catalogue.page({
        limit: 25,
        cursor,
      });
      seen.push(...idsOf(answered.items));
      cursor = answered.nextCursor;
      if (cursor === null) break;
    }

    expect(seen).toHaveLength(326);
    expect(new Set(seen).size).toBe(326);
  });

  /**
   * The rule that makes the tree view readable across a boundary. A page that
   * ended on a project with its first session at the top of the next one would
   * put a heading on one screen and the thing it heads on another.
   */
  it('never ends a tree page on a parent whose first child is next', async () => {
    const { rows, readings } = bigCatalogue();
    const catalogue = over(rows, readings);

    let cursor: string | null = null;
    let pages = 0;
    for (let guard = 0; guard < 100; guard += 1) {
      const answered: Extract<CataloguePageOutcome, { ok: true }> = await catalogue.page({
        view: 'tree',
        limit: 7,
        cursor,
      });
      pages += 1;
      const last = answered.items.at(-1);
      if (answered.nextCursor !== null && last !== undefined) {
        const next = await catalogue.page({ view: 'tree', limit: 7, cursor: answered.nextCursor });
        expect(next.items[0]?.parentId).not.toBe(last.id);
      }
      cursor = answered.nextCursor;
      if (cursor === null) break;
    }

    expect(pages).toBeGreaterThan(1);
  });

  it('runs a tree page past the limit rather than trimming it to nothing', async () => {
    // A chain deeper than the limit. Trimming back would take every row off
    // this page and the client would never move.
    const rows = [
      folder('one', null, 0, 'one'),
      folder('two', 'one', 0, 'two'),
      folder('three', 'two', 0, 'three'),
      session('leaf', 'three', 0, 'session-leaf', 'leaf'),
    ];
    const answered = await over(rows, [{ sessionId: 'session-leaf' }]).page({
      view: 'tree',
      limit: 1,
    });

    expect(idsOf(answered.items)).toEqual(['one', 'two', 'three', 'leaf']);
    expect(answered.nextCursor).toBeNull();
  });

  /**
   * The default, and now only the default: a query that names no kinds is
   * answered with the leaves it has always been answered with. What a kind
   * selection does to this rule is the subject of its own describe below, and
   * the sidebar catalogue panel -- which sends none -- is on this side of it.
   */
  it('flattens containers out of the list view and keeps them in the tree', async () => {
    const rows = [
      folder('folder', null, 0, 'archive'),
      project('project', 'folder', 0, 'agentplex'),
      session('node', 'project', 0, 'session-one', 'fix auth'),
    ];
    const readings = [{ sessionId: 'session-one' }];

    const list = await over(rows, readings).page({ view: 'list' });
    expect(idsOf(list.items)).toEqual(['node']);

    const tree = await over(rows, readings).page({ view: 'tree' });
    expect(idsOf(tree.items)).toEqual(['folder', 'project', 'node']);
    expect(tree.items.map((item) => item.depth)).toEqual([0, 1, 2]);
  });

  it('puts a project directory on the project item and nothing else', async () => {
    const rows = [
      project('project', null, 0, 'agentplex'),
      session('node', 'project', 0, 'session-one', 'fix auth'),
    ];
    const directories = new Map([[nodeIdSchema.parse('project'), '/Users/robert/code/agentplex']]);
    const answered = await over(rows, [{ sessionId: 'session-one' }], { directories }).page({
      view: 'tree',
    });

    expect(answered.items[0]?.directory).toBe('/Users/robert/code/agentplex');
    expect(answered.items[1]?.directory).toBeNull();
  });
});

describe('the catalogue query, sorted', () => {
  const rows = [
    session('by-node', null, 0, 'session-a', 'aardvark'),
    session('by-title', null, 1, 'session-b'),
    session('by-id', null, 2, 'session-c'),
  ];
  const readings: Reading[] = [
    { sessionId: 'session-a', updatedAt: START - 100, source: BOX },
    { sessionId: 'session-b', title: 'mongoose', updatedAt: START - 50, source: LAPTOP },
    { sessionId: 'session-c', updatedAt: START, source: LAPTOP },
  ];

  it('falls back from the node name to the title to the session id, and says which', async () => {
    const answered = await over(rows, readings).page({ sort: { key: 'name', direction: 'asc' } });

    expect(answered.items.map((item) => [item.displayName, item.nameSource])).toEqual([
      ['aardvark', 'node'],
      ['mongoose', 'title'],
      ['session-c', 'session-id'],
    ]);
  });

  it('sorts by the provider-dated time, newest first when descending', async () => {
    const answered = await over(rows, readings).page({
      sort: { key: 'updatedAt', direction: 'desc' },
    });

    expect(idsOf(answered.items)).toEqual(['by-id', 'by-title', 'by-node']);
  });

  it('sorts by the server label', async () => {
    const answered = await over(rows, readings).page({ sort: { key: 'server', direction: 'asc' } });

    // gpu-box-01 before mbp-robert, and the two on mbp-robert in name order.
    expect(idsOf(answered.items)).toEqual(['by-node', 'by-title', 'by-id']);
  });

  /**
   * The one rule here that is not symmetric, and the one that would be wrong if
   * it were: "I do not know when this was touched" is not a very old time, and
   * flipping the direction must not promote every unknown to the top.
   */
  it('sorts a node with nothing to sort by last, in both directions', async () => {
    const withOrphan = [...rows, session('orphan', null, 3, 'session-gone', 'zzz never reported')];

    const ascending = await over(withOrphan, readings).page({
      sort: { key: 'updatedAt', direction: 'asc' },
    });
    const descending = await over(withOrphan, readings).page({
      sort: { key: 'updatedAt', direction: 'desc' },
    });

    expect(idsOf(ascending.items).at(-1)).toBe('orphan');
    expect(idsOf(descending.items).at(-1)).toBe('orphan');
  });

  it('sorts siblings within the tree rather than flattening it', async () => {
    const nested = [
      folder('folder', null, 0, 'archive'),
      session('zulu', 'folder', 0, 'session-z', 'zulu'),
      session('alpha', 'folder', 1, 'session-a', 'alpha'),
    ];
    const answered = await over(nested, [
      { sessionId: 'session-z' },
      { sessionId: 'session-a' },
    ]).page({ view: 'tree', sort: { key: 'name', direction: 'asc' } });

    expect(idsOf(answered.items)).toEqual(['folder', 'alpha', 'zulu']);
  });
});

describe('the catalogue query, filtered', () => {
  const rows = [
    project('project', null, 0, 'agentplex'),
    session('inside', 'project', 0, 'session-inside', 'inside'),
    session('outside', null, 1, 'session-outside', 'outside'),
  ];
  const readings: Reading[] = [
    { sessionId: 'session-inside', source: LAPTOP, provider: 'claude', status: 'working' },
    { sessionId: 'session-outside', source: BOX, provider: 'codex', status: 'idle' },
  ];

  it('keeps only what the chosen reading came from, for a server filter', async () => {
    const answered = await over(rows, readings).page({ filter: { server: BOX } });

    expect(idsOf(answered.items)).toEqual(['outside']);
    expect(answered.total).toBe(1);
  });

  it('filters by provider and by status', async () => {
    expect(
      idsOf((await over(rows, readings).page({ filter: { provider: 'codex' } })).items),
    ).toEqual(['outside']);
    expect(
      idsOf((await over(rows, readings).page({ filter: { status: 'working' } })).items),
    ).toEqual(['inside']);
  });

  it('filters by project, and the project itself is in its own project', async () => {
    const list = await over(rows, readings).page({
      filter: { project: nodeIdSchema.parse('project') },
    });
    expect(idsOf(list.items)).toEqual(['inside']);

    const tree = await over(rows, readings).page({
      view: 'tree',
      filter: { project: nodeIdSchema.parse('project') },
    });
    expect(idsOf(tree.items)).toEqual(['project', 'inside']);
  });

  it('keeps a container in the tree when something under it matches', async () => {
    const answered = await over(rows, readings).page({
      view: 'tree',
      filter: { status: 'working' },
    });

    expect(idsOf(answered.items)).toEqual(['project', 'inside']);
  });
});

describe('the catalogue query, searched', () => {
  const rows = [
    session('by-name', null, 0, 'session-one', 'refresh the token'),
    session('by-id', null, 1, 'session-needle-two'),
    session('by-cwd', null, 2, 'session-three', 'somewhere'),
    session('by-server', null, 3, 'session-four', 'elsewhere'),
  ];
  const readings: Reading[] = [
    { sessionId: 'session-one' },
    { sessionId: 'session-needle-two' },
    { sessionId: 'session-three', cwd: '/Users/robert/needle/checkout' },
    { sessionId: 'session-four', source: BOX },
  ];

  it('says which field a hit matched on', async () => {
    const answered = await over(rows, readings).page({ filter: { search: 'needle' } });

    expect(answered.items.map((item) => [item.id, item.matched])).toEqual([
      ['by-id', 'session-id'],
      ['by-cwd', 'cwd'],
    ]);
  });

  it('matches a machine label, case-insensitively', async () => {
    const answered = await over(rows, readings).page({ filter: { search: 'GPU-BOX' } });

    expect(answered.items.map((item) => [item.id, item.matched])).toEqual([
      ['by-server', 'server'],
    ]);
  });

  it('reports the name when a row matches on two fields', async () => {
    const answered = await over(rows, readings).page({ filter: { search: 'token' } });

    expect(answered.items.map((item) => [item.id, item.matched])).toEqual([['by-name', 'name']]);
  });

  it('says nothing about a match when nothing was searched for', async () => {
    const answered = await over(rows, readings).page({});

    expect(answered.items.every((item) => item.matched === null)).toBe(true);
  });
});

/**
 * The kind selection: the one thing that lets a flat answer carry a project.
 *
 * Flat means leaves, and `node_kinds` marks `folder` and `project` containers
 * alike -- so until this field a search over the list view could find a session
 * or a doc and nothing else, whatever the user typed. Naming kinds lifts the
 * leaves-only rule for exactly the kinds named, which is why a palette asks for
 * the kinds it draws headings for rather than being handed folders to drop.
 *
 * What it is not is the tree view. The tree keeps every container on the way to
 * a hit, matching or not, because a search from a tree is asking where the hits
 * are. A flat answer is asking what the hits are, and an ancestor that matched
 * nothing is not one.
 */
describe('the catalogue query, over the kinds it names', () => {
  const rows = [
    folder('folder', null, 0, 'archive'),
    project('project', 'folder', 0, 'agentplex'),
    session('session', 'project', 0, 'session-one', 'fix auth'),
    session('elsewhere', null, 1, 'session-two', 'agentplex rewrite'),
  ];
  const readings: Reading[] = [
    { sessionId: 'session-one', cwd: '/Users/robert/code/agentplex' },
    { sessionId: 'session-two' },
  ];
  const kinds = (...named: readonly string[]): NodeKind[] =>
    named.map((kind) => nodeKindSchema.parse(kind));

  it('answers a flat search with a project, matched on the only field it has', async () => {
    const answered = await over(rows, readings).page({
      filter: { search: 'agentplex', kinds: kinds('project') },
    });

    expect(idsOf(answered.items)).toEqual(['project']);
    expect(answered.total).toBe(1);
    // A container has no session id, no working directory and no server, so
    // the name is the only field `matchOf` can hit on -- which is why this
    // needed no new `CatalogueMatchField`.
    expect(answered.items[0]?.matched).toBe('name');
    expect(answered.items[0]?.session).toBeNull();
    expect(answered.items[0]?.anchor).toBeNull();
    expect(answered.items[0]?.server).toBeNull();
  });

  it('answers the same search with no project at all when no kind is named', async () => {
    const answered = await over(rows, readings).page({ filter: { search: 'agentplex' } });

    // The session whose name holds it and the session whose cwd does. The
    // project named exactly that is unreachable, which is the whole complaint.
    expect(idsOf(answered.items)).toEqual(['elsewhere', 'session']);
  });

  it('sorts a container in among the leaves rather than beside them', async () => {
    const answered = await over(rows, readings).page({
      filter: { kinds: kinds('project', 'session') },
    });

    expect(idsOf(answered.items)).toEqual(['project', 'elsewhere', 'session']);
  });

  it('leaves out the non-matching containers a tree search would keep', async () => {
    const selection = kinds('folder', 'project', 'session');

    const list = await over(rows, readings).page({ filter: { search: 'fix', kinds: selection } });
    expect(idsOf(list.items)).toEqual(['session']);

    const tree = await over(rows, readings).page({
      view: 'tree',
      filter: { search: 'fix', kinds: selection },
    });
    expect(idsOf(tree.items)).toEqual(['folder', 'project', 'session']);
  });

  it('matches nothing for a kind no migration has seeded, and refuses nothing', async () => {
    // What lets a client ask for `graph` before the migration that seeds it:
    // the answer is an empty page at the version the catalogue is at, not a
    // refusal a client would have to be released to stop sending.
    const answered = await over(rows, readings).ask({ filter: { kinds: kinds('graph') } });

    expect(answered.ok).toBe(true);
    if (!answered.ok) return;
    expect(answered.items).toEqual([]);
    expect(answered.total).toBe(0);
  });
});

describe('the catalogue query, grouped', () => {
  const rows = [
    project('project', null, 0, 'agentplex'),
    session('filed', 'project', 0, 'session-filed', 'filed'),
    session('unfiled', null, 1, 'session-unfiled', 'unfiled'),
    session('unreported', null, 2, 'session-gone', 'unreported'),
  ];
  const readings: Reading[] = [
    { sessionId: 'session-filed', source: BOX },
    { sessionId: 'session-unfiled', source: LAPTOP },
  ];

  it('groups by the server the fleet state chose, and marks what has none', async () => {
    const answered = await over(rows, readings).page({ groupBy: 'server' });
    const groups = answered.items.map((item) => [item.id, item.group?.label, item.group?.unfiled]);

    expect(groups).toEqual([
      ['filed', 'gpu-box-01', false],
      ['unfiled', 'mbp-robert', false],
      ['unreported', 'no server reporting', true],
    ]);
  });

  it('groups by the project ancestor, and marks the ones with none', async () => {
    const answered = await over(rows, readings).page({ groupBy: 'project' });
    const groups = answered.items.map((item) => [item.id, item.group?.key, item.group?.unfiled]);

    expect(groups).toEqual([
      ['filed', 'project', false],
      ['unfiled', null, true],
      ['unreported', null, true],
    ]);
  });

  it('says nothing about a group when nothing is grouping', async () => {
    const answered = await over(rows, readings).page({ groupBy: 'none' });

    expect(answered.items.every((item) => item.group === null)).toBe(true);
  });
});

describe('the catalogue cursor', () => {
  const rows = [
    session('one', null, 0, 'session-one', 'one'),
    session('two', null, 1, 'session-two', 'two'),
    session('three', null, 2, 'session-three', 'three'),
  ];
  const readings: Reading[] = [
    { sessionId: 'session-one' },
    { sessionId: 'session-two' },
    { sessionId: 'session-three' },
  ];

  it('refuses a cursor minted before the catalogue changed, and says it is stale', async () => {
    const first = await over(rows, readings, { version: 7 }).page({ limit: 1 });
    const cursor = first.nextCursor;
    if (cursor === null) throw new Error('the first page ended the answer');

    const later = await over(rows, readings, { version: 8 }).ask({ limit: 1, cursor });

    expect(later.ok).toBe(false);
    if (later.ok) return;
    expect(later.code).toBe('bad-request');
    expect(later.problem).toContain('stale');
    expect(later.problem).toContain('version 7');
  });

  it('refuses a cursor that belongs to a different question', async () => {
    const catalogue = over(rows, readings);
    const first = await catalogue.page({ limit: 1, sort: { key: 'name', direction: 'asc' } });
    const cursor = first.nextCursor;
    if (cursor === null) throw new Error('the first page ended the answer');

    const flipped = await catalogue.ask({
      limit: 1,
      cursor,
      sort: { key: 'name', direction: 'desc' },
    });

    expect(flipped.ok).toBe(false);
    if (flipped.ok) return;
    expect(flipped.problem).toContain('different query');
  });

  it('refuses a cursor minted under a different kind selection', async () => {
    // The selection is part of the order and not a view of it: a position in
    // the sessions-only order names a different row once projects are in it.
    const catalogue = over(rows, readings);
    const first = await catalogue.page({
      limit: 1,
      filter: { kinds: [nodeKindSchema.parse('session')] },
    });
    const cursor = first.nextCursor;
    if (cursor === null) throw new Error('the first page ended the answer');

    const widened = await catalogue.ask({
      limit: 1,
      cursor,
      filter: { kinds: [nodeKindSchema.parse('session'), nodeKindSchema.parse('project')] },
    });

    expect(widened.ok).toBe(false);
    if (widened.ok) return;
    expect(widened.problem).toContain('different query');
  });

  it('accepts a cursor whose kinds were named in another order, because a set has none', async () => {
    // The other half of the rule above: the selection is a set, so the same
    // kinds listed in another order are the same question and a position in it
    // is still exactly true. A client building that list off an object's keys,
    // or off a `Set` it filled as it went, would otherwise be refused
    // mid-paging for a query it never changed.
    const catalogue = over(rows, readings);
    const kinds = [nodeKindSchema.parse('session'), nodeKindSchema.parse('project')];
    const first = await catalogue.page({ limit: 1, filter: { kinds } });
    const cursor = first.nextCursor;
    if (cursor === null) throw new Error('the first page ended the answer');

    const reversed = await catalogue.page({
      limit: 10,
      cursor,
      filter: { kinds: [...kinds].reverse() },
    });

    expect(idsOf(reversed.items)).toEqual(['three', 'two']);
  });

  it('accepts a cursor across a change of page size, because the order did not move', async () => {
    const catalogue = over(rows, readings);
    const first = await catalogue.page({ limit: 1 });
    const cursor = first.nextCursor;
    if (cursor === null) throw new Error('the first page ended the answer');

    const wider = await catalogue.page({ limit: 10, cursor });

    expect(idsOf(wider.items)).toEqual(['three', 'two']);
  });

  it('refuses something that is not a cursor at all rather than reading it as one', async () => {
    const refused = await over(rows, readings).ask({ cursor: 'not-a-cursor' });

    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe('bad-request');
    expect(refused.problem).toContain('not a cursor this hub minted');
  });
});

/**
 * Where the tree puts each session, read for the fleet state rather than for a
 * page.
 *
 * Which project a session is in reaches a client twice: as the group a page
 * grouped by project puts an item in, and as the project on the session row
 * itself. Two walks would be two answers about one session, free to disagree
 * on the screen that draws both, so there is one walk and this is it -- held
 * here to the same tree the grouped suite above is held to.
 */
describe('the project each session is filed under', () => {
  const rows = [
    project('project', null, 0, 'universe'),
    folder('bench', 'project', 0, 'benchmarks'),
    session('filed', 'bench', 0, 'session-bench'),
    folder('drafts', null, 1, 'drafts'),
    session('unfiled', 'drafts', 0, 'session-draft'),
  ];
  const readings: Reading[] = [{ sessionId: 'session-bench' }, { sessionId: 'session-draft' }];

  const placements = (): ReadonlyMap<string, { nodeId: NodeId; name: string }> =>
    sessionProjectsIn(rows.map((row) => nodeRowSchema.parse(row)));

  const keyFor = (sessionId: string): string =>
    sessionKey({ storeId: STORE, sessionId: sessionIdSchema.parse(sessionId) });

  it('names the project above a session, however many folders are between them', () => {
    expect(placements().get(keyFor('session-bench'))).toEqual({
      nodeId: 'project',
      name: 'universe',
    });
  });

  it('leaves a session in no project out of the reading rather than filing it somewhere', () => {
    const read = placements();

    expect(read.has(keyFor('session-draft'))).toBe(false);
    expect(read.size).toBe(1);
  });

  it('says what a page grouped by project says about the same tree', async () => {
    const answered = await over(rows, readings).page({ groupBy: 'project' });
    const groups = new Map(answered.items.map((item) => [item.id, item.group?.key ?? null]));
    const read = placements();

    expect(read.get(keyFor('session-bench'))?.nodeId).toBe(groups.get(nodeIdSchema.parse('filed')));
    expect(read.get(keyFor('session-draft'))).toBeUndefined();
    expect(groups.get(nodeIdSchema.parse('unfiled'))).toBeNull();
  });
});
