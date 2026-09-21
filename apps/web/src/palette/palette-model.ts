import type { NodeKind } from '@agentplex/protocol';
import {
  matchesSearch,
  orderByActivity,
  partitionNeedsYou,
  statusWords,
  type SessionListItem,
} from '../sessions/session-list-model.js';
import { sessionHash } from '../terminal/session-route.js';
import { DOC_KIND, SESSION_KIND } from '../tree/node-kinds.js';

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
 * ## Two halves, one list
 *
 * A session is in the browser already, so `sessionResults` computes that half
 * synchronously from state; every other kind is the hub's to answer, and
 * `palette-search.ts` asks for it. `PaletteResult` is what lets one dialog draw
 * both: it carries no session in it, only a kind, a label, a second line and an
 * href, which is all a row needs to be drawn and followed, and which every kind
 * can produce.
 *
 * `mergeResults` puts the two together and `paletteListing` gathers them by
 * kind. The ids are namespaced by kind because two halves assembled from
 * different sources must not collide on one -- and, for a session, minted
 * identically on both sides, because a session the client holds and the hub
 * also returned is one row and the id is how that is noticed.
 */

/**
 * What a result points at: a node kind, the hub's own string.
 *
 * Not a union of the two this build mints. A kind is a row in the hub's
 * `node_kinds` table -- migration 0004 made it one so that adding a kind costs
 * an INSERT -- and `tree/node-kinds.ts` is the one place this app parses the
 * strings it knows the names of. A palette that closed the set here would have
 * to be released again for a kind the hub can already return, and the grouping
 * below is written so it does not have to be: a kind nobody named is drawn
 * under its own name. `project` is absent for a different reason, which is that
 * the hub answers a flat search with leaves only; `palette-search.ts` records
 * it and AGX-261 is filed to change it.
 */
export type PaletteResultKind = NodeKind;

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
    kind: SESSION_KIND,
    label: item.name,
    detail: `${item.storeId} · ${item.machine} · ${statusWords(item.status)}`,
    href: sessionHash(item.ref),
  };
}

/**
 * The two halves as one list: the client's rows, then the hub's rows the
 * client did not already hold.
 *
 * Deduplicated by id, which is why the ids are minted the way they are: the
 * hub-answered half builds a session row under the id `sessionResults` gives
 * the same session, so a session in both halves is one row without either side
 * comparing labels or addresses. The client-held row is the one kept, because
 * it says more -- it names the machine the session is on, which a page asked
 * with `groupBy: 'none'` carries no group to read a label off.
 *
 * The client's rows lead for the same reason they are computed synchronously:
 * they are there before the hub is asked, so a person typing sees the list they
 * already had settle rather than reorder under them when the answer lands.
 */
export function mergeResults(
  clientHeld: readonly PaletteResult[],
  hubAnswered: readonly PaletteResult[],
): readonly PaletteResult[] {
  const held = new Set(clientHeld.map((result) => result.id));
  return [...clientHeld, ...hubAnswered.filter((result) => !held.has(result.id))];
}

/** One heading and the rows under it. */
export interface PaletteGroup {
  readonly kind: PaletteResultKind;
  /** What the heading says, from `headingFor`. */
  readonly heading: string;
  readonly results: readonly PaletteResult[];
}

/**
 * What a kind is called above its rows.
 *
 * The two this build knows are named through `tree/node-kinds.ts` rather than
 * by comparing against `'session'` here, because that file is where a kind
 * string is parsed and one more copy of the word is one more place to disagree
 * with the tree. Anything else is labelled with the kind itself: the hub can
 * return a kind this release has never heard of -- a graph, when AGX-110 lands
 * -- and a heading reading `graph` is worse than the word the hub would have
 * used and far better than the row being dropped or filed under a guess.
 */
export function headingFor(kind: PaletteResultKind): string {
  if (kind === SESSION_KIND) return 'Sessions';
  if (kind === DOC_KIND) return 'Documents';
  return kind;
}

/** The rows to draw, grouped, and how many there were before the bound. */
export interface PaletteListing {
  /**
   * The drawn order, flat: the groups' rows concatenated.
   *
   * The keyboard walks this, so the arrows move down the dialog as it is drawn
   * rather than through the order the rows arrived in. A listing whose flat
   * list and whose groups disagreed would send the selection to a row further
   * up the screen than the one it left.
   */
  readonly results: readonly PaletteResult[];
  readonly groups: readonly PaletteGroup[];
  /** Everything that matched, drawn or not. */
  readonly total: number;
}

/**
 * The results as the dialog receives them: gathered by kind, then bounded.
 *
 * Grouped before bounding, because grouping moves rows: a bound applied first
 * would decide which rows are drawn by an order nobody sees. The groups
 * themselves are in the order their kinds first appear, which is the one order
 * this file can defend -- there is no relevance score here to rank kinds by,
 * and a fixed order would claim sessions matter more than documents in a
 * dialog that was handed both.
 *
 * The limit is an argument with a default rather than a constant read inside,
 * so a test can pin the rule without a fixture large enough to trip it.
 */
export function paletteListing(
  results: readonly PaletteResult[],
  limit: number = PALETTE_RESULT_LIMIT,
): PaletteListing {
  const ordered = groupsOf(results).flatMap((group) => group.results);
  const drawn = ordered.slice(0, limit);
  return { results: drawn, groups: groupsOf(drawn), total: results.length };
}

/** Each kind's rows in one run, the kinds in the order they first appear. */
function groupsOf(results: readonly PaletteResult[]): readonly PaletteGroup[] {
  const byKind = new Map<PaletteResultKind, PaletteResult[]>();
  for (const result of results) {
    const rows = byKind.get(result.kind);
    if (rows === undefined) byKind.set(result.kind, [result]);
    else rows.push(result);
  }
  return [...byKind].map(([kind, rows]) => ({ kind, heading: headingFor(kind), results: rows }));
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
