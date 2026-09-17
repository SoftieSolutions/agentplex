import {
  providerSchema,
  serverRegistrationIdSchema,
  sessionStatusSchema,
  CATALOGUE_SEARCH_MAX_CHARS,
  type CatalogueFilter,
  type CatalogueGroup,
  type CatalogueGroupBy,
  type CatalogueItem,
  type CatalogueMatchField,
  type CatalogueQuery,
  type CatalogueSort,
  type CatalogueSortKey,
  type CatalogueView,
  type MachineState,
  type NodeId,
  type Provider,
  type ServerRegistrationId,
  type SessionStatus,
  type SortDirection,
} from '@agentplex/protocol';
import { DOC_KIND, FOLDER_KIND, PROJECT_KIND } from '../tree/node-kinds.js';

/**
 * Everything the catalogue views derive, as functions of values.
 *
 * Two screens are drawn out of one frame here -- the tree the user arranged
 * and the flat list over the same query -- and the reason they are one model
 * is the reason the query is hub-side at all: the order, the paging and the
 * grouping are the hub's answer, and a client that recomputed any of them
 * would be the second opinion decision 4 exists to prevent. So nothing below
 * sorts or groups. What it does is the part the hub cannot: which rows a
 * collapsed folder hides, what a page adds to the pages already held, what to
 * do when a cursor is refused, and what to call a machine in the four
 * characters a tree row has room for.
 *
 * `filterTree` is the one narrowing here and the exception that the rule is
 * about: it narrows what is drawn out of the rows the client already holds,
 * not what the hub answered, and it exists because the number it reports --
 * how many nodes the filter is hiding -- is a fact only the holder of the
 * unnarrowed tree can state. Its own comment argues it.
 *
 * The components in this folder hold what a person clicked and nothing else,
 * which is the pattern AGX-238 and AGX-243 landed on: this stack renders under
 * no jsdom, so a rule that lives in a component is a rule no test can reach.
 */

/**
 * How many items a page asks for.
 *
 * Well under the hub's own clamp (`CATALOGUE_PAGE_MAX_LIMIT`, 200), because
 * this number is what a person waits for before seeing anything: fifty rows
 * fill a sidebar several times over, and the rest is one click away. It is
 * also what makes virtualised rendering unnecessary here -- the ticket asked
 * for the argument, and it is this: the DOM holds `limit` rows per page the
 * user asked for, so the row count is bounded by an act rather than by the
 * size of the catalogue. A tree that needs windowing is a tree somebody paged
 * into a hundred times, and the honest fix for that is a narrower filter.
 */
export const CATALOGUE_PAGE_LIMIT = 50;

/**
 * What is said, once, when the hub refuses the cursor a page was asked with.
 *
 * The refusal is the hub's design working: a cursor names a position in an
 * order computed at a version that has since moved, and resuming into an order
 * that changed underneath would skip or repeat rows silently. All three
 * refusals it can be -- stale, not minted here, belongs to another query --
 * have the same remedy, so the view does not read the sentence to decide what
 * to do with it. It says this and shows the first page again.
 */
export const STALE_PAGE_NOTICE =
  'the catalogue changed while this was paging, so it is shown from the top again';

/** The four things a query is, minus the cursor and the limit the view owns. */
export interface CatalogueShape {
  readonly view: CatalogueView;
  readonly groupBy: CatalogueGroupBy;
  readonly sort: CatalogueSort;
  readonly filter: CatalogueFilter;
}

/**
 * The tree, ungrouped, by name.
 *
 * The tree and not the list, because the first question a sidebar answers is
 * "where did I put things", and the arrangement is its own answer to that. The
 * list is one click away and is where the grouping controls become useful --
 * in a tree the containment already is the grouping, which is why the hub
 * labels items in the tree view and reorders nothing.
 */
export const DEFAULT_SHAPE: CatalogueShape = {
  view: 'tree',
  groupBy: 'none',
  sort: { key: 'name', direction: 'asc' },
  filter: {},
};

export function queryFor(shape: CatalogueShape, cursor: string | null): CatalogueQuery {
  return {
    view: shape.view,
    groupBy: shape.groupBy,
    sort: shape.sort,
    filter: shape.filter,
    cursor,
    limit: CATALOGUE_PAGE_LIMIT,
  };
}

