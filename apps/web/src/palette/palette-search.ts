import type { CatalogueItem, CatalogueQuery } from '@agentplex/protocol';
import {
  queryFor,
  withFilter,
  type CataloguePage,
  type CatalogueShape,
} from '../catalogue/catalogue-model.js';
import { docHash } from '../docs/doc-route.js';
import { statusWords } from '../sessions/session-list-model.js';
import { sessionHash } from '../terminal/session-route.js';
import { browserTimers, type Timers } from '../store/timers.js';
import { destinationHash } from '../shell/destinations.js';
import { DOC_KIND, PROJECT_KIND, SESSION_KIND } from '../tree/node-kinds.js';
import { PALETTE_KINDS, type PaletteResult } from './palette-model.js';

/**
 * The half of the palette the hub answers.
 *
 * `palette-model.ts` argues the split: sessions are in the browser already, so
 * `sessionResults` computes them from state and this asks the hub for
 * everything else. The question is a catalogue query -- the same frame the tree
 * panel sends, with `filter.search` set -- because the hub is the only thing
 * that holds the whole catalogue. Searching what the browser happens to have
 * paged in would answer differently depending on what you looked at earlier,
 * which is the failure AGX-140 exists to avoid.
 *
 * ## What comes back, and what cannot
 *
 * The query asks for `view: 'list'`, which keeps leaves only -- a project or a
 * folder cannot appear in one however well its name matches -- unless the
 * filter names the kinds it wants. It names them: `PALETTE_KINDS`, which is
 * the dialog's own heading list, so a session, a document and a project can
 * each come back and each has a heading to come back under. A folder is not on
 * that list and so never reaches the page, which is the point of asking by
 * kind rather than for containers in general: a folder the hub returned would
 * be a row dropped below, after the page had been bounded around it.
 *
 * A graph is not on the list either, because the kind is unseeded until
 * AGX-144. A selection naming an unseeded kind matches nothing and is refused
 * by nothing, so the day the migration lands the kind joins `HEADINGS` in
 * `palette-model.ts` and this file changes not at all.
 *
 * It is one page and never paged. A palette is a short list by construction
 * (`PALETTE_RESULT_LIMIT`); past that, the answer is more typing rather than
 * more rows, and `more` below is what lets the dialog say so without claiming
 * a count it would have to stand behind.
 *
 * ## The two hard parts, borrowed rather than reinvented
 *
 * The debounce and the stale-discard are `catalogue-store.ts`'s, in the same
 * shape: a trailing timer off the injected `Timers` so a burst of typing is
 * one query, and a generation counter so an answer to the text before the last
 * keystroke is dropped instead of drawn. Two answers arriving out of order is
 * not an edge case here -- it is what typing does -- and a second opinion about
 * how to handle it would be a second way for the two halves of this feature to
 * disagree.
 *
 * The hub is asked through `queryCatalogueDetached`, which is the other half of
 * the same concern: there is one catalogue channel in the hub store, the tree
 * panel is drawing it, and a palette that asked through `queryCatalogue` would
 * replace that panel's rows on the first keystroke and make the next
 * `catalogue-changed` re-ask what was typed in a dialog.
 *
 * ## Degrading
 *
 * An item this build cannot address is dropped and the rest of the page still
 * answers; a refusal costs this half and not the palette, whose client-held
 * sessions are computed elsewhere and never pass through here. What a refusal
 * does cost is the rows before it: they answered an older question, and
 * leaving them under a failure would present them as the answer to what is in
 * the field now.
 */

/**
 * How long a burst of typing settles before one query goes out.
 *
 * `catalogue-store.ts`'s number, deliberately the same: the two search boxes
 * are on one screen, and one settling faster than the other would read as one
 * of them being broken.
 */
export const PALETTE_SEARCH_DELAY_MS = 250;

/**
 * The question, minus the text: a flat list of the kinds the dialog draws, in
 * name order.
 *
 * `groupBy: 'none'` because the dialog groups by kind and a hub-side grouping
 * it does not draw is a field nothing reads. Name order because it is the one
 * order a person typing a name can predict, and because this re-orders nothing
 * the hub sent -- the ranking question the ticket leaves open is the hub's to
 * answer, not this file's to invent a score for.
 *
 * `kinds` is `PALETTE_KINDS` and not a second list of the same words: the
 * dialog's headings and the hub's selection are one list in `palette-model.ts`
 * for the reason written there.
 */
