import type {
  MachineState,
  NodeId,
  Provider,
  ServerRegistrationId,
  SessionHolder,
  SessionRef,
  SessionStatus,
  StoreId,
} from '@agentplex/protocol';
import { destinationHash } from '../shell/destinations.js';
import type { NextAction } from '../shell/next-action.js';
import type { ShellForm } from '../shell/shell-form.js';
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
  /**
   * The model the provider's own record named, or `null` when it named none.
   *
   * A string carried and never read into: nothing here parses it, groups by
   * it or colours by it, because the set of models is the providers' to change
   * and a client that branched on the value would have to ship a release every
   * time one of them shipped a model. The one thing this file does to it is
   * turn the wire's absent key into a `null`, so that a reader gets the same
   * shape of absence it already handles for `cwd` and `project` rather than an
   * `undefined` that reads as a field somebody forgot to set.
   */
  readonly model: string | null;
  /** The one-line body: the working directory, or the status in words. */
  readonly summary: string;
  readonly updatedAt: number;
  readonly storeId: StoreId;
  /**
   * The name of the project the hub's tree places this session in, or `null`
   * when it places it in none.
   *
   * Flattened to the name rather than carried as the wire's `{ nodeId, name }`
   * because every surface here draws the word and none of them would be right
   * to invent one: a row in no project is a `null` a caller has to answer for,
   * and `project?.name` would let one quietly read as the other.
   */
  readonly project: string | null;
  /**
   * The project's node, or `null` on the same rule as the name above.
   *
   * Beside the name and not in place of it: a label with no destination is a
   * dead end, and a destination with no label is not something a person can
   * read. Nothing on this screen navigates by it yet -- the breadcrumb that
   * will is its own task -- and it is carried anyway, because the alternative
   * when it lands is the component joining a name here to an id looked up
   * somewhere else, at a different moment, off a different frame.
   */
  readonly projectId: NodeId | null;
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

/**
 * The middle dot the place line is joined by, spelled once.
 *
 * The components that draw it already agreed on this character; the reason it
 * is a constant here rather than typed into each of them is that they no
 * longer agree on what goes to the left of it, and a rule about the left-hand
 * side split across two files is a rule that only half of a screen follows.
 */
const PLACE_SEPARATOR = '·';

/**
 * Where a session is, in one line: the project and the machine, or the store
 * and the machine when the tree places it in no project.
 *
 * The fallback is the whole of this function, and it falls back to what the
 * line said before this field existed rather than to an empty word: a session
 * in no project is not a session in a project called nothing, and a separator
 * with a blank in front of it is the screen claiming an association the hub
 * did not report. A store id is coarser than a project name and it is true.
 *
 * One helper because two surfaces draw this line -- the sidebar's rows and the
 * card's meta line -- and two copies of a fallback are two chances for one of
 * them to forget it and draw a bare dot.
 */
export function placeLabel(item: SessionListItem): string {
  return `${item.project ?? item.storeId} ${PLACE_SEPARATOR} ${item.machine}`;
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
        model: descriptor.model ?? null,
        summary: descriptor.cwd ?? statusWords(descriptor.status),
        updatedAt: descriptor.updatedAt,
        storeId: descriptor.storeId,
        project: row.project?.name ?? null,
        projectId: row.project?.nodeId ?? null,
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

/**
 * The table's one filter. Case-insensitive, over everything a card shows.
 *
 * The project is in the list for exactly that reason: it is now drawn on the
 * row, and a word somebody can read off a card and not type into the box above
 * it reads as a broken search rather than as a narrow one.
 */
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
    item.project,
  ].some((field) => field !== null && field.toLowerCase().includes(query));
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
 * So the two are the same number while every machine is reachable, and when
 * one drops the badge falls while the chip does not. That is the honest
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

/** An empty list, worded for the reason it is empty. */
export interface EmptyListing {
  readonly words: string;
  /** Where to go about it, or `null` when the control is on this screen. */
  readonly action: NextAction | null;
}

/**
 * Why the list is empty, and what resolves it.
 *
 * One sentence -- "no sessions in any store yet" -- used to answer four
 * different situations, and it was true in all four and useful in none. The
 * chain a session hangs off is pairing, then a store, then a session, and a
 * person looking at an empty list is stuck at exactly one link of it. Naming
 * which link is the whole of this function.
 *
 * Two cases have somewhere to send anybody, and they are the two the app can
 * do something about: nothing paired, and a pairing the hub has never reached.
 * A store is a directory on the server's own disk with an
 * `agentplex-store.json` at its root; nothing in this app creates one, so the
 * honest answer there is the fact and no link, rather than a link to a screen
 * that cannot help. A narrowing is undone by
 * the controls directly above the list, and starting the first session is a
 * control on this screen or in the chrome around it -- and a link to the
 * screen you are reading is a route to nowhere.
 *
 * Which control that is depends on the form the shell is in, which is why the
 * form is an argument. The New session button is `visibleFrom="sm"`, and below
 * that width the thing that starts one is the chrome's round button, whose
 * name is "Start a session". Naming the wrong one is worse than naming none:
 * it sends somebody hunting for a button that is not drawn at their width.
 */
export function emptyListing(
  state: MachineState,
  anySession: boolean,
  form: ShellForm,
): EmptyListing {
  if (anySession) {
    return { words: 'no session matches the current narrowing', action: null };
  }
  if (state.servers.length === 0) {
    return {
      words:
        'No server is paired with this hub, and a paired server is what reports the stores ' +
        'sessions live in.',
      action: { label: 'Pair one in Settings', hash: destinationHash('settings') },
    };
  }
  if (state.stores.length === 0) {
    // Named when there is one to name: "gpu-box-01 reports no store" sends
    // somebody to the right machine, where "no store is reported" sends them
    // looking for which.
    const only = state.servers.length === 1 ? state.servers[0] : undefined;
    // A pairing the hub has never held a connection to has reported nothing,
    // so "reports no store" credits it with a report it never made. What is
    // missing there is the connection, not a directory on a disk -- and that
    // one does have somewhere to send anybody, because the row in Settings
    // carries the phase, the address that was typed and the hub's own
    // sentence about what went wrong.
    if (state.servers.every((server) => server.lastConnectedAt === null)) {
      const which =
        only === undefined
          ? 'No paired server has ever connected to this hub, so nothing has reported a store'
          : `${only.label} is paired but has never connected to this hub, so nothing has ` +
            'reported a store';
      return {
        words: `${which}.`,
        action: { label: 'See why in Settings', hash: destinationHash('settings') },
      };
    }
    const which =
      only === undefined
        ? 'No paired server reports a store yet'
        : `${only.label} is paired and reports no store yet`;
    return {
      words: `${which}. A store is a directory with an agentplex-store.json at its root.`,
      action: null,
    };
  }
  const starter = form === 'phone' ? 'the Start a session button' : 'New session';
  return { words: `No sessions in any store yet — ${starter} starts one.`, action: null };
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
