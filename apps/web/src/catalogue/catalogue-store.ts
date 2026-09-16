import type { CatalogueQuery } from '@agentplex/protocol';
import { browserTimers, type Timers } from '../store/timers.js';
import {
  DEFAULT_SHAPE,
  NO_PAGES,
  pageAdopted,
  queryFor,
  STALE_PAGE_NOTICE,
  type CataloguePage,
  type CataloguePages,
  type CatalogueShape,
} from './catalogue-model.js';

/**
 * The catalogue as a screen lives with it: an external store, read through
 * `useSyncExternalStore` and never through an effect.
 *
 * The question is asked because something is looking, which is why this is a
 * store and not a hook with an effect in it: the first subscriber declares the
 * interest and asks the first page, and the last one leaving takes the
 * interest away. A screen that is not drawing the catalogue costs the hub
 * nothing, and nothing here re-runs because a dependency array churned.
 *
 * Three ways a page arrives, and telling them apart is most of this file:
 *
 *   * this store asked for the first page of a question -- at mount, or
 *     because a control changed. It replaces what is held;
 *   * this store asked for the next page. It appends;
 *   * nobody asked. `catalogue-changed` arrived, and the hub store re-issued
 *     the last question from the top on its own account, so the page lands in
 *     the hub snapshot with no promise waiting on it. It replaces what is
 *     held, and the rows are not cleared first: the view keeps its scroll
 *     position and its expansion because the list it is scrolled through is
 *     still there, re-keyed by node id, rather than being blanked and redrawn.
 *
 * A refused page is the fourth thing, and the one worth reading twice. The hub
 * refuses a cursor minted before a change, by design; all this can honestly do
 * is ask the question again from the top and say, once, that it did.
 */

/** The slice of the hub store this needs; `HubStore` satisfies it. */
export interface CatalogueHub {
  subscribe(listener: () => void): () => void;
  getSnapshot(): { readonly catalogue: CataloguePage | null };
  /** Standing interest, so a change re-issues the last question. */
  subscribeCatalogue(): () => void;
  queryCatalogue(query: CatalogueQuery): Promise<CataloguePage>;
}

export interface CatalogueSnapshot {
  /** The question, as the controls have it. */
  readonly shape: CatalogueShape;
  /** The answer, as far as it has been paged. */
  readonly pages: CataloguePages;
  /** A page is in flight. The rows already held stay on screen while it is. */
  readonly loading: boolean;
  /** The one-line explanation of a page that was refused, or `null`. */
  readonly notice: string | null;
  /** Why there is no answer, in the hub's words or the store's, or `null`. */
  readonly problem: string | null;
}

export interface CatalogueStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): CatalogueSnapshot;
  /**
   * A control moved: the question changed, and it is asked from the top.
   *
   * `when` is `'settled'` for the search box and `'now'` for everything else,
   * and the difference is what a keystroke costs. A select is one act and its
   * answer is wanted immediately; typing "auth" is four acts that mean one
   * question, and a frame per keystroke would be four queries the hub sorts
   * its whole catalogue for, three of whose answers are already stale when
   * they arrive. The shape itself moves at once either way -- the box holds
   * what was typed -- so what is debounced is the asking and never the typing.
   */
  reshape(shape: CatalogueShape, when?: 'now' | 'settled'): void;
  /** "Load more": the next page of the same question, appended. */
  loadMore(): void;
}

export interface CatalogueStoreDependencies {
  readonly hub: CatalogueHub;
  /** Where the controls start. Injected so a test can begin in the list view. */
  readonly shape?: CatalogueShape;
  readonly timers?: Timers;
  /** How long a burst of typing settles before one query goes out. */
  readonly searchDelayMs?: number;
}

/**
 * Long enough that a word typed at speed is one query, short enough that the
 * pause at the end of one is not felt as a wait.
 */
const DEFAULT_SEARCH_DELAY_MS = 250;

