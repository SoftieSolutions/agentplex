import { describe, expect, it } from 'vitest';
import {
  nodeIdSchema,
  parseHubFrame,
  parseTextFrame,
  type CatalogueItem,
  type CatalogueQuery,
} from '@agentplex/protocol';
import { type CataloguePage } from '../catalogue/catalogue-model.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createFakeTimers } from '../store/timers.js';
import { GRAPH_KIND } from '../tree/node-kinds.js';
import { PALETTE_KINDS } from './palette-model.js';
import {
  catalogueResults,
  createPaletteSearch,
  PALETTE_SEARCH_DELAY_MS,
  paletteQuery,
  type PaletteSearchHub,
} from './palette-search.js';

/**
 * The pages here are the ones a real hub answered, read back through the
 * client's own parser: `cataloguePage` is a list-view page over the fixture
 * catalogue and holds one session and one document, and `catalogueTreePage`
 * holds a folder and a project as well -- which is how the containers this
 * build cannot address get into a test without anybody writing one.
 */
function pageFrom(text: string): CataloguePage {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'catalogue-page') {
    throw new Error('the captured frame is not a catalogue page');
  }
  const { items, nextCursor, total, version } = parsed.value;
  return { items, nextCursor, total, version };
}

const LEAVES = pageFrom(hubFrames.cataloguePage);
const WITH_CONTAINERS = pageFrom(hubFrames.catalogueTreePage);
const PARTIAL = pageFrom(hubFrames.cataloguePagePartial);

interface Asked {
  readonly query: CatalogueQuery;
  resolve(page: CataloguePage): void;
  reject(reason: string): void;
}

/** The hub as this module sees it: one question out, one answer when told. */
function fakeHub() {
  const asked: Asked[] = [];
  const hub: PaletteSearchHub = {
    queryCatalogueDetached(query: CatalogueQuery): Promise<CataloguePage> {
      return new Promise<CataloguePage>((resolve, reject) => {
        asked.push({ query, resolve, reject: (reason) => reject(new Error(reason)) });
      });
    },
  };
  return { hub, asked };
}

function harness() {
  const h = fakeHub();
  const timers = createFakeTimers();
  const search = createPaletteSearch({ hub: h.hub, timers });
  return { ...h, timers, search };
}