const PALETTE_SHAPE: CatalogueShape = {
  view: 'list',
  groupBy: 'none',
  sort: { key: 'name', direction: 'asc' },
  // Copied rather than shared: the filter schema's list is a mutable array,
  // and one shape read by every query must not be a list a caller could push
  // a kind onto.
  filter: { kinds: [...PALETTE_KINDS] },
};

/**
 * The frame this sends, for what was typed.
 *
 * Built through `withFilter` rather than by writing a filter out here, so the
 * clamp to `CATALOGUE_SEARCH_MAX_CHARS` and the rule that an empty box is no
 * constraint are the catalogue's own and not a second copy of them. No
 * `server`: the palette is reachable from a screen that has a machine selected
 * and searches the fleet regardless, so a narrowing nobody applied to it must
 * not ride along.
 */
export function paletteQuery(text: string): CatalogueQuery {
  return queryFor(withFilter(PALETTE_SHAPE, { field: 'search', value: text }), null);
}

/** The slice of the hub store this needs; `HubStore` satisfies it. */
export interface PaletteSearchHub {
  queryCatalogueDetached(query: CatalogueQuery): Promise<CataloguePage>;
}

export interface PaletteSearchSnapshot {
  /** The hub-answered rows, in the order the hub gave them. */
  readonly results: readonly PaletteResult[];
  /** A question is typed and its answer has not arrived. */
  readonly searching: boolean;
  /**
   * The hub had more than one page of matches.
   *
   * A flag and not a count, because the count the page carries is a count of
   * items and these are rows: the items this build cannot address are dropped
   * on the way, so "40 matches" beside eight drawable rows would be a number
   * nothing on screen adds up to.
   */
  readonly more: boolean;
  /** Why there is no answer, in the hub's words, or `null`. */
  readonly problem: string | null;
}

export interface PaletteSearch {
  subscribe(listener: () => void): () => void;
  getSnapshot(): PaletteSearchSnapshot;
  /** What is in the field now. Debounced; the newest text wins. */
  search(text: string): void;
  /** The dialog closed: forget the question, the answer and anything in flight. */
  reset(): void;
}

export interface PaletteSearchDependencies {
  readonly hub: PaletteSearchHub;
  readonly timers?: Timers;
  readonly searchDelayMs?: number;
}

const NOTHING: PaletteSearchSnapshot = {
  results: [],
  searching: false,
  more: false,
  problem: null,
};

export function createPaletteSearch(dependencies: PaletteSearchDependencies): PaletteSearch {
  const { hub } = dependencies;
  const timers = dependencies.timers ?? browserTimers;
  const searchDelayMs = dependencies.searchDelayMs ?? PALETTE_SEARCH_DELAY_MS;
  const listeners = new Set<() => void>();

  let snapshot: PaletteSearchSnapshot = NOTHING;
  /**
   * Which question the answers in flight belong to.
   *
   * Every keystroke moves it, so an answer minted for the text before the last
   * one is discarded rather than drawn: the palette is typed into fast enough
   * that two queries are routinely in flight, and the hub answers whichever it
   * finishes first.
   */
  let generation = 0;
  /** A question typed but not yet asked. Trailing, so the newest one wins. */
  let cancelPending: (() => void) | null = null;

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  function update(changes: Partial<PaletteSearchSnapshot>): void {
    snapshot = { ...snapshot, ...changes };
    notify();
  }

  /** Everything in flight stops counting, and nothing typed is still waiting. */
  function abandon(): void {
    generation += 1;
    cancelPending?.();
    cancelPending = null;
  }

  function ask(text: string): void {
    const asked = generation;
    hub.queryCatalogueDetached(paletteQuery(text)).then(
      (page) => {
        if (asked !== generation) return;
        update({
          results: catalogueResults(page.items),
          searching: false,
          more: page.nextCursor !== null,
          problem: null,
        });
      },
      (error: unknown) => {
        if (asked !== generation) return;
        update({ results: [], searching: false, more: false, problem: describe(error) });
      },
    );
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    getSnapshot(): PaletteSearchSnapshot {
      return snapshot;
    },

    search(text: string): void {
      abandon();
      if (withFilter(PALETTE_SHAPE, { field: 'search', value: text }).filter.search === undefined) {
        // The empty box, by the catalogue's own rule for one. There is no
        // question to ask, and the rows from the last one are not an answer to
        // having deleted it.
        update({ ...NOTHING });
        return;
      }
      // The rows already held stay while the next answer is on its way, the way
      // the catalogue's list keeps its rows through a keystroke: a dialog that
      // blanked on every character would flicker through a typed word.
      update({ searching: true, problem: null });
      const asked = generation;
      cancelPending = timers.schedule(searchDelayMs, () => {
        cancelPending = null;
        if (asked !== generation) return;
        ask(text);
      });
    },

    reset(): void {
      abandon();
      snapshot = NOTHING;
    },
  };
}

