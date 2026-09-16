import { describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame, type CatalogueQuery } from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createFakeTimers } from '../store/timers.js';
import {
  CATALOGUE_PAGE_LIMIT,
  DEFAULT_SHAPE,
  STALE_PAGE_NOTICE,
  withFilter,
  withView,
  type CataloguePage,
} from './catalogue-model.js';
import { createCatalogueStore, type CatalogueHub } from './catalogue-store.js';

/**
 * The pages here are the ones a real hub answered, read back through the
 * client's own parser: `catalogueTreePagePartial` and `catalogueTreePage` are
 * the two halves of one tree, captured by driving the hub over a websocket
 * (tests/hub-server/src/capture-client-fixtures.test.ts). What is under test is
 * the paging, and paging over a hand-written cursor would be paging over the
 * author's idea of one.
 */
function pageFrom(text: string): CataloguePage {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'catalogue-page') {
    throw new Error('the captured frame is not a catalogue page');
  }
  const { items, nextCursor, total, version } = parsed.value;
  return { items, nextCursor, total, version };
}

const FIRST = pageFrom(hubFrames.catalogueTreePagePartial);
const REST = pageFrom(hubFrames.catalogueTreePage);
const LIST = pageFrom(hubFrames.cataloguePage);

interface Asked {
  readonly query: CatalogueQuery;
  resolve(page: CataloguePage): void;
  reject(reason: string): void;
}

/**
 * The hub as this store sees it: questions go out, answers come back when the
 * test says so, and a page can also land in the snapshot with nobody waiting
 * on it -- which is what `catalogue-changed` makes the hub store do.
 */
function fakeHub() {
  const asked: Asked[] = [];
  const listeners = new Set<() => void>();
  let interest = 0;
  let answered: CataloguePage | null = null;

  const hub: CatalogueHub = {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => ({ catalogue: answered }),
    subscribeCatalogue(): () => void {
      interest += 1;
      return () => {
        interest -= 1;
      };
    },
    queryCatalogue(query: CatalogueQuery): Promise<CataloguePage> {
      return new Promise<CataloguePage>((resolve, reject) => {
        asked.push({
          query,
          resolve: (page) => {
            // The hub store lands every page in its snapshot as well as
            // answering the caller, and in that order.
            answered = page;
            for (const listener of [...listeners]) listener();
            resolve(page);
          },
          reject: (reason) => reject(new Error(reason)),
        });
      });
    },
  };

  return {
    hub,
    asked,
    interest: () => interest,
    /** A page nobody asked for: the hub store re-issued the last question. */
    unasked(page: CataloguePage): void {
      answered = page;
      for (const listener of [...listeners]) listener();
    },
  };
}

function harness(shape = DEFAULT_SHAPE) {
  const h = fakeHub();
  const timers = createFakeTimers();
  const store = createCatalogueStore({ hub: h.hub, shape, timers, searchDelayMs: 250 });
  const unsubscribe = store.subscribe(() => {});
  return { ...h, timers, store, unsubscribe };
}