/**
 * One control's worth of narrowing, as the control hands it over.
 *
 * A string and a `null`, because that is what a select gives back, and it is
 * parsed here rather than cast: the options are built out of a machine state
 * that may have moved since the menu opened, and a value that is no longer a
 * provider narrows by nothing rather than riding onto the wire as one.
 */
export type FilterChange =
  | { readonly field: 'server'; readonly value: string | null }
  | { readonly field: 'provider'; readonly value: string | null }
  | { readonly field: 'status'; readonly value: string | null }
  | { readonly field: 'search'; readonly value: string };

export function withFilter(shape: CatalogueShape, change: FilterChange): CatalogueShape {
  const filter = { ...shape.filter };
  switch (change.field) {
    case 'search': {
      const search = change.value.slice(0, CATALOGUE_SEARCH_MAX_CHARS);
      // An empty box is the absence of a constraint and not a constraint on
      // the empty string, which is what the filter schema means by optional.
      if (search.trim() === '') delete filter.search;
      else filter.search = search;
      break;
    }
    case 'server': {
      const parsed = serverRegistrationIdSchema.safeParse(change.value);
      if (parsed.success) filter.server = parsed.data;
      else delete filter.server;
      break;
    }
    case 'provider': {
      const parsed = providerSchema.safeParse(change.value);
      if (parsed.success) filter.provider = parsed.data;
      else delete filter.provider;
      break;
    }
    case 'status': {
      const parsed = sessionStatusSchema.safeParse(change.value);
      if (parsed.success) filter.status = parsed.data;
      else delete filter.status;
      break;
    }
  }
  return { ...shape, filter };
}

export function withView(shape: CatalogueShape, view: CatalogueView): CatalogueShape {
  return { ...shape, view };
}

export function withGroupBy(shape: CatalogueShape, groupBy: CatalogueGroupBy): CatalogueShape {
  return { ...shape, groupBy };
}

export function withSort(
  shape: CatalogueShape,
  key: CatalogueSortKey,
  direction: SortDirection,
): CatalogueShape {
  return { ...shape, sort: { key, direction } };
}

/** Whether anything at all is narrowing, which is what an "all" state means. */
export function isNarrowed(shape: CatalogueShape): boolean {
  return Object.keys(shape.filter).length > 0;
}

/**
 * The pages held so far, as one answer.
 *
 * `version` is what makes an append safe: a page computed at a version other
 * than the one already held is not more of the same answer, it is a different
 * answer, and appending it would interleave two orders. That cannot normally
 * happen -- the hub refuses the cursor first -- and this is the belt to that
 * brace, stated where a test can reach it.
 */
export interface CataloguePages {
  readonly items: readonly CatalogueItem[];
  /** Where the next page resumes, or `null` when this is the whole answer. */
  readonly nextCursor: string | null;
  /** The count before paging: the 340 in "12 of 340". */
  readonly total: number;
  readonly version: number | null;
  /** False until the first page has arrived, which is not the same as empty. */
  readonly answered: boolean;
}

export const NO_PAGES: CataloguePages = {
  items: [],
  nextCursor: null,
  total: 0,
  version: null,
  answered: false,
};

/** What the hub answered, in the shape the store keeps it. */
export interface CataloguePage {
  readonly items: readonly CatalogueItem[];
  readonly nextCursor: string | null;
  readonly total: number;
  readonly version: number;
}

export function pageAdopted(
  held: CataloguePages,
  page: CataloguePage,
  mode: 'replace' | 'append',
): CataloguePages {
  const appending = mode === 'append' && held.version === page.version;
  return {
    items: appending ? [...held.items, ...page.items] : page.items,
    nextCursor: page.nextCursor,
    total: page.total,
    version: page.version,
    answered: true,
  };
}

/** "12 of 340", or just the count once the pages hold the whole answer. */
export function countLabel(pages: CataloguePages): string {
  const held = pages.items.length;
  if (held >= pages.total) return String(pages.total);
  return `${String(held)} of ${String(pages.total)}`;
}

/** What is collapsed while a tree filter is on. See `RowOptions.filtering`. */
const NOTHING_COLLAPSED: ReadonlySet<NodeId> = new Set();

