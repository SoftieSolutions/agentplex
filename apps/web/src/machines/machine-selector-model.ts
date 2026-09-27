import {
  serverRegistrationIdSchema,
  type MachineState,
  type ServerRegistrationId,
  type ServerView,
} from '@agentplex/protocol';
import { shortMachinesOf, withFilter, type CatalogueShape } from '../catalogue/catalogue-model.js';
import {
  isSlowRoundTrip,
  ROUND_TRIP_FRESH_MS,
  roundTripWords,
  serverRows,
} from '../settings/server-rows.js';
import type { Tone } from '../ui/tokens.js';

/**
 * The machine selector, as three claims and nothing else.
 *
 * The header the mockups put above the sidebar tabs says how much of the fleet
 * is up, how far away it is, and what the app is narrowed to. Each of those is
 * knowable to a different degree, and the honest handling of each is what this
 * file is:
 *
 *   * the counts are the hub's own: it knows every pairing it supervises and
 *     which of them it is holding a connection to right now, so `3/4 online`
 *     is a fact restated rather than a number assembled here;
 *   * the latency is the hub's measurement, restated. Only the end that
 *     dialled can time a round trip, so the hub times its own `ping` against
 *     the `pong` and publishes the reading with the moment it was taken. The
 *     header's figure is the mean over the machines online now whose reading
 *     is still current, and a row's is that machine's own, with its age once
 *     it is old. A figure a client computed would be a measurement of the
 *     browser's own event loop wearing a machine's name, and a zero for a
 *     machine not yet timed would draw it as the fastest in the fleet;
 *   * the selection narrows what is shown and moves nothing. A session is
 *     `{ storeId, sessionId }` and never a machine, so the machine here is a
 *     filter over sessions: it becomes the catalogue query's `filter.server`
 *     and the same constraint over the cards, and it is nothing else. Nothing
 *     is addressed by machine and nothing moves between machines because a
 *     menu closed.
 *
 * The tones and the phase words are the settings screen's, through
 * `serverRows`. A second vocabulary for one machine's state is two screens
 * free to disagree about whether a box is fine.
 */

/** How many machines are paired, and how many of those are connected. */
export interface FleetCounts {
  readonly online: number;
  readonly total: number;
}

/** One machine as a row of the open selector. */
export interface MachineRow {
  readonly registrationId: ServerRegistrationId;
  /** The few characters a tree row has room for. AGX-134's derivation. */
  readonly short: string;
  readonly label: string;
  /** The connectivity as the tone dot beside the row. */
  readonly tone: Tone;
  /** The connectivity as words, with the reason where the phase has one. */
  readonly words: string;
  readonly selected: boolean;
}

/** One machine as a row of the open selector, with the words that need a clock. */
export interface MachineSelectorRow extends MachineRow {
  /**
   * What the row draws at its right: the round trip the hub measured, with its
   * age once it is no longer current, or the phase words when there is no
   * figure to draw -- and for a machine that is shutting down, whose drain is
   * the thing on the row somebody should act on.
   */
  readonly trailing: string;
  /**
   * Whether `trailing` is a round trip rather than the phase. A figure is drawn
   * in the row's muted tone, as the mockup (6c) draws it; the phase words keep
   * the faint one they had.
   */
  readonly measured: boolean;
  /** Whether `trailing` is a round trip past the threshold, drawn in the warning tone. */
  readonly slow: boolean;
}

export interface MachineSelectorView {
  readonly counts: FleetCounts;
  /**
   * The mean round trip over the machines online now with a current reading,
   * in whole milliseconds, or `null` while there is none to average.
   */
  readonly latencyMs: number | null;
  /** What the app is narrowed to, or `null` for the whole fleet. */
  readonly selected: ServerRegistrationId | null;
  readonly rows: readonly MachineSelectorRow[];
}

/** The unnarrowed selection, in the words the header shows for it. */
export const ALL_MACHINES = 'All machines';

export function fleetCounts(state: MachineState | null): FleetCounts {
  const servers = state?.servers ?? [];
  return {
    online: servers.filter((server) => server.phase === 'connected').length,
    total: servers.length,
  };
}

/**
 * The machines as rows, from the fleet and one chosen value, with nothing that
 * needs a clock.
 *
 * `chosen` is a string because that is what a control hands back and what a
 * query frame's filter holds; it is parsed rather than cast, and a value no
 * registration id could be selects nothing.
 *
 * Apart from `machineSelector` for the reader that draws once per state: the
 * graph inspector names the machines and their phase, and a clock read there
 * would freeze at the frame it was read on.
 */
export function machineRows(
  state: MachineState | null,
  chosen: string | null,
): readonly MachineRow[] {
  const selected = selectionOf(chosen);
  const short = shortMachinesOf(state);
  const views = viewsOf(state);
  return serverRows(state).map((row) => ({
    registrationId: row.registrationId,
    short: short.get(row.registrationId) ?? row.label,
    label: row.label,
    tone: row.tone,
    words: phaseWords(row.phase, views.get(row.registrationId)),
    selected: row.registrationId === selected,
  }));
}

/**
 * Everything the selector draws, from the fleet, one chosen value, and the
 * moment it is drawn at.
 *
 * `now` is the browser's clock and the readings are stamped by the hub's, so
 * an age here is as good as the two clocks' agreement -- the same bargain every
 * other age in the app makes with `updatedAt`.
 */
