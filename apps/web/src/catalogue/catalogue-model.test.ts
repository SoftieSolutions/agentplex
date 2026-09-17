import { describe, expect, it } from 'vitest';
import {
  nodeIdSchema,
  parseHubFrame,
  parseTextFrame,
  sessionRefSchema,
  type CatalogueItem,
  type MachineState,
  type NodeId,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { DOC_KIND, FOLDER_KIND, PROJECT_KIND, SESSION_KIND } from '../tree/node-kinds.js';
import {
  CATALOGUE_PAGE_LIMIT,
  countLabel,
  DEFAULT_SHAPE,
  filterNote,
  filterOptions,
  filterTree,
  isNarrowed,
  matchWords,
  nameStyleOf,
  NO_PAGES,
  pageAdopted,
  queryFor,
  rowNotes,
  rowsFor,
  sessionCounts,
  shortMachineLabels,
  shortMachinesOf,
  withFilter,
  withGroupBy,
  withSort,
  withView,
  type CataloguePages,
} from './catalogue-model.js';

function id(text: string): NodeId {
  return nodeIdSchema.parse(text);
}

/**
 * A fleet as the hub really sent one. The narrowings are built out of a
 * machine state, and a hand-written state would be a test that the options
 * come out of what its author imagined the hub reports.
 */
function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the captured frame is not a machine state');
  }
  return parsed.value.state;
}

function anchorOf(sessionId: string) {
  return sessionRefSchema.parse({ storeId: 'store-agentplex', sessionId });
}

/**
 * An item as the hub sends one, minus the session row, which only the tests
 * about a session's own fields fill in. Hand-shaped on purpose and only here:
 * these are tests about what the *client* derives from an item, and the
 * captured fixtures are what test that the client can read what the hub really
 * says -- those live in the store's suite.
 */
function item(fields: Partial<CatalogueItem> & { id: NodeId }): CatalogueItem {
  return {
    parentId: null,
    kind: SESSION_KIND,
    position: 0,
    name: null,
    named: false,
    anchor: null,
    depth: 0,
    displayName: fields.id,
    nameSource: 'node',
    session: null,
    directory: null,
    server: null,
    group: null,
    matched: null,
    ...fields,
  };
}

function pages(
  items: readonly CatalogueItem[],
  over: Partial<CataloguePages> = {},
): CataloguePages {
  return { items, nextCursor: null, total: items.length, version: 1, answered: true, ...over };
}

describe('the query a shape asks', () => {
  it('carries the limit from the named constant and the cursor it was given', () => {
    expect(queryFor(DEFAULT_SHAPE, null)).toEqual({
      view: 'tree',
      groupBy: 'none',
      sort: { key: 'name', direction: 'asc' },
      filter: {},
      cursor: null,
      limit: CATALOGUE_PAGE_LIMIT,
    });
    expect(queryFor(DEFAULT_SHAPE, 'opaque').cursor).toBe('opaque');
  });

  it('maps the view, grouping and sort controls straight onto the frame', () => {
    const shape = withSort(
      withGroupBy(withView(DEFAULT_SHAPE, 'list'), 'server'),
      'updatedAt',
      'desc',
    );
    expect(queryFor(shape, null)).toMatchObject({
      view: 'list',
      groupBy: 'server',
      sort: { key: 'updatedAt', direction: 'desc' },
    });
  });
});

