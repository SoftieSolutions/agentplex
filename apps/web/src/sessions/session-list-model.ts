import type {
  MachineState,
  Provider,
  ServerRegistrationId,
  SessionHolder,
  SessionRef,
  SessionStatus,
  StoreId,
} from '@agentplex/protocol';
import type { ConnectionPhase } from '../store/hub-store.js';
import type { Tone } from '../ui/tokens.js';

/**
 * Everything the session list derives from the machine state, as pure
 * functions. The screen owns nothing but UI state (what is typed into the
 * search field, which chip is pressed); every rule the ticket names --
 * needs-you first as a stable partition, activity order inside partitions,
 * one filter on the table, a control with one option is not drawn -- lives
 * here, where a test can hold a captured state against it.
 */

/** One session as the list renders it, flattened out of its store. */
export interface SessionListItem {
  readonly ref: SessionRef;
  /** Stable render key. JSON, not a joined string: ids may contain any separator. */
  readonly key: string;
  /** What the card is headed with: the provider's title, or the id when it has none. */
  readonly name: string;
  readonly provider: Provider;
  readonly status: SessionStatus;
  readonly tone: Tone;
  /**
   * In the needs-you partition. Wanting a human is not enough: an unreachable
   * session leaves the attention count, because a badge you cannot clear by
   * looking is worse than no badge.
   */
  readonly needsYou: boolean;
  /**
   * Whether the prompt this session is sitting on has been seen.
   *
   * Derived here and carried nowhere: the hub sends how far through this
   * session somebody has looked and how far it has got, both as readings of
   * one provider's clock, and this is the comparison between them. A session
   * the provider has written to since is no longer acknowledged -- which is
   * what stops one going quiet forever because somebody dismissed its first
   * prompt and it stopped at a second.
   *
   * False for a session nobody has acknowledged, and false for one nobody
   * needs to: the flag is about the acknowledgement, not about whether
   * anything is wanted, and `needsYou` beside it is the other half.
   */
  readonly acknowledged: boolean;
  /**
   * Whether this session is muted.
   *
   * It does not touch `needsYou`, and that is the whole semantic: a muted
   * session keeps its status, its badge and its place in the list. What it
   * loses is the noise -- the card is dimmed here, and the bell, the title and
   * the push skip it.
   */
  readonly muted: boolean;
  readonly reachable: boolean;
  /**
   * The machine to show on the card: the label of the server running it, or of
   * the server whose reading this is when nobody is. Falls back to the raw
   * registration id if the frame names a server its own `servers` list does
   * not describe -- a truthful name over a blank.
   */
  readonly machine: string;
  /**
   * The machine this row is narrowed by, which is the server whose reading it
   * is -- `source`, and deliberately not the holder that `machine` above
   * prefers for the label.
   *
   * The two differ for a session running on one machine and last read by
   * another, and the catalogue's `filter.server` is defined over the chosen
   * reading: a session on a volume two machines have mounted is one session,
   * and filtering on every server that reported it would put it under both.
   * The machine selector narrows both views at once, so the cards narrow by
   * the same fact the hub narrows the catalogue by, or the two panes on one
   * screen would answer the same question differently.
   */
  readonly server: ServerRegistrationId;
  /**
   * The working directory the provider recorded, or `null` when it records
   * none. Carried beside `summary` rather than folded into it, because
   * `summary` substitutes the status words for an absent directory and no
   * reader can undo that substitution -- `idle` is a legal path. A surface
   * that already has its own column for the activity wants this one.
   */
  readonly cwd: string | null;
  /** The one-line body: the working directory, or the status in words. */
  readonly summary: string;
  readonly updatedAt: number;
  readonly storeId: StoreId;
  /**
   * The server running this session right now, or `null` when nobody is.
   *
   * Carried through rather than re-derived, because `stoppable` on it is the
   * server's own answer about this process on this machine at this moment, and
   * nothing here can work it out from a status: a session can be `idle` and
   * held, and `working` and held by nobody.
   */
  readonly holder: SessionHolder | null;
}

