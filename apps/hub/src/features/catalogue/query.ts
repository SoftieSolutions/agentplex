import {
  CATALOGUE_PAGE_MAX_LIMIT,
  type CatalogueGroup,
  type CatalogueItem,
  type CatalogueMatchField,
  type CatalogueNameSource,
  type CatalogueQuery,
  type CatalogueSort,
  type MachineState,
  type NodeId,
  type RefusalCode,
  type ServerRegistrationId,
  type SessionRow,
} from '@agentplex/protocol';
import { z } from 'zod';
import type { Queryable } from '../../db/database.js';
import { sessionKey, type SessionProject } from '../fleet-state/fleet-state.js';
import { listNodeKinds, listNodes } from './reads.js';
import { PROJECT_KIND, type TreeNode } from './rows.js';

/**
 * The catalogue query: one page of the tree, shaped, filtered, sorted and cut.
 *
 * ## Why this is a walk in TypeScript and not a statement in SQL
 *
 * The whole of this runs over rows one `SELECT` brought back, and that is a
 * decision rather than a shortcut.
 *
 * The order this answers in is depth-first with a per-request sibling
 * comparator over facts that are not in the database at all. Two of the three
 * sort keys -- `updatedAt` and `server` -- come from the fleet state, which is
 * in memory and is rebuilt by every scan; they are not columns, and no index
 * can reach them. The third, `name`, is a column only when a node has one: a
 * session nobody named sorts by its transcript title, which is again the fleet
 * state's. A SQL order would therefore have to be an order over a temporary
 * table the hub had just written from memory, per request, to sort a few
 * hundred rows.
 *
 * Depth-first is the second half of the argument, and `reads.ts` already made
 * it for `orderDepthFirst`: in SQLite it is a recursive CTE over a
 * lexicographically sortable path built from `printf`-padded positions, and the
 * padding width is a silent upper bound on how many siblings a folder may hold
 * before the order goes quietly wrong. One person's catalogue is a few hundred
 * nodes.
 *
 * What the choice buys is that the fake database can express it. The fake
 * understands no SQL -- it matches statements against scripted responses -- so
 * a query whose ordering lived in a statement would be untestable anywhere but
 * against a real file, and the paging rules are exactly the part worth testing
 * over a few hundred nodes. Here the seam is one statement (`listNodes`), the
 * fake answers it with rows, and every rule below is reachable from a unit test.
 *
 * The cost, stated: this reads every node to answer any page. At a few hundred
 * nodes that is the same read `layout-request` already does on every keystroke
 * of a rename. The number at which it stops being true is the number at which
 * the nodes stop fitting in one frame either, and that is a different ticket
 * with a different shape -- a materialised ordering the writers maintain, not
 * an index on `nodes(kind, name)`.
 *
 * ## What the cursor is
 *
 * An offset into the order above, plus the catalogue version it was computed
 * at and the shape of the query it belongs to, base64 of a small JSON object.
 * Opaque to the client, parsed and never cast here.
 *
 * Versioned rather than signed. A signature protects a value a client must not
 * forge, and a forged cursor here names a position in that same client's own
 * catalogue -- there is nothing to reach that a first page would not also
 * reach. What actually goes wrong with a cursor is that it goes stale, and a
 * signature does not say so; the version does.
 */

/** What a query came to, in the terms a client is answered in. */
export type CataloguePageOutcome =
  | {
      readonly ok: true;
      readonly items: readonly CatalogueItem[];
      readonly nextCursor: string | null;
      /** The count after the filter and before the cut: "12 of 340". */
      readonly total: number;
      /** The catalogue version this page was computed at. */
      readonly version: number;
    }
  | { readonly ok: false; readonly code: RefusalCode; readonly problem: string };

export interface CatalogueQueryContext {
  /** One statement's worth of nodes. See the module note for why only one. */
  readonly database: Queryable;
  /**
   * The fleet as a client reads it, whole, read at the moment of the query.
   *
   * The published projection rather than the reducer's own snapshot, because
   * what goes on an item is exactly the `SessionRow` the machine state carries:
   * a client holding a page and a state that disagreed about one session would
   * have no way to say which was right, and the cheapest way to make that
   * impossible is for both to be the same object.
   */
  readonly fleet: MachineState;
  /**
   * Which directory each project node is.
   *
   * A map rather than a lookup per node, and read through the projects feature
   * rather than off the `projects` table here: that table is another feature's,
   * and a second reader of it would be a second answer to what a project is.
   */
  readonly directories: ReadonlyMap<NodeId, string>;
  /** The tree's version, which the cursor is pinned to. */
  readonly version: number;
}