/**
 * The rows a page yields, dropping every item this build cannot address.
 *
 * Exported and pure, because it is the part worth testing against a captured
 * page: what a session row says, what a document row says, and that a folder
 * or a project on the page costs itself rather than the answer.
 */
export function catalogueResults(items: readonly CatalogueItem[]): readonly PaletteResult[] {
  const results: PaletteResult[] = [];
  for (const item of items) {
    const result = resultFor(item);
    if (result !== null) results.push(result);
  }
  return results;
}

/**
 * One row, or `null` for an item there is nowhere to send a person.
 *
 * Three ways an item has no address: it is a folder -- a container the query
 * did not ask for, which a caller handing this a tree page can still produce
 * -- it is a kind this build has never heard of, which `node-kinds.ts` argues
 * is possible and not a bug, or it is a session node whose `anchor` is `null`,
 * which is a node pointing at nothing rather than a session that is merely
 * unreachable.
 */
function resultFor(item: CatalogueItem): PaletteResult | null {
  if (item.kind === SESSION_KIND) {
    const { anchor } = item;
    if (anchor === null) return null;
    return {
      // `session-list-model.ts`'s key, so a session the client also holds
      // arrives here under the id the client-held half already gave it and the
      // dialog can drop the duplicate by id.
      id: `session:${JSON.stringify([anchor.storeId, anchor.sessionId])}`,
      // The item's own kind, which `SESSION_KIND` is what it was matched
      // against: a row carries the hub's string rather than a second spelling
      // of it, so the dialog's heading for a kind is the kind the hub named.
      kind: item.kind,
      label: item.displayName,
      detail: sessionDetail(item, anchor.storeId),
      href: sessionHash(anchor),
    };
  }
  if (item.kind === DOC_KIND) {
    return {
      id: `doc:${item.id}`,
      kind: item.kind,
      label: item.displayName,
      // The kind, because that is what this build knows about a document on a
      // page: `CatalogueItem.server` is on the frame and answered `null` here
      // until the catalogue query joins the docs index, and the parent is a
      // node id rather than a name. A row saying "Document" is the honest
      // second line; one naming a machine would be one this made up.
      detail: 'Document',
      href: docHash(item.id),
    };
  }
  if (item.kind === PROJECT_KIND) {
    return {
      id: `project:${item.id}`,
      kind: item.kind,
      label: item.displayName,
      // The kind, for the reason a document says its kind: a project node
      // carries no server, no session and no directory of its own on a
      // catalogue item, so the honest second line is what it is. The heading
      // says the same word, and deliberately: a row torn out of its group --
      // read aloud, or glanced at beside a session of the same name -- still
      // says which of the two it is.
      detail: 'Project',
      // Where a project is, which is the tree, by the address the app already
      // has for it: the phone's Projects tab and the sidebar's own reading of
      // the same catalogue. Deliberately not a node-level address invented
      // here. This app addresses exactly two nodes -- a session and a document
      // -- and both are addresses of a thing that opens in a pane; a project
      // opens nothing. An address that named the node would have to be one the
      // tree honours by revealing and selecting it, and no screen does that
      // yet, so minting `#/node/<id>` here would be a link that parses and
      // goes nowhere in particular. Sending a person to the tree is the small
      // true answer; revealing the node in it is a ticket of its own.
      href: destinationHash('projects'),
    };
  }
  return null;
}

/**
 * The second line of a session row: where it is, and what it is doing.
 *
 * Thinner than the client-held half's, which names the machine as well, and
 * deliberately so: `groupBy` is `'none'` here, so the page carries no group to
 * read a machine label off. In practice the client holds the fleet and the
 * dialog keeps its own richer row for a session found in both halves; what
 * this has to be is true, which is why a session no server is reporting says
 * that rather than borrowing a status from nowhere.
 */
function sessionDetail(item: CatalogueItem, storeId: string): string {
  const row = item.session;
  const state =
    row === null ? 'no server is reporting this session' : statusWords(row.descriptor.status);
  return `${storeId} · ${state}`;
}

/** The hub's own sentence where there is one, and never an `[object Object]`. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