export function createCatalogueStore(dependencies: CatalogueStoreDependencies): CatalogueStore {
  const { hub } = dependencies;
  const timers = dependencies.timers ?? browserTimers;
  const searchDelayMs = dependencies.searchDelayMs ?? DEFAULT_SEARCH_DELAY_MS;
  const listeners = new Set<() => void>();

  let snapshot: CatalogueSnapshot = {
    shape: dependencies.shape ?? DEFAULT_SHAPE,
    pages: NO_PAGES,
    loading: false,
    notice: null,
    problem: null,
  };

  /**
   * Which question the answers in flight belong to.
   *
   * A control moved while a page was on its way is the case this exists for:
   * the page that arrives is an answer to the question before the change, and
   * appending or even showing it would put rows on screen that the controls no
   * longer describe.
   */
  let generation = 0;
  let inFlight = 0;
  /** The last page seen on the hub snapshot, so an unasked-for one is noticed. */
  let seen: CataloguePage | null = null;
  /** A question typed but not yet asked. Trailing, so the newest one wins. */
  let cancelPending: (() => void) | null = null;

  let detachHub: (() => void) | null = null;
  let detachInterest: (() => void) | null = null;

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  function update(changes: Partial<CatalogueSnapshot>): void {
    snapshot = { ...snapshot, ...changes };
    notify();
  }

  function ask(cursor: string | null, mode: 'replace' | 'append'): void {
    const asked = generation;
    inFlight += 1;
    update({ loading: true });
    hub.queryCatalogue(queryFor(snapshot.shape, cursor)).then(
      (page) => {
        inFlight -= 1;
        seen = page;
        if (asked !== generation) return;
        update({
          pages: pageAdopted(snapshot.pages, page, mode),
          loading: inFlight > 0,
          problem: null,
        });
      },
      (error: unknown) => {
        inFlight -= 1;
        if (asked !== generation) return;
        if (cursor !== null) {
          // The hub refused a position in an order that has moved. Every
          // refusal a cursor can draw has the same remedy, so this does not
          // read the sentence to decide what to do about it.
          update({ loading: inFlight > 0, notice: STALE_PAGE_NOTICE });
          ask(null, 'replace');
          return;
        }
        update({ loading: inFlight > 0, problem: describe(error) });
      },
    );
  }

  /**
   * A page landed in the hub snapshot that this store did not ask for.
   *
   * That is the hub store re-issuing the last question after
   * `catalogue-changed` or after a reconnection, which is standing interest
   * working as designed: it asks from the top, so what arrives replaces what
   * is held. Anything arriving while this store has a query of its own in
   * flight is left to that query's own promise, which is the caller that is
   * actually waiting for it.
   */
  function onHubChange(): void {
    const page = hub.getSnapshot().catalogue;
    if (page === seen) return;
    seen = page;
    if (page === null || inFlight > 0) return;
    update({ pages: pageAdopted(snapshot.pages, page, 'replace'), problem: null });
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) {
        detachInterest = hub.subscribeCatalogue();
        detachHub = hub.subscribe(onHubChange);
        // The hub store sends nothing when interest is declared, because until
        // now it has no question: a query carries a view, a sort and a filter
        // that only a screen knows. This is the screen, so this is the ask.
        ask(null, 'replace');
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
        if (listeners.size === 0) {
          // Nothing is looking: answers still in flight belong to a screen
          // that has gone, and the interest goes with it. A question typed and
          // not yet asked leaves with the screen too -- unlike a layout save,
          // which is something the user did and this is something they were
          // about to look at.
          generation += 1;
          cancelPending?.();
          cancelPending = null;
          detachHub?.();
          detachHub = null;
          detachInterest?.();
          detachInterest = null;
        }
      };
    },

    getSnapshot(): CatalogueSnapshot {
      return snapshot;
    },

    reshape(shape: CatalogueShape, when: 'now' | 'settled' = 'now'): void {
      generation += 1;
      cancelPending?.();
      cancelPending = null;
      // The rows already held stay until the answer arrives. A control change
      // that blanked the list would throw away the scroll position on every
      // keystroke into the search box.
      update({ shape, notice: null });
      if (listeners.size === 0) return;
      if (when === 'settled') {
        cancelPending = timers.schedule(searchDelayMs, () => {
          cancelPending = null;
          ask(null, 'replace');
        });
        return;
      }
      ask(null, 'replace');
    },

    loadMore(): void {
      const cursor = snapshot.pages.nextCursor;
      // Not while a typed question is waiting to be asked: that cursor is a
      // position in the answer to the question on screen, which is about to
      // stop being the one asked.
      if (cursor === null || snapshot.loading || cancelPending !== null) return;
      update({ notice: null });
      ask(cursor, 'append');
    },
  };
}

/** The hub's own sentence where there is one, and never an `[object Object]`. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