export function machineSelector(
  state: MachineState | null,
  chosen: string | null,
  now: number,
): MachineSelectorView {
  const views = viewsOf(state);
  const rows = machineRows(state, chosen).map((row) => {
    const view = views.get(row.registrationId);
    const figure = view === undefined || view.draining !== null ? null : view.roundTrip;
    const words = roundTripWords(figure, now);
    return {
      ...row,
      trailing: words ?? row.words,
      measured: words !== null,
      slow: words !== null && isSlowRoundTrip(figure),
    };
  });
  return {
    counts: fleetCounts(state),
    latencyMs: meanRoundTrip(state, now),
    selected: selectionOf(chosen),
    rows,
  };
}

function selectionOf(chosen: string | null): ServerRegistrationId | null {
  const parsed = serverRegistrationIdSchema.safeParse(chosen);
  return parsed.success ? parsed.data : null;
}

function viewsOf(state: MachineState | null): ReadonlyMap<ServerRegistrationId, ServerView> {
  return new Map((state?.servers ?? []).map((view) => [view.registrationId, view]));
}

/**
 * The fleet's round trip: the mean over the machines online now whose reading
 * is still current.
 *
 * Online only, because "All machines" is a claim about the machines somebody
 * can reach. Current only, because the header has no room for an age, and a
 * figure that cannot carry its age must not be an old one. A machine with no
 * reading is left out rather than counted as zero.
 */
function meanRoundTrip(state: MachineState | null, now: number): number | null {
  const figures = (state?.servers ?? []).flatMap((view) =>
    view.phase === 'connected' &&
    view.roundTrip !== null &&
    now - view.roundTrip.measuredAt <= ROUND_TRIP_FRESH_MS
      ? [view.roundTrip.ms]
      : [],
  );
  if (figures.length === 0) return null;
  return Math.round(figures.reduce((sum, ms) => sum + ms, 0) / figures.length);
}

/**
 * The phase, with the reason for an unreachable spell where there is one.
 *
 * The reason is worth the room because the three things a person might do
 * about it differ -- wait, re-pair, upgrade -- and the phase word alone does
 * not say which. It is dropped when it only repeats that word: the hub's
 * reason vocabulary and the word for the phase meet at `unreachable`, and
 * "unreachable · unreachable" says one thing twice.
 */
function phaseWords(phase: string, view: ServerView | undefined): string {
  if (view === undefined || view.phase !== 'stale') return phase;
  const reason = view.staleReason;
  if (reason === null || reason === phase) return phase;
  return `${phase} · ${reason}`;
}

/** Which width the header is being drawn at. Both are drawn; CSS picks one. */
export type HeaderWidth = 'wide' | 'narrow';

export interface MachineHeader {
  /** What is selected: `All machines`, or the machine's own label. */
  readonly title: string;
  /** The claims beside it, or `null` when they are folded into the title. */
  readonly detail: string | null;
}

/**
 * The header text at one width.
 *
 * Wide is the mockup's two pieces -- what is selected, then what is up and how
 * far away -- and narrow is the same sentence with the separators doing the
 * work of the second line. It is one function over one view rather than two
 * strings held apart, because the narrow line is the wide one compressed and
 * two independently written headers drift.
 */
export function machineHeader(view: MachineSelectorView, width: HeaderWidth): MachineHeader {
  const title = titleFor(view);
  const parts = [countWords(view.counts, width), latencyWords(view.latencyMs)].filter(
    (part): part is string => part !== null,
  );
  const detail = parts.join(' · ');
  if (width === 'narrow') return { title: `${title} · ${detail}`, detail: null };
  return { title, detail };
}

/**
 * The selection's name: its label where the fleet still names it, and the
 * registration id itself where it does not.
 *
 * A selection the fleet stopped listing is still what the query is narrowed
 * by, so the header says so. Quietly drawing it as `All machines` would have
 * the header disagreeing with the rows underneath it, which would be the one
 * thing worse than an ugly name.
 */
function titleFor(view: MachineSelectorView): string {
  if (view.selected === null) return ALL_MACHINES;
  const row = view.rows.find((candidate) => candidate.registrationId === view.selected);
  return row?.label ?? view.selected;
}

function countWords(counts: FleetCounts, width: HeaderWidth): string {
  if (counts.total === 0) return 'no machines paired';
  const share = `${String(counts.online)}/${String(counts.total)}`;
  // `online` is dropped at the narrow width and nothing else is: the ratio is
  // the claim, and the word beside it is what a wide header has room to say.
  return width === 'wide' ? `${share} online` : share;
}

function latencyWords(latencyMs: number | null): string | null {
  return latencyMs === null ? null : `${String(latencyMs)}ms`;
}

/**
 * The same query, narrowed to one machine or to none.
 *
 * This is the whole of what selecting a machine does to the catalogue. It goes
 * through `withFilter`, which is the one place a filter field is set, so a
 * value the query frame would refuse narrows by nothing instead of riding onto
 * the wire.
 */
export function narrowedToMachine(shape: CatalogueShape, chosen: string | null): CatalogueShape {
  return withFilter(shape, { field: 'server', value: chosen });
}