/** One row of either view: a heading, or an item at a depth. */
export type CatalogueRow =
  | { readonly kind: 'group'; readonly key: string; readonly group: CatalogueGroup }
  | {
      readonly kind: 'item';
      readonly key: string;
      readonly item: CatalogueItem;
      /** Indentation. Always zero in the list view, which has no containment. */
      readonly depth: number;
      /** Whether this row has a disclosure at all. */
      readonly expandable: boolean;
      /** Whether that disclosure is closed. */
      readonly collapsed: boolean;
      /**
       * How many sessions are under it, or `null` when that cannot be said.
       *
       * `null` while pages remain: a count over the rows that happen to have
       * loaded is a number that would climb as somebody pages, and a container
       * labelled "3" that becomes "11" on a click was never counting anything.
       */
      readonly sessions: number | null;
    };

export interface RowOptions {
  readonly view: CatalogueView;
  readonly collapsed: ReadonlySet<NodeId>;
  /**
   * Whether a tree filter is narrowing these items, which changes two things.
   *
   * The collapsed folders stop being honoured: a disclosure closed last week
   * is an arrangement of the whole tree, not an answer to "where is the thing
   * I typed", and it must not be sitting over the hit. It is also what makes
   * `filterNote` honest -- with the filter the only thing hiding anything, one
   * number accounts for every node held and not drawn.
   *
   * And no row offers a disclosure, because there is nothing left for one to
   * do. A chevron that still wrote the arrangement would have somebody
   * reordering their tree by trying to open a folder that is already open, and
   * the write is a real one: it goes to the hub and to every other client.
   * Nothing is written while this is true, so clearing the box brings the
   * closed folders back exactly as they were.
   */
  readonly filtering?: boolean;
}

/**
 * The rows to draw, from the items the pages hold.
 *
 * Order is the hub's, untouched. Two things are decided here and both are
 * about what a client knows that the frame does not: which rows an ancestor
 * the user closed is hiding, and where a heading falls.
 *
 * Headings are drawn in the list view only. In a tree the containment *is* the
 * grouping -- the hub says so and reorders nothing for `groupBy` there -- so a
 * heading over tree rows would be a second arrangement laid over the one the
 * user made, disagreeing with it about where a thing is.
 */
export function rowsFor(
  items: readonly CatalogueItem[],
  options: RowOptions,
): readonly CatalogueRow[] {
  if (options.view === 'list') return listRows(items);
  return treeRows(items, options.collapsed, options.filtering ?? false);
}

function listRows(items: readonly CatalogueItem[]): readonly CatalogueRow[] {
  const rows: CatalogueRow[] = [];
  let heading: string | null = null;
  for (const item of items) {
    const group = item.group;
    if (group !== null) {
      // The key and not the label: two projects a person named the same thing
      // are two places, and a heading that merged them would say otherwise.
      const key = group.key ?? 'unfiled';
      if (key !== heading) {
        heading = key;
        rows.push({ kind: 'group', key: `group:${key}`, group });
      }
    }
    rows.push({
      kind: 'item',
      key: item.id,
      item,
      depth: 0,
      expandable: false,
      collapsed: false,
      sessions: null,
    });
  }
  return rows;
}

function treeRows(
  items: readonly CatalogueItem[],
  asked: ReadonlySet<NodeId>,
  filtering: boolean,
): readonly CatalogueRow[] {
  // See `RowOptions.filtering`: a filter answers a question the arrangement is
  // not the answer to, so while one is on nothing is closed and nothing offers
  // to close.
  const collapsed = filtering ? NOTHING_COLLAPSED : asked;
  const present = new Set(items.map((item) => item.id));
  const childCount = new Map<NodeId, number>();
  for (const item of items) {
    if (item.parentId === null) continue;
    childCount.set(item.parentId, (childCount.get(item.parentId) ?? 0) + 1);
  }

  // Whether each id is hidden by something above it. The hub sends parents
  // before children, so one forward pass answers it -- and a row whose parent
  // is not on the page at all is drawn: a page that resumed inside a subtree
  // cannot say the ancestor it never saw was closed.
  const hidden = new Set<NodeId>();
  for (const item of items) {
    const parent = item.parentId;
    if (parent === null || !present.has(parent)) continue;
    if (hidden.has(parent) || collapsed.has(parent)) hidden.add(item.id);
  }

  const rows: CatalogueRow[] = [];
  for (const item of items) {
    if (hidden.has(item.id)) continue;
    const expandable = !filtering && (isContainer(item.kind) || (childCount.get(item.id) ?? 0) > 0);
    rows.push({
      kind: 'item',
      key: item.id,
      item,
      depth: item.depth,
      expandable,
      collapsed: expandable && collapsed.has(item.id),
      sessions: null,
    });
  }
  return rows;
}