/** The cursor's own version, so an older hub's cursor is refused rather than misread. */
const CURSOR_FORMAT = 1;

const cursorSchema = z.object({
  f: z.literal(CURSOR_FORMAT),
  /** The catalogue version the order was computed at. */
  v: z.int().nonnegative(),
  /** The query this position belongs to, minus the limit. See `shapeOf`. */
  s: z.string(),
  /** How many items of the order are already behind the client. */
  o: z.int().nonnegative(),
});
type CursorPosition = z.infer<typeof cursorSchema>;

/**
 * Everything about a query that changes the order, as one string.
 *
 * The limit is deliberately not in it. A client that widens its page size
 * mid-paging has not changed the order, and refusing its cursor would be
 * refusing something that is still exactly true.
 */
function shapeOf(query: CatalogueQuery): string {
  return JSON.stringify([
    query.view,
    query.groupBy,
    query.sort.key,
    query.sort.direction,
    query.filter.server ?? null,
    query.filter.provider ?? null,
    query.filter.status ?? null,
    query.filter.project ?? null,
    query.filter.search ?? null,
  ]);
}

function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

/** Parsed, never cast: a cursor is a word off the network like any other. */
function decodeCursor(text: string): CursorPosition | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = cursorSchema.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

/** A node plus everything the sort, the filter and the search read off it. */
interface Resolved {
  readonly node: TreeNode;
  readonly depth: number;
  readonly session: SessionRow | null;
  readonly serverLabel: string | null;
  readonly server: ServerRegistrationId | null;
  readonly projectId: NodeId | null;
  /** What that project is called, for the heading a grouped page draws. */
  readonly projectLabel: string | null;
  readonly directory: string | null;
  /** Whether this kind may hold children, as `node_kinds` states it. */
  readonly container: boolean;
  readonly displayName: string;
  readonly nameSource: CatalogueNameSource;
  /** The provider-dated time, or `null` for a node with no reading behind it. */
  readonly updatedAt: number | null;
}

export async function queryCatalogue(
  context: CatalogueQueryContext,
  query: CatalogueQuery,
): Promise<CataloguePageOutcome> {
  const shape = shapeOf(query);

  let offset = 0;
  if (query.cursor !== null) {
    const position = decodeCursor(query.cursor);
    if (position === null) {
      return {
        ok: false,
        code: 'bad-request',
        problem: 'that is not a cursor this hub minted',
      };
    }
    if (position.v !== context.version) {
      // Named as stale rather than merely refused, because the client can act
      // on it: it has already been told the version moved by
      // `catalogue-changed`, and what it does next is ask for the first page
      // again rather than retry the same cursor.
      return {
        ok: false,
        code: 'bad-request',
        problem:
          `that cursor is stale: it was minted when the catalogue was at version ` +
          `${String(position.v)} and it is now at ${String(context.version)}. ` +
          'Ask for the first page again.',
      };
    }
    if (position.s !== shape) {
      return {
        ok: false,
        code: 'bad-request',
        problem:
          'that cursor belongs to a different query: the view, grouping, sort or filter ' +
          'has changed, and a position in the old order means nothing in the new one',
      };
    }
    offset = position.o;
  }

  // Two statements: the nodes, and what the schema says a kind is. The second
  // is what the list view flattens by -- "not a container" is `node_kinds`'
  // own word, and a build that judged it by naming the kinds it knows would be
  // a build that meets a kind added by a later migration and guesses.
  const [kinds, nodes] = await Promise.all([
    listNodeKinds(context.database),
    listNodes(context.database),
  ]);
  const containers = new Set(kinds.filter((kind) => kind.container).map((kind) => kind.kind));
  const resolved = resolveAll(nodes, containers, context);
  const ordered =
    query.view === 'list' ? listOrder(resolved, query) : treeOrder(nodes, resolved, query);

  const total = ordered.length;
  const limit = Math.min(query.limit, CATALOGUE_PAGE_MAX_LIMIT);
  const end = pageEnd(ordered, offset, limit, query.view);
  const page = ordered.slice(offset, end);

  const groups = groupsFor(page, query);
  const matches = matchesFor(page, query);

  return {
    ok: true,
    items: page.map((item, index) => ({
      id: item.node.id,
      parentId: item.node.parentId,
      kind: item.node.kind,
      position: item.node.position,
      name: item.node.name,
      named: item.node.named,
      anchor: item.node.anchor,
      depth: item.depth,
      displayName: item.displayName,
      nameSource: item.nameSource,
      session: item.session,
      directory: item.directory,
      // Filled by nothing in this build. The field is a doc's server, the
      // rows that make a node a doc are stack D's migration, and a hub with
      // none of them has no server to name here. It is on the shape now so
      // that this item is the answer for the whole tree rather than for the
      // part of it that exists today.
      server: null,
      group: groups[index] ?? null,
      matched: matches[index] ?? null,
    })),
    nextCursor:
      end < total ? encodeCursor({ f: CURSOR_FORMAT, v: context.version, s: shape, o: end }) : null,
    total,
    version: context.version,
  };
}