/**
 * Status to tone. `working` runs, the two waiting-on-a-human states share the
 * accent, and `idle` is quiet. `unknown` is also quiet on purpose: the adapter
 * could not tell, and a loud tone would be the over-claim -- the words on the
 * card say `unknown`, the color claims nothing.
 */
export function toneForStatus(status: SessionStatus): Tone {
  switch (status) {
    case 'working':
      return 'running';
    case 'awaiting-permission':
    case 'awaiting-input':
      return 'needs-you';
    case 'idle':
    case 'unknown':
      return 'idle';
  }
}

/** The two statuses that want a human. The hub partitions on these; so do we. */
export function wantsHuman(status: SessionStatus): boolean {
  return status === 'awaiting-permission' || status === 'awaiting-input';
}

/**
 * Whether an acknowledgement still holds.
 *
 * The one rule the attention epic turns on, in one line: an acknowledgement is
 * a timestamp, and it holds only while the session has said nothing since. A
 * boolean would go sticky through a second prompt -- dismiss the first, let
 * the agent run on to a second, and a flag set once claims that one has been
 * seen too.
 *
 * Both numbers are `descriptor.updatedAt` values, off the one clock that wrote
 * the transcript: `acknowledgedThrough` is the reading the hub saw when
 * somebody said they had looked, and `updatedAt` is the reading now. Nothing
 * here touches a wall clock, which is the point. The hub's clock on one side
 * of this comparison would make the answer depend on how far the hub had
 * drifted from the machine running the agent -- and a hub a few seconds ahead
 * would read a second prompt as already seen, silently, which is the exact
 * failure a timestamp was chosen over a boolean to avoid.
 *
 * Equal is held, and that is not a tie-break: the two numbers are equal
 * precisely while the session has not been written to since the
 * acknowledgement, which is the common case and the whole of what an
 * acknowledgement claims.
 */
export function acknowledgementHolds(
  acknowledgedThrough: number | null,
  updatedAt: number,
): boolean {
  return acknowledgedThrough !== null && updatedAt <= acknowledgedThrough;
}

/**
 * Whether this session should be making a noise: it wants a human, nobody has
 * said they have seen it, and it is not muted.
 *
 * The one derived fact the bell, the document title and the push all read, so
 * that three surfaces cannot come to three different answers about whether to
 * interrupt somebody. It is deliberately narrower than `needsYou`, which is
 * what the list partitions and counts on: the fact stays visible when it has
 * been acknowledged or muted, and only the noise stops.
 */
export function wantsAttention(item: SessionListItem): boolean {
  return item.needsYou && !item.acknowledged && !item.muted;
}

export function statusWords(status: SessionStatus): string {
  switch (status) {
    case 'working':
      return 'working';
    case 'awaiting-permission':
      return 'awaiting permission';
    case 'awaiting-input':
      return 'awaiting input';
    case 'idle':
      return 'idle';
    case 'unknown':
      return 'status unknown';
  }
}

/**
 * What to call a machine: its label, or the raw registration id when the frame
 * names a server its own `servers` list does not describe -- a truthful name
 * over a blank.
 *
 * One lookup, exported, because four surfaces name machines now -- the card,
 * the pane header, the machine a start landed on, the holder a refusal names --
 * and four copies of the same `find` are four chances for one screen to call a
 * machine something the screen beside it does not.
 */
export function serverLabel(state: MachineState, registrationId: ServerRegistrationId): string {
  const server = state.servers.find((view) => view.registrationId === registrationId);
  return server?.label ?? registrationId;
}