/** What the tree filter kept, and how much of the tree it took away. */
export interface FilteredTree {
  /** The items given, in the order they were given, minus what was filtered. */
  readonly items: readonly CatalogueItem[];
  /** How many of the items handed in are not in `items`. */
  readonly hidden: number;
}

/**
 * The tree narrowed by what somebody typed into the filter box.
 *
 * This is the one narrowing in this file, and the exception is deliberate. It
 * is not a second opinion about the hub's answer: the order, the paging, the
 * grouping and every field of `CatalogueFilter` are still the hub's and are
 * untouched here. It is a question about the rows already on screen -- "which
 * of these is the one I am after" -- answered without a round trip, and the
 * reason it cannot be the hub's is `filterNote`: the count of what a filter
 * hid is a fact about the tree the client was holding when it typed, and a
 * hub that answered a narrower query would have counted nothing.
 *
 * Case-insensitive substring over `displayName`, which is the name on the row
 * -- a person types what they can see, so matching anything else would hide a
 * row whose visible name contains what they typed. Every ancestor of a hit is
 * kept, by the rule the hub's own tree order states: a folder is not the thing
 * being filtered for, it is where the thing is, and dropping it would move the
 * hit somewhere it is not. Nothing else is: a child of a container that
 * matched is a row the filter was asked to take away, which is the same answer
 * the hub gives its own search and keeps the two narrowings one rule rather
 * than two.
 */
export function filterTree(items: readonly CatalogueItem[], filter: string): FilteredTree {
  const needle = filter.trim().toLocaleLowerCase();
  if (needle === '') return { items, hidden: 0 };

  const parents = new Map<NodeId, NodeId | null>(items.map((item) => [item.id, item.parentId]));
  const kept = new Set<NodeId>();
  for (const item of items) {
    if (!item.displayName.toLocaleLowerCase().includes(needle)) continue;
    // Up to the root, stopping at the first ancestor already kept: that both
    // saves re-walking a shared spine and terminates the walk if the ids ever
    // describe a cycle, which nothing in the hub can write but a client that
    // hangs on one would be a client that hangs.
    let walking: NodeId | null = item.id;
    while (walking !== null && !kept.has(walking)) {
      kept.add(walking);
      walking = parents.get(walking) ?? null;
    }
  }

  const remaining = items.filter((item) => kept.has(item.id));
  return { items: remaining, hidden: items.length - remaining.length };
}

/**
 * The line under a filtered tree that says what the filter is not showing.
 *
 * The substance of AGX-135, and the reason the filter is drawn at all: a tree
 * that quietly omits branches lets somebody conclude a thing is not there when
 * it is only hidden. So the count is stated, and it accounts for every node
 * the client holds and is not drawing -- while a filter is on, nothing else is
 * hiding anything, because `rowsFor` stops honouring the collapsed folders for
 * as long as one is typed.
 *
 * `whole` is whether the pages held are the whole answer, and both sentences
 * need it. A filter that matched none of the fifty rows loaded so far would
 * otherwise say the catalogue holds nothing like this, and a bare "12 hidden
 * by filter" under a tree with a "Load more" button under that would be read
 * as twelve out of everything there is. Both are claims about pages nobody has
 * asked for yet. Each says what it holds instead.
 */
export function filterNote(filtered: FilteredTree, whole: boolean): string | null {
  if (filtered.hidden === 0) return null;
  if (filtered.items.length === 0) {
    return whole
      ? 'nothing in the tree matches this filter'
      : 'nothing loaded so far matches this filter';
  }
  const count = `${String(filtered.hidden)} hidden by filter`;
  return whole ? count : `${count}, of what has loaded so far`;
}

/**
 * How many sessions sit under each container, for the whole answer or not at
 * all.
 *
 * Kept apart from `rowsFor` because it is the one derivation that needs to
 * know whether the pages are complete, and because it needs every item rather
 * than the visible ones: a closed folder's count is exactly the thing its
 * closed rows were hiding.
 */