describe('the filter controls', () => {
  it('is no constraint at all until something narrows', () => {
    expect(isNarrowed(DEFAULT_SHAPE)).toBe(false);
    expect(DEFAULT_SHAPE.filter).toEqual({});
  });

  it('parses a choice and drops one the state no longer offers', () => {
    const narrowed = withFilter(DEFAULT_SHAPE, { field: 'provider', value: 'claude' });
    expect(narrowed.filter.provider).toBe('claude');
    expect(isNarrowed(narrowed)).toBe(true);

    // A menu built from a state that has moved can hand back a word that is no
    // longer a provider: it narrows by nothing rather than riding onto the wire.
    const nonsense = withFilter(narrowed, { field: 'provider', value: 'gemini-9' });
    expect('provider' in nonsense.filter).toBe(false);
  });

  it('clears a narrowing when the control is cleared', () => {
    const narrowed = withFilter(DEFAULT_SHAPE, { field: 'status', value: 'working' });
    expect(narrowed.filter.status).toBe('working');
    expect('status' in withFilter(narrowed, { field: 'status', value: null }).filter).toBe(false);
  });

  it('treats a blank search box as the absence of a constraint', () => {
    const searched = withFilter(DEFAULT_SHAPE, { field: 'search', value: 'auth' });
    expect(searched.filter.search).toBe('auth');
    expect('search' in withFilter(searched, { field: 'search', value: '   ' }).filter).toBe(false);
  });

  it('cuts a search at the length the protocol bounds it to', () => {
    const long = 'x'.repeat(500);
    const searched = withFilter(DEFAULT_SHAPE, { field: 'search', value: long });
    expect(searched.filter.search).toHaveLength(200);
  });
});

describe('accumulating pages', () => {
  const first = item({ id: id('hub-1') });
  const second = item({ id: id('hub-2') });

  it('appends the next page onto what is held', () => {
    const held = pageAdopted(
      NO_PAGES,
      {
        items: [first],
        nextCursor: 'more',
        total: 2,
        version: 7,
      },
      'replace',
    );
    expect(held.answered).toBe(true);
    expect(held.nextCursor).toBe('more');

    const both = pageAdopted(
      held,
      { items: [second], nextCursor: null, total: 2, version: 7 },
      'append',
    );
    expect(both.items.map((entry) => entry.id)).toEqual([id('hub-1'), id('hub-2')]);
    expect(both.nextCursor).toBeNull();
  });

  it('replaces rather than appends when the answer was computed at another version', () => {
    // Belt to the hub's brace: it refuses the cursor first. If one ever got
    // through, two orders interleaved is the one thing that must not happen.
    const held = pageAdopted(
      NO_PAGES,
      { items: [first], nextCursor: 'more', total: 2, version: 7 },
      'replace',
    );
    const moved = pageAdopted(
      held,
      { items: [second], nextCursor: null, total: 1, version: 8 },
      'append',
    );
    expect(moved.items.map((entry) => entry.id)).toEqual([id('hub-2')]);
  });

  it('says how much of the answer is on screen, and stops saying it when all of it is', () => {
    expect(countLabel(pages([first], { total: 340, nextCursor: 'more' }))).toBe('1 of 340');
    expect(countLabel(pages([first, second], { total: 2 }))).toBe('2');
  });
});

describe('the rows a tree draws', () => {
  const project = item({
    id: id('p'),
    kind: PROJECT_KIND,
    name: 'agentplex',
    named: true,
    depth: 0,
  });
  const folder = item({
    id: id('f'),
    kind: FOLDER_KIND,
    parentId: id('p'),
    name: 'this week',
    named: true,
    depth: 1,
  });
  const session = item({
    id: id('s'),
    parentId: id('f'),
    depth: 2,
    anchor: anchorOf('session-1'),
  });
  const items = [project, folder, session];

  it('draws everything when nothing is collapsed, at the depth the hub said', () => {
    const rows = rowsFor(items, { view: 'tree', collapsed: new Set() });
    expect(rows.map((row) => row.kind === 'item' && row.depth)).toEqual([0, 1, 2]);
    expect(rows.every((row) => row.kind === 'item' && !row.collapsed)).toBe(true);
  });

  it('hides what a closed container holds, however deep', () => {
    const rows = rowsFor(items, { view: 'tree', collapsed: new Set([id('p')]) });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind === 'item' && rows[0].collapsed).toBe(true);
  });

  it('offers a disclosure on a container even when nothing under it has loaded', () => {
    const rows = rowsFor([item({ id: id('f'), kind: FOLDER_KIND })], {
      view: 'tree',
      collapsed: new Set(),
    });
    expect(rows[0]?.kind === 'item' && rows[0].expandable).toBe(true);
  });

  it('draws a row whose parent is not on the page, rather than guessing it is hidden', () => {
    // A page that resumed inside a subtree holds children whose parents were on
    // the page before; the client cannot say an ancestor it never saw is closed.
    const rows = rowsFor([session], { view: 'tree', collapsed: new Set([id('f')]) });
    expect(rows).toHaveLength(1);
  });

  it('draws no group headings in the tree, where the containment is the grouping', () => {
    const grouped = items.map((entry) => ({
      ...entry,
      group: { key: 'registration-1', label: 'mbp-robert', unfiled: false },
    }));
    expect(
      rowsFor(grouped, { view: 'tree', collapsed: new Set() }).every((row) => row.kind === 'item'),
    ).toBe(true);
  });
});

