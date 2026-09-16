import {
  serverRegistrationIdSchema,
  type MachineState,
  type ServerRegistrationId,
  type ServerView,
} from '@agentplex/protocol';
import { shortMachinesOf, withFilter, type CatalogueShape } from '../catalogue/catalogue-model.js';
import { serverRows } from '../settings/server-rows.js';
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
 *   * the latency is not knowable at all in this build. Nothing measures a
 *     round trip and `ServerView` has no field for one -- the protocol is
 *     explicit that only the end that dialled can time one, which is the hub
 *     timing its own `ping` against the `pong`. So there is a named slot here
 *     and no number in it. Drawing a figure a client computed would be a
 *     measurement of the browser's own event loop wearing a machine's name;
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

export interface MachineSelectorView {
  readonly counts: FleetCounts;
  /** A measured round trip in milliseconds, or `null` while nobody has one. */
  readonly latencyMs: number | null;
  /** What the app is narrowed to, or `null` for the whole fleet. */
  readonly selected: ServerRegistrationId | null;
  readonly rows: readonly MachineRow[];
}

/** The unnarrowed selection, in the words the header shows for it. */
export const ALL_MACHINES = 'All machines';

/**
 * The round trip this build can honestly claim.
 *
 * `null`, and the constant exists so that the absence is a named thing rather
 * than an omission somebody later reads as an oversight. When the heartbeat
 * starts publishing what the hub already measures, the figure arrives as the
 * third argument to `machineSelector` and every word that draws it is already
 * written and tested -- see the header tests, which pass a number in.
 */
export const NO_LATENCY_MS: number | null = null;

export function fleetCounts(state: MachineState | null): FleetCounts {
  const servers = state?.servers ?? [];
  return {
    online: servers.filter((server) => server.phase === 'connected').length,
    total: servers.length,
  };
}

/**
 * Everything the selector draws, from the fleet and one chosen value.
 *
 * `chosen` is a string because that is what a control hands back and what a
 * query frame's filter holds; it is parsed rather than cast, and a value no
 * registration id could be selects nothing.
 */
export function machineSelector(
  state: MachineState | null,
  chosen: string | null,
  latencyMs: number | null = NO_LATENCY_MS,
): MachineSelectorView {
  const parsed = serverRegistrationIdSchema.safeParse(chosen);
  const selected = parsed.success ? parsed.data : null;
  const short = shortMachinesOf(state);
  const views = new Map((state?.servers ?? []).map((view) => [view.registrationId, view]));
  const rows = serverRows(state).map((row) => ({
    registrationId: row.registrationId,
    short: short.get(row.registrationId) ?? row.label,
    label: row.label,
    tone: row.tone,
    words: phaseWords(row.phase, views.get(row.registrationId)),
    selected: row.registrationId === selected,
  }));
  return { counts: fleetCounts(state), latencyMs, selected, rows };
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