export function sessionCounts(pages: CataloguePages): ReadonlyMap<NodeId, number> {
  const counts = new Map<NodeId, number>();
  if (pages.nextCursor !== null || !pages.answered) return counts;
  const parents = new Map<NodeId, NodeId | null>(
    pages.items.map((item) => [item.id, item.parentId]),
  );
  for (const item of pages.items) {
    if (item.anchor === null) continue;
    const seen = new Set<NodeId>([item.id]);
    let walking = item.parentId;
    while (walking !== null && !seen.has(walking)) {
      seen.add(walking);
      counts.set(walking, (counts.get(walking) ?? 0) + 1);
      walking = parents.get(walking) ?? null;
    }
  }
  return counts;
}

/** What a narrowing control may offer: an id to send and a word to show. */
export interface FilterOption {
  readonly value: string;
  readonly label: string;
}

export interface FilterOptions {
  readonly providers: readonly FilterOption[];
  readonly statuses: readonly FilterOption[];
}

/**
 * The narrowings the fleet actually offers.
 *
 * Each list is empty below two entries, which is the same instruction the
 * session list's `chipCounts` gives and it is the screen's rule for whether to
 * draw a control at all: a menu with one option in it is one effective choice
 * wearing a control, and picking that option narrows nothing.
 *
 * There is no machine control here, though the filter has a `server` field and
 * this panel once drew a select for it: the machine selector above the tabs is
 * that control now (AGX-123), and it is one control because the selection is
 * one fact -- it narrows this query and the cards beside it together, and two
 * controls writing it would be two places it could be moved from. There is
 * deliberately no store control either, though the session list has one:
 * `catalogueFilterSchema` has no store constraint, and a client-side store
 * filter would leave the rows on screen disagreeing with the `total` the hub
 * counted them against.
 *
 * Status is the five wire statuses and not the session list's four chips, for
 * the same reason in the other direction: the chips group `awaiting-permission`
 * and `awaiting-input` into one, because they are one situation to a person,
 * and the filter takes exactly one status. A "needs you" chip here would have
 * to be two queries whose `total`s could not be added up.
 */
export function filterOptions(state: MachineState | null): FilterOptions {
  if (state === null) return { providers: [], statuses: [] };
  const providers = new Set<Provider>();
  const statuses = new Set<SessionStatus>();
  for (const store of state.stores) {
    for (const row of store.sessions) {
      providers.add(row.descriptor.provider);
      statuses.add(row.descriptor.status);
    }
  }
  return {
    providers: atLeastTwo([...providers].map((provider) => ({ value: provider, label: provider }))),
    statuses: atLeastTwo([...statuses].map((status) => ({ value: status, label: status }))),
  };
}

function atLeastTwo(options: readonly FilterOption[]): readonly FilterOption[] {
  return options.length < 2 ? [] : options;
}

/**
 * Every machine label in the fleet, short, by the id a session row names.
 *
 * Over the whole fleet and not over the page, which is the point of computing
 * it here: an abbreviation that is unambiguous among the four rows on screen
 * and ambiguous among the twelve machines behind them is an abbreviation that
 * changes meaning as somebody scrolls.
 */
export function shortMachinesOf(state: MachineState | null): ReadonlyMap<string, string> {
  const servers = state?.servers ?? [];
  const short = shortMachineLabels(servers.map((server) => server.label));
  const byId = new Map<ServerRegistrationId, string>();
  for (const server of servers) {
    byId.set(server.registrationId, short.get(server.label) ?? server.label);
  }
  return byId;
}

/** The kinds this build knows hold things. See `tree/node-kinds.ts`. */
export function isContainer(kind: string): boolean {
  return kind === FOLDER_KIND || kind === PROJECT_KIND;
}

export function isDoc(kind: string): boolean {
  return kind === DOC_KIND;
}

/**
 * How a name is to be drawn, which the item says and the text cannot.
 *
 * Three, not two, because they are three different claims. A name the user
 * gave is a name. A name that followed a provider's transcript title is one
 * that will move when the provider retitles, and a screen that drew it like a
 * chosen one would be presenting the provider's wording as the person's. A
 * session id is not a name at all.
 */
export type NameStyle = 'given' | 'derived' | 'identifier';

export function nameStyleOf(item: CatalogueItem): NameStyle {
  if (item.nameSource === 'session-id' || item.nameSource === 'none') return 'identifier';
  return item.named && item.nameSource === 'node' ? 'given' : 'derived';
}