describe('filtering the tree', () => {
  const project = item({
    id: id('p'),
    kind: PROJECT_KIND,
    name: 'agentplex',
    named: true,
    displayName: 'agentplex',
    depth: 0,
  });
  const folder = item({
    id: id('f'),
    kind: FOLDER_KIND,
    parentId: id('p'),
    name: 'this week',
    named: true,
    displayName: 'this week',
    depth: 1,
  });
  const session = item({
    id: id('s'),
    parentId: id('f'),
    depth: 2,
    displayName: 'fix-auth-refresh',
    anchor: anchorOf('session-1'),
  });
  const elsewhere = item({ id: id('o'), displayName: 'spike-wasm', anchor: anchorOf('session-2') });
  const items = [project, folder, session, elsewhere];

  it('hides nothing at all until something is typed', () => {
    for (const blank of ['', '   ']) {
      const filtered = filterTree(items, blank);
      expect(filtered.items).toBe(items);
      expect(filtered.hidden).toBe(0);
      expect(filterNote(filtered, true)).toBeNull();
    }
  });

  it('matches a name however it was typed, and counts what that took away', () => {
    const filtered = filterTree(items, '  SPIKE  ');
    expect(filtered.items.map((entry) => entry.displayName)).toEqual(['spike-wasm']);
    expect(filtered.hidden).toBe(3);
    expect(filterNote(filtered, true)).toBe('3 hidden by filter');
  });

  it('keeps every ancestor of a hit, so the hit stays where the user put it', () => {
    const filtered = filterTree(items, 'auth');
    expect(filtered.items.map((entry) => entry.displayName)).toEqual([
      'agentplex',
      'this week',
      'fix-auth-refresh',
    ]);
    expect(filtered.hidden).toBe(1);
  });

  it('keeps the order the hub answered in', () => {
    const filtered = filterTree([elsewhere, project, folder, session], 'e');
    expect(filtered.items.map((entry) => entry.id)).toEqual([id('o'), id('p'), id('f'), id('s')]);
  });

  it('draws a container that matched without pulling what is under it along', () => {
    // The rule the hub's tree order already follows: a container is kept when
    // it matches or when something under it does, and a child that matched
    // nothing is a child the filter was asked to take away.
    const filtered = filterTree(items, 'this week');
    expect(filtered.items.map((entry) => entry.displayName)).toEqual(['agentplex', 'this week']);
    expect(filterNote(filtered, true)).toBe('2 hidden by filter');
  });

  it('offers no disclosure and honours no closed folder while it is on', () => {
    // Every node the filter kept is drawn, whatever was closed before: the
    // footer's count is only honest while the filter is the one thing hiding
    // anything. And no row offers a chevron, because there is nothing for it
    // to do -- one that wrote the arrangement anyway would have a person
    // reordering their tree by trying to open a folder that is already open.
    const rows = rowsFor(items, {
      view: 'tree',
      collapsed: new Set([id('p'), id('f')]),
      filtering: true,
    });
    expect(rows.map((row) => row.kind === 'item' && row.item.displayName)).toEqual([
      'agentplex',
      'this week',
      'fix-auth-refresh',
      'spike-wasm',
    ]);
    expect(rows.every((row) => row.kind === 'item' && !row.expandable && !row.collapsed)).toBe(
      true,
    );
  });

  it('says the filter matched nothing rather than drawing an empty tree', () => {
    const filtered = filterTree(items, 'nothing here is called this');
    expect(filtered.items).toEqual([]);
    expect(filtered.hidden).toBe(4);
    expect(filterNote(filtered, true)).toBe('nothing in the tree matches this filter');
  });

  it('claims nothing about the pages it has not been given', () => {
    // Half an answer is on screen, so both sentences are about the half that
    // is: "nothing matches" would be a statement about a catalogue this has
    // not seen, and a bare count would be read as a count over the whole of
    // it. Each says what it holds instead.
    const filtered = filterTree(items, 'nothing here is called this');
    expect(filterNote(filtered, false)).toBe('nothing loaded so far matches this filter');
    expect(filterNote(filterTree(items, 'auth'), false)).toBe(
      '1 hidden by filter, of what has loaded so far',
    );
  });

  it('terminates on ids that describe a cycle rather than walking forever', () => {
    // Nothing in the hub can write one; this is the belt to that brace.
    const one = item({ id: id('a'), parentId: id('b'), displayName: 'one' });
    const other = item({ id: id('b'), parentId: id('a'), displayName: 'other' });
    expect(filterTree([one, other], 'one').items.map((entry) => entry.id)).toEqual([
      id('a'),
      id('b'),
    ]);
  });
});

