import type { NodeKind } from '@agentplex/protocol';
import {
  matchesSearch,
  orderByActivity,
  partitionNeedsYou,
  statusWords,
  type SessionListItem,
} from '../sessions/session-list-model.js';
import { sessionHash } from '../terminal/session-route.js';
import { DOC_KIND, PROJECT_KIND, SESSION_KIND } from '../tree/node-kinds.js';

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
 * Not a union of the three this build mints. A kind is a row in the hub's
 * `node_kinds` table -- migration 0004 made it one so that adding a kind costs
 * an INSERT -- and `tree/node-kinds.ts` is the one place this app parses the
 * strings it knows the names of. A palette that closed the set here would have
 * to be released again for a kind the hub can already return, and the grouping
 * below is written so it does not have to be: a kind nobody named is drawn
 * under its own name.
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
 * Every kind this dialog has a heading for, in the order the headings are
 * written, with what each is called above its rows.
 *
 * One list rather than a chain of comparisons, because it is read twice: as
 * the headings below, and as `PALETTE_KINDS` -- the selection
 * `palette-search.ts` puts on the query. A kind with a heading and no place in
 * the question would be a heading nothing can draw rows under; a kind in the
 * question with no heading would be rows filed under their own bare kind
 * string. Keeping both off one list is what makes those two impossible.
 *
 * The kinds are named through `tree/node-kinds.ts` rather than spelled out
 * here, because that file is where a kind string is parsed and one more copy
 * of the word is one more place to disagree with the tree.
 */
const HEADINGS: ReadonlyMap<PaletteResultKind, string> = new Map([
  [SESSION_KIND, 'Sessions'],
  [DOC_KIND, 'Documents'],
  [PROJECT_KIND, 'Projects'],
]);

/**
 * The kinds the palette asks the hub for: exactly the ones it draws headings
 * for, and the reason a project is findable at all.
 *
 * A flat catalogue page keeps leaves only unless the query names the kinds it
 * wants (AGX-261), so this is what puts a container on the page. Asking for
 * exactly what is drawn rather than for everything is the other half of it: a
 * folder the hub returned would be a row the dialog drops after the page was
 * bounded around it, spending a slot and making the hub's `total` a count of
 * rows nobody can see.
 *
 * A graph is deliberately not here. The kind is unseeded until AGX-144, and
 * the selection is asked for by name, so it can be added to the list above the
 * day the migration lands -- without a protocol change, because a kind is a
 * row and not an enum.
 */
export const PALETTE_KINDS: readonly PaletteResultKind[] = [...HEADINGS.keys()];

/**
 * What a kind is called above its rows.
 *
 * A kind with no heading is labelled with the kind itself: the hub can return
 * one this release has never heard of -- a graph, when AGX-144 lands, or a
 * kind a later migration seeds -- and a heading reading `graph` is worse than
 * the word the hub would have used and far better than the row being dropped
 * or filed under a guess.
 */
export function headingFor(kind: PaletteResultKind): string {
  return HEADINGS.get(kind) ?? kind;
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
 * The results as the dialog receives them: gathered by kind, then bounded so
 * that every kind that matched keeps at least its best row.
 *
 * Grouped before bounding, because grouping moves rows: a bound applied first
 * would decide which rows are drawn by an order nobody sees. The groups
 * themselves are in the order their kinds first appear, which is the one order
 * this file can defend -- there is no relevance score here to rank kinds by,
 * and a fixed order would claim sessions matter more than documents in a
 * dialog that was handed both.
 *
 * ## Why the bound is dealt rather than sliced
 *
 * The rows arrive as one concatenation with the client-held sessions leading,
 * because those are computed synchronously and the hub's half is not
 * (`mergeResults`). Slicing that concatenation makes the limit fall wherever
 * the fleet happens to put it: eight matching sessions and the document and
 * the project of the same name never reach the screen at all, and a person who
 * typed a project's name is told it does not exist by a dialog that was handed
 * it.
 *
 * So the groups are dealt from instead -- one row from each in turn, round
 * after round, until the limit is spent. Every kind that matched keeps its
 * best row, each kind keeps a prefix of its own rows so the order inside a
 * kind is still the order it arrived in, and what shrinks is how many rows the
 * largest group gets, which is the thing more typing fixes. The total is still
 * bounded by `limit` and `total` still counts everything that matched, so the
 * "N of M" line the dialog draws stays true.
 *
 * More kinds than the limit is the one case where a kind still goes undrawn.
 * There is no bound that draws a row for each and honours the limit, and the
 * count line is what says rows were left out.
 *
 * The limit is an argument with a default rather than a constant read inside,
 * so a test can pin the rule without a fixture large enough to trip it.
 */
export function paletteListing(
  results: readonly PaletteResult[],
  limit: number = PALETTE_RESULT_LIMIT,
): PaletteListing {
  const drawn = groupsOf(dealt(groupsOf(results), limit));
  return {
    results: drawn.flatMap((group) => group.results),
    groups: drawn,
    total: results.length,
  };
}

/** One row from each group in turn, in group order, until the limit is spent. */
function dealt(groups: readonly PaletteGroup[], limit: number): readonly PaletteResult[] {
  const taken: PaletteResult[] = [];
  const deepest = groups.reduce((rows, group) => Math.max(rows, group.results.length), 0);
  for (let round = 0; round < deepest && taken.length < limit; round += 1) {
    for (const group of groups) {
      if (taken.length >= limit) break;
      const row = group.results[round];
      if (row !== undefined) taken.push(row);
    }
  }
  return taken;
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
