import {
  matchesSearch,
  orderByActivity,
  partitionNeedsYou,
  statusWords,
  type SessionListItem,
} from '../sessions/session-list-model.js';
import { sessionHash } from '../terminal/session-route.js';

/**
 * The command palette's model, and why it is a second search control rather
 * than the one the session list already has.
 *
 * The desktop mockups draw both at once, deliberately. The list's field
 * (AGX-32) narrows a list you are already looking at: it is scoped to that
 * screen, it leaves the rows in place, and its whole result is that fewer of
 * them are drawn. The palette is the opposite motion. It is reachable from
 * anywhere -- from a terminal pane, from Settings, from a screen with no list
 * on it at all -- it searches across kinds rather than within one list, and it
 * ends by going somewhere. Narrowing versus jumping; a filter's answer is a
 * shorter list, a palette's answer is one address.
 *
 * The instinct is to unify them, and unifying them costs both: the filter
 * would have to leave the screen it narrows, and the palette would have to
 * inherit a narrowing nobody applied with jumping in mind. So the palette is
 * handed the whole fleet, never `visibleSessions`, and the two controls share
 * exactly one thing -- `matchesSearch` -- because a person who found a session
 * by typing part of its path into one field should find it by typing the same
 * thing into the other. One matcher, two motions.
 *
 * What is shared is the matcher and not the pipeline: `sessionResults` below
 * takes items, not `MachineState` and filters, so there is no seam through
 * which the list's chip or machine selection can reach the palette.
 *
 * ## Shaped for AGX-140
 *
 * Today every result is a session the client already holds, so the whole list
 * is computed synchronously from state in the browser. AGX-140 adds results
 * the hub answers -- other kinds, arriving later and out of a query -- and the
 * dialog must not change shape for that. Hence `PaletteResult` carries no
 * session in it: a result is a kind, a label, a second line and an href, which
 * is all a row needs to be drawn and followed, and every kind can produce one.
 * `sessionResults` builds the client-held half, a later `catalogueResults`
 * builds the hub-answered half, and `paletteListing` takes the concatenation
 * without knowing what is in it. It re-orders nothing, so the caller decides
 * which kind leads; the ids are namespaced by kind so two halves assembled
 * from different sources cannot collide on one.
 */

/**
 * What a result points at. One member today, and a union rather than a string
 * so the day AGX-140 adds `doc` the dialog's switch over kinds fails to
 * compile until it says what a doc row looks like.
 */
export type PaletteResultKind = 'session';

/** One row of the palette, as the dialog draws and follows it. */
export interface PaletteResult {
  /**
   * The selection token and the render key, namespaced by kind.
   *
   * Keyboard movement is over ids rather than indices because the list is
   * rebuilt under the selection on every keystroke, and an index means a
   * different row after each one. Namespaced because the client-held half and
   * the hub-answered half are built by different code out of different ids.
   */
  readonly id: string;
  readonly kind: PaletteResultKind;
  /** The first line: what the thing is called. */
  readonly label: string;
  /**
   * The second line: where the thing is, and what it is doing.
   *
   * Composed here rather than in the dialog, because it is the one part of a
   * row that only the kind knows how to write. A session says store, machine
   * and status, in the sidebar row's separator and order so that one session
   * reads the same in both places -- with the status words added, because the
   * resting list leads with the sessions that want a human and a row that did
   * not say so would leave that order unexplained.
   */
  readonly detail: string;
  /** Where following the row goes. */
  readonly href: string;
}

/**
 * How many rows the dialog is handed.
 *
 * A palette is a short list by construction: past about this many, nobody is
 * reading rows, they are typing more. The number that did not match is carried
 * beside the rows rather than dropped, so the dialog can say so -- a silently
 * truncated list claims it found eight things when it found forty.
 */
export const PALETTE_RESULT_LIMIT = 8;

/**
 * The client-held results: every session in the fleet the query admits, in the
 * order the session list would put them in.
 *
 * One order for both cases, and the empty query is simply the case where the
 * matcher admits everything: needs-you first, then last activity. That is the
 * resting list the ticket asks for, and it is also the honest ranking for a
 * query, because there is no relevance score here to rank by -- `matchesSearch`
 * answers yes or no. Inventing a score would be a second opinion about
 * matching, beside the one the list already has.
 */
export function sessionResults(
  items: readonly SessionListItem[],
  query: string,
): readonly PaletteResult[] {
  const matched = items.filter((item) => matchesSearch(item, query));
  return partitionNeedsYou(orderByActivity(matched)).map(sessionResult);
}

function sessionResult(item: SessionListItem): PaletteResult {
  return {
    id: `session:${item.key}`,
    kind: 'session',
    label: item.name,
    detail: `${item.storeId} · ${item.machine} · ${statusWords(item.status)}`,
    href: sessionHash(item.ref),
  };
}

/** The rows to draw, and how many there were before the bound. */
export interface PaletteListing {
  readonly results: readonly PaletteResult[];
  /** Everything that matched, drawn or not. */
  readonly total: number;
}

/**
 * The results as the dialog receives them: bounded, in the order given.
 *
 * The limit is an argument with a default rather than a constant read inside,
 * so a test can pin the rule without a fixture large enough to trip it.
 */
export function paletteListing(
  results: readonly PaletteResult[],
  limit: number = PALETTE_RESULT_LIMIT,
): PaletteListing {
  return { results: results.slice(0, limit), total: results.length };
}

/** The top row, or `null` when there is nothing to select. */
export function firstResult(results: readonly PaletteResult[]): string | null {
  return results[0]?.id ?? null;
}

/** The bottom row, or `null` when there is nothing to select. */
export function lastResult(results: readonly PaletteResult[]): string | null {
  return results[results.length - 1]?.id ?? null;
}

export function nextResult(results: readonly PaletteResult[], selected: string): string | null {
  return step(results, selected, 1);
}

export function previousResult(results: readonly PaletteResult[], selected: string): string | null {
  return step(results, selected, -1);
}

/**
 * One row along, wrapping at both ends.
 *
 * Wrapping, the way the tab strip's arrows do (`terminal/tab-strip-model.ts`):
 * on a list this short the arrows are a ring, and an arrow key that silently
 * does nothing at one end reads as a broken control rather than as an edge.
 * Home and End are the absolutes -- `firstResult` and `lastResult` above --
 * and they are what does not wrap.
 *
 * A selection the list no longer holds answers with the first row rather than
 * with nothing, because that is the common case and not an error: the list is
 * rebuilt on every keystroke, and the row that was selected before the last
 * character stops matching most of the time. Moving from a row that is gone
 * means starting again at the top, in either direction.
 */
function step(
  results: readonly PaletteResult[],
  selected: string,
  direction: 1 | -1,
): string | null {
  const first = results[0];
  if (first === undefined) return null;
  const index = results.findIndex((result) => result.id === selected);
  if (index < 0) return first.id;
  return results[(index + direction + results.length) % results.length]?.id ?? first.id;
}