/** Settling a promise is a microtask; the assertions come after it. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('asking the first page', () => {
  it('asks because something is looking, with the limit from the named constant', () => {
    const h = harness();
    expect(h.interest()).toBe(1);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.query).toEqual({
      view: 'tree',
      groupBy: 'none',
      sort: { key: 'name', direction: 'asc' },
      filter: {},
      cursor: null,
      limit: CATALOGUE_PAGE_LIMIT,
    });
    expect(h.store.getSnapshot().loading).toBe(true);
  });

  it('holds what the hub answered, rows and count alike', async () => {
    const h = harness();
    h.asked[0]?.resolve(FIRST);
    await settled();

    const { pages, loading } = h.store.getSnapshot();
    expect(loading).toBe(false);
    expect(pages.answered).toBe(true);
    expect(pages.items).toHaveLength(FIRST.items.length);
    expect(pages.total).toBe(FIRST.total);
    expect(pages.nextCursor).toBe(FIRST.nextCursor);
  });

  it('takes the interest away with the last subscriber', () => {
    const h = harness();
    h.unsubscribe();
    expect(h.interest()).toBe(0);
  });
});

describe('the next page', () => {
  it('carries the cursor the hub handed back and appends what comes of it', async () => {
    const h = harness();
    h.asked[0]?.resolve(FIRST);
    await settled();

    h.store.loadMore();
    expect(h.asked[1]?.query.cursor).toBe(FIRST.nextCursor);
    h.asked[1]?.resolve(REST);
    await settled();

    const { pages } = h.store.getSnapshot();
    expect(pages.items).toHaveLength(FIRST.items.length + REST.items.length);
    // The hub said the answer ends here, so nothing asks again.
    expect(pages.nextCursor).toBeNull();
    h.store.loadMore();
    expect(h.asked).toHaveLength(2);
  });

  it('asks nothing while a page is already in flight', async () => {
    const h = harness();
    h.asked[0]?.resolve(FIRST);
    await settled();
    h.store.loadMore();
    h.store.loadMore();
    expect(h.asked).toHaveLength(2);
  });
});

describe('a cursor the hub refuses', () => {
  it('says so once and shows the answer from the top again', async () => {
    const h = harness();
    h.asked[0]?.resolve(FIRST);
    await settled();
    h.store.loadMore();

    h.asked[1]?.reject('that cursor is stale: ask for the first page again');
    await settled();

    expect(h.store.getSnapshot().notice).toBe(STALE_PAGE_NOTICE);
    // From the top: a position in an order that has moved means nothing in the
    // new one, whichever of the three refusals it was.
    expect(h.asked[2]?.query.cursor).toBeNull();

    h.asked[2]?.resolve(FIRST);
    await settled();
    expect(h.store.getSnapshot().pages.items).toHaveLength(FIRST.items.length);

    // Said once: the next thing the person does clears it.
    h.store.loadMore();
    expect(h.store.getSnapshot().notice).toBeNull();
  });

  it('keeps a refused first page as a problem rather than a loop', async () => {
    const h = harness();
    h.asked[0]?.reject('the connection is down: a catalogue page is a read of now');
    await settled();

    expect(h.store.getSnapshot().problem).toMatch(/connection is down/);
    // Nothing is retried here. The hub store remembers the question and asks it
    // again when the socket is back, and that answer arrives unasked-for.
    expect(h.asked).toHaveLength(1);
  });
});

describe('a control that moves', () => {
  it('asks the new question from the top and keeps the rows until it is answered', async () => {
    const h = harness();
    h.asked[0]?.resolve(FIRST);
    await settled();

    h.store.reshape(withView(DEFAULT_SHAPE, 'list'));
    expect(h.asked[1]?.query).toMatchObject({ view: 'list', cursor: null });
    // Not blanked: a list that emptied on every keystroke into the search box
    // would throw away the scroll position with it.
    expect(h.store.getSnapshot().pages.items).toHaveLength(FIRST.items.length);

    h.asked[1]?.resolve(LIST);
    await settled();
    expect(h.store.getSnapshot().pages.items).toHaveLength(LIST.items.length);
  });

  it('drops an answer to the question the controls no longer describe', async () => {
    const h = harness();
    h.asked[0]?.resolve(FIRST);
    await settled();
    h.store.loadMore();

    h.store.reshape(withView(DEFAULT_SHAPE, 'list'));
    // The load-more answers late, to the tree question nobody is asking now.
    h.asked[1]?.resolve(REST);
    await settled();
    expect(h.store.getSnapshot().pages.items).toHaveLength(FIRST.items.length);

    h.asked[2]?.resolve(LIST);
    await settled();
    expect(h.store.getSnapshot().pages.items).toHaveLength(LIST.items.length);
  });
});

describe('a page nobody asked for', () => {
  it('replaces what is held, because the hub re-issued the question from the top', async () => {
    const h = harness();
    h.asked[0]?.resolve(FIRST);
    await settled();
    h.store.loadMore();
    h.asked[1]?.resolve(REST);
    await settled();
    expect(h.store.getSnapshot().pages.items).toHaveLength(FIRST.items.length + REST.items.length);

    // `catalogue-changed` arrived: the hub store asked the last question again,
    // from the first page, and the answer landed in its snapshot.
    h.unasked(FIRST);
    expect(h.store.getSnapshot().pages.items).toHaveLength(FIRST.items.length);
    expect(h.asked).toHaveLength(2);
  });

  it('leaves a page this store is waiting on to its own promise', async () => {
    const h = harness();
    h.asked[0]?.resolve(FIRST);
    await settled();
    h.store.loadMore();
    // Resolving the load-more lands it in the hub snapshot first and answers
    // the caller second; the snapshot listener must not read it as unasked-for
    // and replace the very rows the append is adding to.
    h.asked[1]?.resolve(REST);
    await settled();
    expect(h.store.getSnapshot().pages.items).toHaveLength(FIRST.items.length + REST.items.length);
  });
});

describe('a question that is typed', () => {
  it('moves the box at once and asks once, when the typing settles', async () => {
    const h = harness();
    h.asked[0]?.resolve(FIRST);
    await settled();

    for (const typed of ['a', 'au', 'aut', 'auth']) {
      h.store.reshape(
        withFilter(h.store.getSnapshot().shape, { field: 'search', value: typed }),
        'settled',
      );
      // Whatever was typed is on the controls immediately: the debounce is on
      // the asking, never on the typing.
      expect(h.store.getSnapshot().shape.filter.search).toBe(typed);
    }
    expect(h.asked).toHaveLength(1);

    h.timers.fireAll();
    expect(h.asked).toHaveLength(2);
    expect(h.asked[1]?.query.filter.search).toBe('auth');
  });

  it('asks nothing more once the screen has gone', async () => {
    const h = harness();
    h.asked[0]?.resolve(FIRST);
    await settled();
    h.store.reshape(withFilter(DEFAULT_SHAPE, { field: 'search', value: 'auth' }), 'settled');

    h.unsubscribe();
    h.timers.fireAll();
    expect(h.asked).toHaveLength(1);
  });

  it('does not page an answer that is about to stop being the question', async () => {
    const h = harness();
    h.asked[0]?.resolve(FIRST);
    await settled();
    h.store.reshape(withFilter(DEFAULT_SHAPE, { field: 'search', value: 'auth' }), 'settled');

    h.store.loadMore();
    expect(h.asked).toHaveLength(1);
  });
});