/**
 * Every node, with the facts the order is built on attached.
 *
 * Done in one pass over all the nodes rather than lazily per comparison,
 * because a comparator that resolved a project ancestor would walk the parent
 * chain O(n log n) times for an answer that does not change during the sort.
 */
function resolveAll(
  nodes: readonly TreeNode[],
  containers: ReadonlySet<string>,
  context: CatalogueQueryContext,
): ReadonlyMap<NodeId, Resolved> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const sessions = new Map<string, SessionRow>();
  for (const store of context.fleet.stores) {
    for (const row of store.sessions) {
      sessions.set(refKey(store.storeId, row.descriptor.sessionId), row);
    }
  }
  const labels = new Map(
    context.fleet.servers.map((server) => [server.registrationId, server.label]),
  );

  const resolved = new Map<NodeId, Resolved>();
  for (const node of nodes) {
    const session =
      node.anchor === null
        ? null
        : (sessions.get(refKey(node.anchor.storeId, node.anchor.sessionId)) ?? null);
    const server = session?.source ?? null;
    const named = nameOf(node, session);
    const projectId = projectAncestorOf(node, byId);
    resolved.set(node.id, {
      node,
      depth: depthOf(node, byId),
      session,
      server,
      serverLabel: server === null ? null : (labels.get(server) ?? null),
      projectId,
      projectLabel: projectId === null ? null : (byId.get(projectId)?.name ?? null),
      directory: node.kind === PROJECT_KIND ? (context.directories.get(node.id) ?? null) : null,
      container: containers.has(node.kind),
      displayName: named.displayName,
      nameSource: named.nameSource,
      updatedAt: session?.descriptor.updatedAt ?? null,
    });
  }
  return resolved;
}

/** A session ref as one key. JSON, because an opaque id may hold any separator. */
function refKey(storeId: string, sessionId: string): string {
  return JSON.stringify([storeId, sessionId]);
}

/**
 * The name this item sorts, searches and draws by, and where it came from.
 *
 * Three steps, and each is the honest answer when the one before it is absent.
 * A node's own name is what the tree calls it. Failing that, a session node
 * follows its provider's transcript title, which is what discovery would have
 * written had it run since the provider set one. Failing *that*, the session's
 * own id: opaque, but true, and the hub inventing "Untitled session" would be
 * inventing a name the user could then not tell from one they chose.
 *
 * Which step was reached rides on the item, because a client draws the three
 * differently and cannot tell them apart from the text.
 */
function nameOf(
  node: TreeNode,
  session: SessionRow | null,
): { readonly displayName: string; readonly nameSource: CatalogueNameSource } {
  if (node.name !== null) return { displayName: node.name, nameSource: 'node' };
  const title = session?.descriptor.title ?? null;
  if (title !== null) return { displayName: title, nameSource: 'title' };
  if (node.anchor !== null) {
    return { displayName: node.anchor.sessionId, nameSource: 'session-id' };
  }
  // A container with no name. The tree does not currently allow one -- a folder
  // and a project are both named at creation -- so this is the branch that
  // exists so that a row which got there anyway sorts somewhere stated rather
  // than throwing in a comparator.
  return { displayName: node.id, nameSource: 'none' };
}

/** How many ancestors this node has. Stops on a ring rather than spinning. */
function depthOf(node: TreeNode, byId: ReadonlyMap<NodeId, TreeNode>): number {
  let depth = 0;
  const seen = new Set<NodeId>([node.id]);
  let walking = node.parentId;
  while (walking !== null) {
    if (seen.has(walking)) return depth;
    seen.add(walking);
    depth += 1;
    walking = byId.get(walking)?.parentId ?? null;
  }
  return depth;
}