/** Settling a promise is a microtask; the assertions come after it. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('the question the palette asks', () => {
  it('asks for leaves across every store, in one page, for what was typed', () => {
    const query = paletteQuery('auth');

    expect(query.view).toBe('list');
    expect(query.filter.search).toBe('auth');
    expect(query.cursor).toBeNull();
    // No server: a palette is reachable from anywhere and searches the fleet,
    // so a machine narrowing nobody applied must not ride along.
    expect(query.filter.server).toBeUndefined();
    expect(query.filter.project).toBeUndefined();
  });

  it('names the kinds the dialog draws headings for, which is what makes a project findable', () => {
    const query = paletteQuery('agentplex');

    // Exactly the dialog's own list, so a kind drawn under a heading is a kind
    // the hub was asked for: a flat page holds containers only for the kinds
    // the query names (AGX-261), and a project is one of them.
    expect(query.filter.kinds).toEqual([...PALETTE_KINDS]);
    expect(query.filter.kinds).toContain('project');
    // And a graph, since 0017 seeded the kind and this build opens one: a
    // heading with no place in the question would be one nothing draws under.
    expect(query.filter.kinds).toContain('graph');
  });

  it('clamps a query longer than the protocol admits rather than being refused for it', () => {
    const query = paletteQuery('x'.repeat(5_000));

    // The clamp is `withFilter`'s, not a second copy of it: what matters here
    // is that a paste into the field cannot produce a frame the hub refuses.
    expect(query.filter.search?.length).toBeLessThan(5_000);
  });
});

describe('the typing', () => {
  it('asks once for the newest text rather than once per keystroke', () => {
    const h = harness();

    h.search.search('a');
    h.search.search('au');
    h.search.search('auth');
    expect(h.asked).toHaveLength(0);
    expect(h.timers.delays).toEqual([
      PALETTE_SEARCH_DELAY_MS,
      PALETTE_SEARCH_DELAY_MS,
      PALETTE_SEARCH_DELAY_MS,
    ]);

    h.timers.fireAll();
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.query.filter.search).toBe('auth');
  });

  it('asks nothing for an empty box, and forgets what the last question found', async () => {
    const h = harness();
    h.search.search('spike');
    h.timers.fireAll();
    h.asked[0]?.resolve(LEAVES);
    await settled();
    expect(h.search.getSnapshot().results).not.toHaveLength(0);

    h.search.search('   ');

    // An empty box is the absence of a question, not a question that matches
    // everything: a palette that answered it would list the whole catalogue.
    expect(h.asked).toHaveLength(1);
    expect(h.timers.pending).toBe(0);
    expect(h.search.getSnapshot().results).toEqual([]);
    expect(h.search.getSnapshot().searching).toBe(false);
  });

  it('says it is searching while an answer is on its way', () => {
    const h = harness();
    h.search.search('spike');

    // From the keystroke and not from the send: the wait a person feels starts
    // when they type, and the debounce is part of it.
    expect(h.search.getSnapshot().searching).toBe(true);
    h.timers.fireAll();
    expect(h.search.getSnapshot().searching).toBe(true);
  });

  it('drops a question typed and not yet asked when the dialog closes', () => {
    const h = harness();
    h.search.search('spike');
    h.search.reset();

    h.timers.fireAll();
    expect(h.asked).toHaveLength(0);
    expect(h.search.getSnapshot().results).toEqual([]);
    expect(h.search.getSnapshot().searching).toBe(false);
  });
});

describe('the answer', () => {
  it('turns a page into rows the dialog draws and follows', async () => {
    const h = harness();
    h.search.search('spike');
    h.timers.fireAll();
    h.asked[0]?.resolve(LEAVES);
    await settled();

    const { results, searching, problem } = h.search.getSnapshot();
    expect(searching).toBe(false);
    expect(problem).toBeNull();
    expect(results.map((result) => result.kind)).toEqual(['session', 'doc']);
    expect(results[0]).toMatchObject({
      // The id the client-held half mints for the same session, so the dialog
      // deduplicates a session found twice by holding one id rather than by
      // comparing two rows.
      id: 'session:["store-agentplex","session-spike-wasm"]',
      label: 'spike-wasm',
      href: '#/session/store-agentplex/session-spike-wasm',
    });
    expect(results[0]?.detail).toContain('idle');
    expect(results[1]).toMatchObject({
      id: 'doc:hub-6',
      label: 'plan.md',
      href: '#/doc/hub-6',
    });
  });

  it('costs an item this build cannot address itself, and not the listing', () => {
    // A folder is on this page and is not a place this build can go: it is
    // left out and every other item still answers.
    expect(WITH_CONTAINERS.items).toHaveLength(4);
    const results = catalogueResults(WITH_CONTAINERS.items);

    expect(results.map((result) => result.kind)).toEqual(['session', 'project', 'doc']);
  });

  it('turns a project into a row that says which kind it is and goes to the tree', () => {
    const project = catalogueResults(WITH_CONTAINERS.items).find(
      (result) => result.kind === 'project',
    );

    expect(project).toEqual({
      // Namespaced by kind, so a project and a document of one name are two
      // rows and two selections rather than one id twice.
      id: 'project:hub-5',
      kind: 'project',
      // The hub's own display name, through the name-source rules every other
      // row is drawn by: nothing is invented here for a container.
      label: 'agentplex (main checkout)',
      detail: 'Project',
      href: '#/projects',
    });
  });

  it('turns a graph into a row that opens it, rather than dropping it as an unknown kind', () => {
    // A graph is a leaf this build can open, and `resultFor` answers `null`
    // for a kind it has not got a branch for -- so without this branch every
    // graph the hub returned under the Graphs heading would vanish silently.
    const graph: CatalogueItem = {
      id: nodeIdSchema.parse('hub-10'),
      parentId: nodeIdSchema.parse('hub-5'),
      kind: GRAPH_KIND,
      position: 2,
      name: 'release-pipeline',
      named: true,
      anchor: null,
      depth: 1,
      displayName: 'release-pipeline',
      nameSource: 'node',
      session: null,
      directory: null,
      server: null,
      group: null,
      matched: null,
    };

    expect(catalogueResults([graph])).toEqual([
      {
        id: 'graph:hub-10',
        kind: 'graph',
        label: 'release-pipeline',
        detail: 'Graph',
        href: '#/graph/hub-10',
      },
    ]);
  });

  it('says there may be more when the hub had more to give', async () => {
    const h = harness();
    h.search.search('e');
    h.timers.fireAll();
    h.asked[0]?.resolve(PARTIAL);
    await settled();
    expect(h.search.getSnapshot().more).toBe(true);

    h.search.search('spike');
    h.timers.fireAll();
    h.asked[1]?.resolve(LEAVES);
    await settled();
    expect(h.search.getSnapshot().more).toBe(false);
  });

  it('discards a page answering a question the typing has moved past', async () => {
    const h = harness();
    h.search.search('e');
    h.timers.fireAll();
    h.search.search('spike');
    h.timers.fireAll();
    expect(h.asked).toHaveLength(2);

    // The older question answers last, which is the case this exists for: its
    // rows describe text nobody has in the field any more.
    h.asked[1]?.resolve(LEAVES);
    h.asked[0]?.resolve(PARTIAL);
    await settled();

    const { results, searching } = h.search.getSnapshot();
    expect(results.map((result) => result.label)).toEqual(['spike-wasm', 'plan.md']);
    expect(searching).toBe(false);
  });

  it('says why when the hub refuses, and keeps no rows that answered an older question', async () => {
    const h = harness();
    h.search.search('spike');
    h.timers.fireAll();
    h.asked[0]?.resolve(LEAVES);
    await settled();

    h.search.search('spike-w');
    h.timers.fireAll();
    h.asked[1]?.reject('the connection is down: a catalogue page is a read of now');
    await settled();

    const { results, searching, problem } = h.search.getSnapshot();
    expect(searching).toBe(false);
    expect(problem).toMatch(/the connection is down/);
    // Rows that matched "spike" are not an answer to "spike-w", and showing
    // them under a failure would claim the hub answered.
    expect(results).toEqual([]);
  });

  it('discards a refusal to a question the typing has moved past', async () => {
    const h = harness();
    h.search.search('e');
    h.timers.fireAll();
    h.search.search('spike');
    h.timers.fireAll();

    h.asked[1]?.resolve(LEAVES);
    h.asked[0]?.reject('that cursor is stale');
    await settled();

    expect(h.search.getSnapshot().problem).toBeNull();
    expect(h.search.getSnapshot().results).toHaveLength(2);
  });

  it('tells a subscriber every time the answer moves', async () => {
    const h = harness();
    let notifications = 0;
    const unsubscribe = h.search.subscribe(() => {
      notifications += 1;
    });

    h.search.search('spike');
    h.timers.fireAll();
    h.asked[0]?.resolve(LEAVES);
    await settled();
    unsubscribe();

    // The keystroke and the answer: a `useSyncExternalStore` that heard only
    // the second would draw a dialog that never says it is searching.
    expect(notifications).toBe(2);
    h.search.reset();
    expect(notifications).toBe(2);
  });
});