describe('the rows a list draws', () => {
  const mbp = { key: 'registration-mbp', label: 'mbp-robert', unfiled: false };
  const nowhere = { key: null, label: 'no server reporting', unfiled: true };

  it('heads each run of one group and indents nothing', () => {
    const rows = rowsFor(
      [
        item({ id: id('a'), group: mbp }),
        item({ id: id('b'), group: mbp }),
        item({ id: id('c'), group: nowhere }),
      ],
      { view: 'list', collapsed: new Set() },
    );
    expect(
      rows.map((row) => (row.kind === 'group' ? row.group.label : `item:${row.item.id}`)),
    ).toEqual(['mbp-robert', 'item:a', 'item:b', 'no server reporting', 'item:c']);
    expect(rows.every((row) => row.kind !== 'item' || row.depth === 0)).toBe(true);
  });

  it('heads nothing when nothing is grouping', () => {
    const rows = rowsFor([item({ id: id('a') }), item({ id: id('b') })], {
      view: 'list',
      collapsed: new Set(),
    });
    expect(rows.every((row) => row.kind === 'item')).toBe(true);
  });
});

describe('counting what a container holds', () => {
  const project = item({ id: id('p'), kind: PROJECT_KIND });
  const folder = item({ id: id('f'), kind: FOLDER_KIND, parentId: id('p') });
  const one = item({ id: id('s1'), parentId: id('f'), anchor: anchorOf('session-1') });
  const two = item({ id: id('s2'), parentId: id('p'), anchor: anchorOf('session-2') });

  it('counts sessions at every depth under a container', () => {
    const counts = sessionCounts(pages([project, folder, one, two]));
    expect(counts.get(id('p'))).toBe(2);
    expect(counts.get(id('f'))).toBe(1);
  });

  it('counts nothing at all while pages remain', () => {
    // A number that climbs as somebody pages was never counting anything.
    const counts = sessionCounts(pages([project, folder, one], { nextCursor: 'more' }));
    expect(counts.size).toBe(0);
  });
});

describe('how a name is to be drawn', () => {
  it('separates a name the user gave from one that followed a title', () => {
    expect(
      nameStyleOf(item({ id: id('a'), name: 'release work', named: true, nameSource: 'node' })),
    ).toBe('given');
    expect(
      nameStyleOf(item({ id: id('b'), name: 'fix-auth', named: false, nameSource: 'node' })),
    ).toBe('derived');
    expect(nameStyleOf(item({ id: id('c'), nameSource: 'title' }))).toBe('derived');
  });

  it('calls an id an id, which is not a name at all', () => {
    expect(nameStyleOf(item({ id: id('d'), nameSource: 'session-id' }))).toBe('identifier');
    expect(nameStyleOf(item({ id: id('e'), nameSource: 'none' }))).toBe('identifier');
  });
});