/**
 * The project this node is in, or `null`.
 *
 * A project node is in itself, which is what makes `filter.project` name the
 * project as well as its contents: a client that asked for one project's
 * catalogue and got everything but the project row would have a page it could
 * not put a heading on.
 */
function projectAncestorOf(node: TreeNode, byId: ReadonlyMap<NodeId, TreeNode>): NodeId | null {
  const seen = new Set<NodeId>();
  let walking: TreeNode | undefined = node;
  while (walking !== undefined) {
    if (seen.has(walking.id)) return null;
    seen.add(walking.id);
    if (walking.kind === PROJECT_KIND) return walking.id;
    walking = walking.parentId === null ? undefined : byId.get(walking.parentId);
  }
  return null;
}

/**
 * Where the tree puts each session, for the sessions it puts anywhere, keyed
 * the way the fleet state keys a session.
 *
 * Here and not in `reads.ts` because it is the walk above, run over the rows
 * one `SELECT` brought back: an ancestor relation in SQLite is a recursive CTE,
 * and `reads.ts` has already argued that this tree is a few hundred rows and
 * that the rule is worth more where a test can read it. It is also the same
 * walk a page grouped by project runs, which is the point of it being here
 * rather than written a second time beside the reducer -- two walks would be
 * two answers about one session, free to disagree on a screen drawing both.
 *
 * Absent rather than null for a session in no project. The reducer's map is a
 * reading of where sessions *are*, and a key per session saying "nowhere"
 * would be this walk claiming to know every session there is; it knows only
 * what the tree holds, and a session no node anchors is not in it at all.
 *
 * A project with no name is skipped for the same reason. The row is the name a
 * client draws, so a placement carrying none would put a session under a
 * project the screen could not write down. The tree names a project at
 * creation and nothing can blank it, so this is the branch that exists so a
 * row which got there anyway costs itself and not the reading.
 */
export function sessionProjectsIn(nodes: readonly TreeNode[]): ReadonlyMap<string, SessionProject> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const placements = new Map<string, SessionProject>();
  for (const node of nodes) {
    if (node.anchor === null) continue;
    const projectId = projectAncestorOf(node, byId);
    if (projectId === null) continue;
    const name = byId.get(projectId)?.name ?? null;
    if (name === null) continue;
    placements.set(sessionKey(node.anchor), { nodeId: projectId, name });
  }
  return placements;
}

/**
 * Whether this item survives the filter, on its own account.
 *
 * On its own account is the load-bearing part: in the tree view a container
 * that fails this is still kept when something under it passes, because a
 * folder is not the thing being filtered for -- it is where the thing is.
 */
function passes(item: Resolved, query: CatalogueQuery): boolean {
  const { filter } = query;
  if (filter.server !== undefined && item.server !== filter.server) return false;
  if (filter.provider !== undefined && item.session?.descriptor.provider !== filter.provider) {
    return false;
  }
  if (filter.status !== undefined && item.session?.descriptor.status !== filter.status) {
    return false;
  }
  if (filter.project !== undefined && item.projectId !== filter.project) return false;
  if (
    filter.search !== undefined &&
    filter.search.trim() !== '' &&
    matchOf(item, filter.search) === null
  ) {
    return false;
  }
  return true;
}

/**
 * Which field the search hit, or `null` for a miss.
 *
 * Case-insensitive substring, over four fields in the order a person would
 * explain a hit in: what it is called, what it is, where it ran, and which
 * machine it is on. The first hit wins and is the one reported -- a row that
 * matches on two is a row somebody will read the strongest explanation of.
 */
function matchOf(item: Resolved, search: string): CatalogueMatchField | null {
  const needle = search.trim().toLocaleLowerCase();
  if (needle === '') return null;
  const holds = (value: string | null): boolean =>
    value !== null && value.toLocaleLowerCase().includes(needle);
  // A display name that *is* the session id is reported as the id it is.
  // `nameSource` on the same row already says the fallback was reached, and
  // calling the hit a name match would have the item contradicting itself.
  if (item.nameSource !== 'session-id' && holds(item.displayName)) return 'name';
  if (holds(item.node.anchor?.sessionId ?? null)) return 'session-id';
  if (holds(item.session?.descriptor.cwd ?? null)) return 'cwd';
  if (holds(item.serverLabel)) return 'server';
  return null;
}