/** Flattens every store's sessions into list items, in the order the hub sent. */
export function listSessions(state: MachineState): readonly SessionListItem[] {
  const items: SessionListItem[] = [];
  for (const store of state.stores) {
    for (const row of store.sessions) {
      const { descriptor } = row;
      const machineId = row.holder === null ? row.source : row.holder.server;
      const ref = { storeId: descriptor.storeId, sessionId: descriptor.sessionId };
      items.push({
        ref,
        key: JSON.stringify([descriptor.storeId, descriptor.sessionId]),
        name: descriptor.title ?? descriptor.sessionId,
        provider: descriptor.provider,
        status: descriptor.status,
        tone: toneForStatus(descriptor.status),
        needsYou: wantsHuman(descriptor.status) && row.reachable,
        acknowledged: acknowledgementHolds(row.acknowledgedThrough, descriptor.updatedAt),
        muted: row.mutedAt !== null,
        reachable: row.reachable,
        machine: serverLabel(state, machineId),
        server: row.source,
        cwd: descriptor.cwd,
        summary: descriptor.cwd ?? statusWords(descriptor.status),
        updatedAt: descriptor.updatedAt,
        storeId: descriptor.storeId,
        holder: row.holder,
      });
    }
  }
  return items;
}

/** Last activity first. A stable sort: equal timestamps keep the hub's order. */
export function orderByActivity(items: readonly SessionListItem[]): readonly SessionListItem[] {
  return [...items].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Needs-you first, as a stable partition and not a sort: both halves keep the
 * order they arrived in, which is what lets this run after `orderByActivity`
 * and leave activity order intact inside each half.
 */
export function partitionNeedsYou(items: readonly SessionListItem[]): readonly SessionListItem[] {
  return [...items.filter((item) => item.needsYou), ...items.filter((item) => !item.needsYou)];
}

/** The table's one filter. Case-insensitive, over everything a card shows. */
export function matchesSearch(item: SessionListItem, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (query === '') return true;
  return [
    item.name,
    item.ref.sessionId,
    item.provider,
    item.machine,
    item.storeId,
    item.summary,
  ].some((field) => field.toLowerCase().includes(query));
}

/**
 * The status chips group the five wire statuses into the four words a person
 * filters by; the two that want a human are one chip because they are one
 * situation.
 */
export type StatusChip = 'needs-you' | 'running' | 'idle' | 'unknown';

export function chipForStatus(status: SessionStatus): StatusChip {
  switch (status) {
    case 'working':
      return 'running';
    case 'awaiting-permission':
    case 'awaiting-input':
      return 'needs-you';
    case 'idle':
      return 'idle';
    case 'unknown':
      return 'unknown';
  }
}

export const CHIP_LABELS: Record<StatusChip, string> = {
  'needs-you': 'Needs you',
  running: 'Running',
  idle: 'Idle',
  unknown: 'Unknown',
};

/** Display order: the loudest first, the least claiming last. */
const CHIP_ORDER: readonly StatusChip[] = ['needs-you', 'running', 'idle', 'unknown'];

export interface ChipCount {
  readonly chip: StatusChip;
  readonly label: string;
  readonly count: number;
}

/**
 * The chips to draw, states that exist only. An absent state gets no chip --
 * a filter naming nothing filters nothing -- and when every session is in one
 * state the whole row is one effective option and is not drawn: `[]` here is
 * the screen's instruction to render no chip row at all.
 */
export function chipCounts(items: readonly SessionListItem[]): readonly ChipCount[] {
  const counts = new Map<StatusChip, number>();
  for (const item of items) {
    const chip = chipForStatus(item.status);
    counts.set(chip, (counts.get(chip) ?? 0) + 1);
  }
  if (counts.size < 2) return [];
  return CHIP_ORDER.filter((chip) => counts.has(chip)).map((chip) => ({
    chip,
    label: CHIP_LABELS[chip],
    count: counts.get(chip) ?? 0,
  }));
}

/**
 * How many sessions are waiting on a human: the badge on the phone chrome's
 * action button.
 *
 * `needsYou`, which is the field `partitionNeedsYou` sorts to the top, and
 * deliberately not the Needs you chip's count. The two differ by exactly one
 * thing -- a session nobody can reach right now -- and they differ because
 * they answer different questions. A chip is a facet: its number is a promise
 * about how many rows pressing it yields, so it counts every session in that
 * state whether or not anything can be done about it. A badge is a claim on
 * somebody's attention, and a number that cannot be brought down by attending
 * to it is a number people learn to ignore.
 *
 * So on a fleet everything is reachable in they are the same number, and when
 * a machine drops the badge falls while the chip does not. That is the honest
 * direction for both.
 */
export function needsYouCount(items: readonly SessionListItem[]): number {
  return items.filter((item) => item.needsYou).length;
}

/**
 * The values a narrowing control would offer. The screen draws the control
 * only when there are at least two -- a control with one option is not drawn
 * -- so both lists come back empty below that threshold, the same instruction
 * `chipCounts` gives.
 */
export function storeOptions(state: MachineState): readonly StoreId[] {
  const stores = state.stores.map((store) => store.storeId);
  return stores.length < 2 ? [] : stores;
}

export function providerOptions(items: readonly SessionListItem[]): readonly Provider[] {
  const providers = [...new Set(items.map((item) => item.provider))];
  return providers.length < 2 ? [] : providers;
}

export interface SessionListFilters {
  readonly search: string;
  /** `null` is the All chip. */
  readonly chip: StatusChip | null;
  /** `null` when not narrowed, and always `null` while the control is not drawn. */
  readonly storeId: string | null;
  readonly provider: string | null;
  /**
   * The machine selector's selection, or `null` for the whole fleet.
   *
   * Unlike the two above, a selection naming a machine the state no longer
   * lists is *not* quietly dropped here. It is what the catalogue query is
   * narrowed by at the same moment, and a card list that widened while the
   * panel beside it stayed narrow would be two answers to one question.
   */
  readonly server: string | null;
}

export const NO_FILTERS: SessionListFilters = {
  search: '',
  chip: null,
  storeId: null,
  provider: null,
  server: null,
};

/**
 * The whole pipeline: narrowings, then the chip, then search, then activity
 * order, then the partition. The partition runs last so that whatever survives
 * filtering still shows needs-you first.
 */
export function visibleSessions(
  state: MachineState,
  filters: SessionListFilters,
): readonly SessionListItem[] {
  const narrowed = listSessions(state).filter(
    (item) =>
      (filters.storeId === null || item.storeId === filters.storeId) &&
      (filters.provider === null || item.provider === filters.provider) &&
      (filters.server === null || item.server === filters.server) &&
      (filters.chip === null || chipForStatus(item.status) === filters.chip) &&
      matchesSearch(item, filters.search),
  );
  return partitionNeedsYou(orderByActivity(narrowed));
}

/** The age on a card: how long since the provider last wrote, in one word. */
export function ageLabel(now: number, updatedAt: number): string {
  const elapsed = now - updatedAt;
  if (elapsed < 60_000) return 'now';
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h`;
  return `${String(Math.floor(hours / 24))}d`;
}

/**
 * What to say about the connection, or `null` while there is nothing to say.
 *
 * Degrade in the direction that does not over-claim: a state shown across a
 * dead connection is labelled stale rather than the screen pretending
 * liveness, and no state at all is said in words rather than drawn as an
 * empty fleet.
 */
export function connectionNotice(
  phase: ConnectionPhase,
  problem: string | null,
  hasState: boolean,
): string | null {
  switch (phase) {
    case 'idle':
      return 'not connected';
    case 'connecting':
      return 'connecting to the hub';
    case 'reconnecting':
      return hasState
        ? 'connection lost; reconnecting. Showing the last state received, which may be stale.'
        : 'connection lost; reconnecting';
    case 'failed':
      return problem ?? 'the connection has failed and is not retrying';
    case 'connected':
      return hasState ? null : 'connected; waiting for the first state from the hub';
  }
}