describe('why a search hit is here', () => {
  it('says nothing about a name match, and explains the three the row does not show', () => {
    expect(matchWords('name')).toBeNull();
    expect(matchWords(null)).toBeNull();
    expect(matchWords('cwd')).toBe('matched the working directory');
    expect(matchWords('session-id')).toBe('matched the session id');
    expect(matchWords('server')).toBe('matched the machine');
  });
});

describe('the short machine label', () => {
  it('is the first segment when that is enough to read and to tell apart', () => {
    const short = shortMachineLabels(['mbp-robert', 'gpu-box-01']);
    expect(short.get('mbp-robert')).toBe('mbp');
    expect(short.get('gpu-box-01')).toBe('gpu');
  });

  it('takes another segment when one is too short to be a word', () => {
    expect(shortMachineLabels(['ci-eu-1']).get('ci-eu-1')).toBe('ci-eu');
  });

  it('takes another segment when two machines would otherwise share one', () => {
    const short = shortMachineLabels(['build-eu', 'build-us']);
    expect(short.get('build-eu')).toBe('build-eu');
    expect(short.get('build-us')).toBe('build-us');
  });

  it('drops the domain, which says nothing about which machine it is', () => {
    expect(shortMachineLabels(['mbp-robert.local']).get('mbp-robert.local')).toBe('mbp');
  });

  it('keeps the whole label when there is nothing left to shorten it by', () => {
    // Two machines a person named the same thing are that person's ambiguity;
    // inventing a number for one of them would be this client's invention.
    const short = shortMachineLabels(['mbp', 'mbp']);
    expect(short.get('mbp')).toBe('mbp');
    const shared = shortMachineLabels(['eu-1-a', 'eu-1-b', 'eu']);
    expect(shared.get('eu')).toBe('eu');
    expect(shared.get('eu-1-a')).toBe('eu-1-a');
  });

  it('is the label itself when there are no segments to take', () => {
    expect(shortMachineLabels(['.']).get('.')).toBe('.');
  });
});

describe('the kinds a leaf may be', () => {
  it('draws a doc as a leaf, since a document holds nothing to expand into', () => {
    const doc = item({ id: id('d'), kind: DOC_KIND });
    const rows = rowsFor([doc], { view: 'tree', collapsed: new Set() });
    expect(rows[0]?.kind === 'item' && rows[0].expandable).toBe(false);
  });
});

describe('the quiet second line on a row', () => {
  it('labels a session no server is reporting rather than drawing it as live', () => {
    const orphan = item({ id: id('s'), anchor: anchorOf('session-1'), session: null });
    expect(rowNotes(orphan)).toEqual(['no server is reporting this session']);
  });

  it('explains a hit the name does not, and says nothing about a folder', () => {
    expect(rowNotes(item({ id: id('a'), matched: 'cwd' }))).toEqual([
      'matched the working directory',
    ]);
    expect(rowNotes(item({ id: id('f'), kind: FOLDER_KIND }))).toEqual([]);
  });
});

describe('the narrowings the fleet offers', () => {
  const state = stateFrom(hubFrames.machineStatePopulated);

  it('offers the providers and statuses the fleet actually has', () => {
    const options = filterOptions(state);
    expect([...options.providers.map((option) => option.value)].sort()).toEqual([
      'claude',
      'codex',
    ]);
    expect(options.statuses.length).toBeGreaterThan(1);
  });

  it('draws no control at all below two options, and none with no fleet', () => {
    expect(filterOptions(stateFrom(hubFrames.machineStateSingle)).providers).toEqual([]);
    expect(filterOptions(null)).toEqual({ providers: [], statuses: [] });
  });

  it('shortens every machine in the fleet, keyed by the id a session row names', () => {
    const machines = shortMachinesOf(state);
    expect(machines.get('registration-mbp-robert')).toBe('mbp');
    expect(machines.get('registration-gpu-box-01')).toBe('gpu');
  });
});