/**
 * The one line under a search hit that says why the row is here, or `null`.
 *
 * `null` for a name match, and that is the whole rule: the name is on the row,
 * so saying it matched adds nothing. The other three are facts the row does
 * not otherwise show, and a hit with no visible reason is the thing the
 * `matched` field exists to stop.
 */
export function matchWords(matched: CatalogueMatchField | null): string | null {
  switch (matched) {
    case 'session-id':
      return 'matched the session id';
    case 'cwd':
      return 'matched the working directory';
    case 'server':
      return 'matched the machine';
    case 'name':
    case null:
      return null;
  }
}

/**
 * The quiet second line on a row: what a client can say that the name cannot.
 *
 * Two things, and both are absences rather than facts about the session. A
 * node that anchors a session no connected server is reporting is a row to
 * label, not one to hide and not one to draw as live -- the anchor is the only
 * thing that tells that apart from a folder, which is why the item carries
 * both. And a search hit whose name does not contain what was typed is an
 * unexplained row until the `matched` field explains it.
 */
export function rowNotes(item: CatalogueItem): readonly string[] {
  const notes: string[] = [];
  if (item.anchor !== null && item.session === null) {
    notes.push('no server is reporting this session');
  }
  const match = matchWords(item.matched);
  if (match !== null) notes.push(match);
  return notes;
}

/**
 * A machine's name in the few characters a tree row has: `mbp`, `gpu`, `ci-eu`.
 *
 * The mockup's leaves carry a short label rather than a hostname, and the
 * abbreviation has to stay unambiguous across the set on screen -- two
 * machines abbreviating to one word is worse than two long names, because the
 * row then says something false about where a session is.
 *
 * So it is computed over the whole set at once and not per name. A label is
 * cut at its first dot (a hostname's domain says nothing about which machine
 * it is), split on the separators people build names out of, and taken one
 * segment at a time until it is both long enough to read and unique. `ci-eu-1`
 * reaches `ci-eu` because `ci` is too short to be a word; `mbp-robert` stops at
 * `mbp`; two machines whose names differ only past the segments reported keep
 * their full labels, which is honest -- and two machines a person has actually
 * given the same name are that person's ambiguity, not one this invents a
 * number to paper over.
 */
export const MIN_SHORT_LABEL_CHARS = 3;

export function shortMachineLabels(labels: readonly string[]): ReadonlyMap<string, string> {
  const unique = [...new Set(labels)];
  const segments = new Map(unique.map((label) => [label, segmentsOf(label)]));
  const taken = new Map(unique.map((label) => [label, 1]));

  const shortOf = (label: string): string =>
    (segments.get(label) ?? []).slice(0, taken.get(label) ?? 1).join('-');

  // Bounded by the longest name: every round either lengthens something or
  // stops, and nothing can be lengthened past the segments it has.
  const rounds = Math.max(1, ...unique.map((label) => (segments.get(label) ?? []).length));
  for (let round = 0; round < rounds; round += 1) {
    const byShort = new Map<string, string[]>();
    for (const label of unique) {
      const short = shortOf(label);
      const sharing = byShort.get(short);
      if (sharing === undefined) byShort.set(short, [label]);
      else sharing.push(label);
    }
    let moved = false;
    for (const [short, sharing] of byShort) {
      const ambiguous = sharing.length > 1;
      const tooShort = short.length < MIN_SHORT_LABEL_CHARS;
      if (!ambiguous && !tooShort) continue;
      for (const label of sharing) {
        const available = (segments.get(label) ?? []).length;
        const at = taken.get(label) ?? 1;
        if (at >= available) continue;
        taken.set(label, at + 1);
        moved = true;
      }
    }
    if (!moved) break;
  }

  const short = new Map<string, string>();
  const finalCounts = new Map<string, number>();
  for (const label of unique) {
    const value = shortOf(label);
    finalCounts.set(value, (finalCounts.get(value) ?? 0) + 1);
  }
  for (const label of unique) {
    const value = shortOf(label);
    // Still shared, or nothing left to shorten: the whole label, which says
    // something true where an abbreviation would not.
    short.set(label, value === '' || (finalCounts.get(value) ?? 0) > 1 ? label : value);
  }
  return short;
}

function segmentsOf(label: string): readonly string[] {
  const host = label.split('.')[0] ?? label;
  return host.split(/[-_ ]+/u).filter((segment) => segment !== '');
}