/**
 * The list view: session and doc rows, flat, sorted, and gathered into groups.
 *
 * Containers do not appear as rows here. That is what "flat" means: a folder is
 * an arrangement, and the list view is for the question the arrangement is not
 * the answer to. Where the grouping calls for a heading, the heading is
 * described on every item under it rather than sent as a row -- see
 * `catalogueGroupSchema` for why a header row would be a shape a page boundary
 * could split.
 */
function listOrder(
  resolved: ReadonlyMap<NodeId, Resolved>,
  query: CatalogueQuery,
): readonly Resolved[] {
  const leaves = [...resolved.values()].filter((item) => !item.container && passes(item, query));
  const compare = comparatorFor(query.sort);
  if (query.groupBy === 'none') return [...leaves].sort(compare);

  // Grouped, and the groups are ordered by their label with the unfiled one
  // last -- always ascending, whatever the item sort says. A heading order that
  // flipped with the rows under it would move a person's landmarks every time
  // they changed how the rows are sorted, and the sort is a statement about
  // rows rather than about where the headings are.
  const buckets = new Map<string, Resolved[]>();
  for (const item of leaves) {
    const group = groupOf(item, query);
    const key = group === null ? '' : `${group.unfiled ? '1' : '0'} ${group.label}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [item]);
    else bucket.push(item);
  }
  return [...buckets.keys()]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .flatMap((key) => [...(buckets.get(key) ?? [])].sort(compare));
}

/**
 * The tree view: everything, parents before children, siblings in the asked-for
 * order.
 *
 * A container is kept when it passes the filter or when anything under it does.
 * The alternative -- dropping every container that did not match -- turns a
 * search in the tree view into a flat list with tree indentation on it, and a
 * user who searched from a tree wants to see where the hits are.
 *
 * `groupBy` labels the items here and does not reorder them, which is the one
 * decision this file makes that the ticket left open. In a tree the containment
 * *is* the grouping: re-gathering the rows under server headings would be a
 * second arrangement laid over the one the user made, and the two would
 * disagree about where a thing is. A client that wants server headings asks for
 * the list view, where there is no arrangement for them to fight with.
 */
function treeOrder(
  nodes: readonly TreeNode[],
  resolved: ReadonlyMap<NodeId, Resolved>,
  query: CatalogueQuery,
): readonly Resolved[] {
  const children = new Map<NodeId | null, TreeNode[]>();
  for (const node of nodes) {
    const siblings = children.get(node.parentId);
    if (siblings === undefined) children.set(node.parentId, [node]);
    else siblings.push(node);
  }

  // Whether a node or anything under it survives the filter, memoised: without
  // it a deep tree re-walks every subtree once per ancestor.
  const surviving = new Map<NodeId, boolean>();
  const survives = (node: TreeNode, seen: ReadonlySet<NodeId>): boolean => {
    const known = surviving.get(node.id);
    if (known !== undefined) return known;
    if (seen.has(node.id)) return false;
    const item = resolved.get(node.id);
    const walked = new Set([...seen, node.id]);
    const kept =
      (item !== undefined && passes(item, query)) ||
      (children.get(node.id) ?? []).some((child) => survives(child, walked));
    surviving.set(node.id, kept);
    return kept;
  };

  const compare = comparatorFor(query.sort);
  const bySiblings = (left: TreeNode, right: TreeNode): number => {
    const one = resolved.get(left.id);
    const other = resolved.get(right.id);
    if (one === undefined || other === undefined) return 0;
    return compare(one, other);
  };

  const ordered: Resolved[] = [];
  const seen = new Set<NodeId>();
  const visit = (parentId: NodeId | null): void => {
    for (const node of [...(children.get(parentId) ?? [])].sort(bySiblings)) {
      // A cycle cannot be written through this feature; if one exists anyway,
      // this is what stops the walk rather than recursing forever.
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      if (!survives(node, new Set())) continue;
      const item = resolved.get(node.id);
      if (item !== undefined) ordered.push(item);
      visit(node.id);
    }
  };
  visit(null);

  // A node the walk never reached has an ancestry that does not terminate at
  // the root, which nothing in this feature can write. It is appended rather
  // than dropped, for the reason `orderDepthFirst` appends one: an unreadable
  // item in a listing costs itself, not the listing.
  const unreachable = [...resolved.values()].filter(
    (item) => !seen.has(item.node.id) && passes(item, query),
  );
  return [...ordered, ...unreachable.sort(compare)];
}

/**
 * Where this page ends.
 *
 * The cut runs forward past `limit` rather than back short of it whenever
 * stopping there would put a parent at the end of a page and its first child at
 * the start of the next. Forward, because short is the direction that can reach
 * zero: a chain of containers deeper than the limit would trim back to an empty
 * page, and a client paging on an empty page never moves. Forward overshoots by
 * at most the depth of one chain, which is a handful of rows on a tree somebody
 * arranged by hand.
 *
 * In the list view there are no parents on the page, so this is the plain cut.
 */
function pageEnd(
  ordered: readonly Resolved[],
  offset: number,
  limit: number,
  view: CatalogueQuery['view'],
): number {
  let end = Math.min(offset + limit, ordered.length);
  if (view === 'list') return end;
  while (end > offset && end < ordered.length) {
    const last = ordered[end - 1];
    const next = ordered[end];
    if (last === undefined || next === undefined) break;
    if (next.node.parentId !== last.node.id) break;
    end += 1;
  }
  return end;
}

/** The group each item on the page falls in, positionally. */
function groupsFor(
  page: readonly Resolved[],
  query: CatalogueQuery,
): readonly (CatalogueGroup | null)[] {
  return page.map((item) => groupOf(item, query));
}

function matchesFor(
  page: readonly Resolved[],
  query: CatalogueQuery,
): readonly (CatalogueMatchField | null)[] {
  const search = query.filter.search;
  if (search === undefined || search.trim() === '') return page.map(() => null);
  return page.map((item) => matchOf(item, search));
}

/**
 * Which group an item belongs to.
 *
 * Grouping by server groups by the reading the fleet state chose -- one session
 * on a volume two machines have mounted is one session, under one heading --
 * which is the whole of what "server is a view mode" means here. A session
 * nothing currently reports has no reading and no server, so it falls in the
 * unfiled group beside the ones nobody filed: both are "the hub cannot say
 * where this belongs", and a screen draws them the same way.
 */
function groupOf(item: Resolved, query: CatalogueQuery): CatalogueGroup | null {
  if (query.groupBy === 'none') return null;
  if (query.groupBy === 'server') {
    if (item.server === null) {
      return { key: null, label: 'no server reporting', unfiled: true };
    }
    return { key: item.server, label: item.serverLabel ?? item.server, unfiled: false };
  }
  if (item.projectId === null) return { key: null, label: 'no project', unfiled: true };
  return {
    key: item.projectId,
    label: item.projectLabel ?? item.projectId,
    unfiled: false,
  };
}

/**
 * The order, as one comparator.
 *
 * Nulls sort last in both directions, which is the one rule here that is not
 * symmetric and the one that would be wrong if it were. "I do not know when
 * this was last touched" is not a very old time, and flipping to descending
 * must not promote every unknown to the top of the list; the direction is a
 * statement about the values there are.
 *
 * Every key ends in the same two tiebreaks -- the display name, then the node
 * id -- so the order is total. Two clients sorting one set of rows must not be
 * able to disagree, and a comparator that returned 0 for two distinct rows
 * leaves the answer to whatever the engine's sort happens to do.
 */
function comparatorFor(sort: CatalogueSort): (left: Resolved, right: Resolved) => number {
  const flip = sort.direction === 'desc' ? -1 : 1;
  const byName = (left: Resolved, right: Resolved): number =>
    compareText(left.displayName.toLocaleLowerCase(), right.displayName.toLocaleLowerCase());
  const tiebreak = (left: Resolved, right: Resolved): number =>
    byName(left, right) || compareText(left.node.id, right.node.id);

  if (sort.key === 'name') {
    return (left, right) => flip * byName(left, right) || compareText(left.node.id, right.node.id);
  }
  if (sort.key === 'updatedAt') {
    return (left, right) => {
      const absent = compareAbsence(left.updatedAt, right.updatedAt);
      if (absent !== null) return absent;
      const one = left.updatedAt ?? 0;
      const other = right.updatedAt ?? 0;
      return flip * (one - other) || tiebreak(left, right);
    };
  }
  return (left, right) => {
    const absent = compareAbsence(left.serverLabel, right.serverLabel);
    if (absent !== null) return absent;
    return (
      flip * compareText(left.serverLabel ?? '', right.serverLabel ?? '') || tiebreak(left, right)
    );
  };
}

/**
 * The answer when one side has no value, or `null` when both have one.
 *
 * Outside the direction flip on purpose: see `comparatorFor`.
 */
function compareAbsence(left: unknown, right: unknown): number | null {
  if (left === null && right === null) return null;
  if (left === null) return 1;
  if (right === null) return -1;
  return null;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
