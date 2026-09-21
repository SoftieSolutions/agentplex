import { z } from 'zod';
import {
  nodeIdSchema,
  nodeKindSchema,
  providerSchema,
  serverRegistrationIdSchema,
  sessionRefSchema,
} from './identity.js';
import { sessionRowSchema } from './machine-state.js';
import { sessionStatusSchema } from './session.js';

/**
 * The catalogue query: what a client asks for when it wants part of the tree.
 *
 * The layout frame answers the whole tree, whole, and that is the right answer
 * for a tree somebody arranged by hand. It stops being the right answer at a
 * few hundred sessions: the frame grows without bound, the client sorts it
 * every time anything moves, and two clients sorting the same rows by their own
 * rules is how two screens come to disagree about one catalogue. So sorting and
 * paging are the hub's, through this frame, which is decision 4 of the design.
 *
 * Three things follow from that and shape everything below.
 *
 * **The hub answers rows whole and the client joins nothing.** A `CatalogueItem`
 * carries the node *and* the session row the fleet state holds for it, rather
 * than an anchor a client would look up in the machine state. A client that had
 * to join would be a client that can be one frame out of step with itself --
 * drawing a page against a state that has moved -- and the join is a few
 * hundred map lookups the hub has already done to sort.
 *
 * **A server is a view and never a node.** A session's identity is
 * `{ storeId, sessionId }` and never the machine, so there is no server row in
 * the tree to group under; grouping by server groups by the reading the fleet
 * state chose (`SessionRow.source`), and a session two servers reported appears
 * once. That is decision 6, and it is why `groupBy: 'server'` is a parameter of
 * a query rather than a kind in `node_kinds`.
 *
 * **The cursor is the hub's, opaque, and refused when it is stale.** It encodes
 * a position in an order this hub computed, and the catalogue version it was
 * computed at. A client that pages across a change would otherwise be handed a
 * page that skips or repeats, silently; `catalogue-changed` already tells it
 * the version moved, so the honest answer to a cursor from before that is to
 * refuse it and say it is stale.
 */

/**
 * Flat, or the tree as it is arranged.
 *
 * Two shapes and not one, because they answer different questions. A list is
 * "what am I working on", sorted by whatever the person is thinking in --
 * recency, machine, name -- and containment is noise in it. A tree is "where
 * did I put things", and its order is the arrangement itself.
 */
export const catalogueViewSchema = z.enum(['list', 'tree']);
export type CatalogueView = z.infer<typeof catalogueViewSchema>;

/**
 * What the items are gathered under.
 *
 * `'server'` is the view mode that replaces a server node kind, and `'project'`
 * groups by the project ancestor a session was filed under. Sessions with
 * neither fall in one catch-all group that the item marks `unfiled`, rather
 * than being dropped: a session nobody has filed is the one most likely to be
 * the one somebody is looking for.
 */
export const catalogueGroupBySchema = z.enum(['none', 'server', 'project']);
export type CatalogueGroupBy = z.infer<typeof catalogueGroupBySchema>;

/**
 * What the order is read off.
 *
 * Three keys and no more. Each is a fact the hub already holds about an item,
 * and each has a stated answer for an item that has none of it -- see
 * `CatalogueItem` for where those answers are written down. A fourth key
 * somebody might want (cost, say) is a protocol change and not a string a
 * client may invent, which is the whole reason this is an enum rather than a
 * column name on the wire.
 */
export const catalogueSortKeySchema = z.enum(['name', 'updatedAt', 'server']);
export type CatalogueSortKey = z.infer<typeof catalogueSortKeySchema>;

export const sortDirectionSchema = z.enum(['asc', 'desc']);
export type SortDirection = z.infer<typeof sortDirectionSchema>;

export const catalogueSortSchema = z.object({
  key: catalogueSortKeySchema,
  direction: sortDirectionSchema,
});
export type CatalogueSort = z.infer<typeof catalogueSortSchema>;

/**
 * How long a search may be.
 *
 * A bound rather than a judgement, for the reason `nodeNameTextSchema` is one:
 * an unbounded string on a frame is something a bug can fill, and what the
 * protocol states about a search box is that it is text and not a document.
 */
export const CATALOGUE_SEARCH_MAX_CHARS = 200;

/**
 * How many kinds one query may name.
 *
 * A bound for the reason the search has one: a list of ids on a frame is
 * something a bug can fill. Sixteen is more kinds than `node_kinds` has ever
 * held and more than any client draws headings for, so a query that runs into
 * it is a query that went wrong rather than one somebody wrote.
 */
export const CATALOGUE_FILTER_MAX_KINDS = 16;

/**
 * What to leave out, as a set of constraints.
 *
 * Every field is optional, and this is the one schema here where optional is
 * right rather than the nullable this protocol otherwise prefers. Elsewhere the
 * distinction is load-bearing -- `cwd: null` is "the provider was asked and
 * records none", which is a different fact from a field nobody filled in. A
 * filter has no such second fact: an absent constraint and a constraint on
 * nothing are the same thing, which is no constraint, and a client sending
 * `{}` is a client filtering by nothing.
 */
export const catalogueFilterSchema = z.object({
  /**
   * Only sessions whose chosen reading came from this server.
   *
   * The *chosen* reading, matching `groupBy: 'server'`: a session on a volume
   * two machines have mounted is one session, and filtering on every server
   * that reported it would put it under both -- which is the duplication a
   * store exists to prevent.
   */
  server: serverRegistrationIdSchema.optional(),
  provider: providerSchema.optional(),
  status: sessionStatusSchema.optional(),
  /** Only what is under this project node, however deep. */
  project: nodeIdSchema.optional(),
  /** Case-insensitive, over the fields `CatalogueItem.matched` names. */
  search: z.string().max(CATALOGUE_SEARCH_MAX_CHARS).optional(),
  /**
   * Only nodes of these kinds -- and, in the list view, the one thing that lets
   * a container be a row at all.
   *
   * The list view drops containers: flat is what it means, and a folder is an
   * arrangement rather than a thing somebody is looking for. That rule is also
   * why a project could never be a search result, because `node_kinds` marks
   * `folder` and `project` containers alike. Absent, that rule stands unchanged
   * and a client that sends no selection gets the leaves it got before this
   * field existed. Present, the flat answer is exactly the kinds named, whether
   * or not they contain: a palette that draws a heading per kind asks for the
   * kinds it draws.
   *
   * A selection of kinds rather than a boolean `includeContainers`, and the
   * argument is `nodeKindSchema`: a kind is a row in `node_kinds` and its id is
   * opaque, so a `graph` kind a later migration seeds is askable here with no
   * protocol change and no client release -- and a kind nothing has seeded
   * simply matches nothing, which is what lets a client ask for it early. The
   * boolean would have handed a palette every folder on the way to a hit for it
   * to drop client-side, spending page slots and making `total` a count of rows
   * the user cannot see.
   *
   * It constrains an item on its own account, like every other field here, so
   * in the tree view the ancestor rule keeps containers on the way to a hit
   * exactly as it does for `search`. An empty list is refused rather than read
   * as either "everything" or "nothing": filtering by nothing is sending no
   * field, so an empty one is a client that computed its selection wrong.
   */
  kinds: z.array(nodeKindSchema).min(1).max(CATALOGUE_FILTER_MAX_KINDS).optional(),
});
export type CatalogueFilter = z.infer<typeof catalogueFilterSchema>;

/**
 * The most items one page may carry.
 *
 * A named constant because the hub clamps to it rather than refusing: a client
 * asking for a thousand asked for something reasonable, and a refusal would
 * leave it unable to read its own catalogue at all. Two hundred is more than a
 * screen holds at any density anybody uses and small enough that the frame is
 * an ordinary message rather than the whole tree with extra steps -- which is
 * the frame this one exists to stop being.
 */
export const CATALOGUE_PAGE_MAX_LIMIT = 200;

/**
 * Where a page resumes, as the hub wrote it and nothing else reads.
 *
 * Opaque, and that is the contract rather than an implementation detail: what
 * it encodes is a position in an order the hub computed, and a client that
 * parsed one would be a client depending on how this hub happens to sort today.
 * `null` is the first page.
 */
export const catalogueCursorSchema = z.string().min(1).max(2_048);

export const catalogueQuerySchema = z.object({
  view: catalogueViewSchema,
  groupBy: catalogueGroupBySchema,
  sort: catalogueSortSchema,
  filter: catalogueFilterSchema,
  /** `null` for the first page. Anything else is a cursor the hub handed out. */
  cursor: catalogueCursorSchema.nullable(),
  /** Clamped to `CATALOGUE_PAGE_MAX_LIMIT`, never refused for being too big. */
  limit: z.int().positive(),
});
export type CatalogueQuery = z.infer<typeof catalogueQuerySchema>;

/**
 * Where the name on an item came from.
 *
 * On the wire because a client styles the three differently and cannot tell
 * them apart from the text. A node's own name is a name; a provider's
 * transcript title is a name that will move when the provider retitles; a
 * session id is not a name at all, and a client that drew it like one would be
 * presenting an opaque identifier as something a person chose.
 *
 * `named` beside it is still the separate fact it always was: whether the
 * *user* chose the node's name, as against discovery following a title.
 */
export const catalogueNameSourceSchema = z.enum([
  /** The node's own `name` column. */
  'node',
  /** The provider's transcript title, for a node nothing has named. */
  'title',
  /** Nothing named it and its provider names nothing: the session's own id. */
  'session-id',
  /** A container with no name, which the tree does not currently allow. */
  'none',
]);
export type CatalogueNameSource = z.infer<typeof catalogueNameSourceSchema>;

/**
 * Which field a search matched, or `null` when nothing was searched for.
 *
 * Stated rather than left to the client to work out, because the client cannot:
 * it would have to re-run the match over the fields it happens to have, in
 * whatever case-folding it happens to use, and get a different answer from the
 * hub that selected the row. What it is for is the one line under a result that
 * says *why* this row is here -- a session whose name matches nothing and whose
 * working directory matches is otherwise an unexplained hit.
 *
 * One field and not a list: the order below is the order the hub tries, and the
 * first hit wins. A row matching on two is a row a person will read the strongest
 * explanation of, which is the one nearest the name.
 */
export const catalogueMatchFieldSchema = z.enum(['name', 'session-id', 'cwd', 'server']);
export type CatalogueMatchField = z.infer<typeof catalogueMatchFieldSchema>;

/**
 * The group an item falls in, or `null` when nothing is grouping.
 *
 * The header is described on every item rather than sent as a header row of its
 * own, and that is the decision this type exists to record. A header row would
 * have to be a `CatalogueItem` with no node behind it -- no id, no kind, no
 * anchor -- which is a second shape every reader would have to branch on, and a
 * page boundary could then land between a header and the rows it heads. Carried
 * per item, the grouping cannot be split from what it groups, and a client draws
 * a header when the key changes.
 */
export const catalogueGroupSchema = z.object({
  /**
   * The group's identity: a server's registration id, a project's node id, or
   * `null` for the unfiled group.
   *
   * An id rather than the label, because the label is a name somebody may
   * change and a client that keyed a collapsed-group memory on it would forget
   * which groups were open the moment a project was renamed.
   */
  key: z.string().min(1).nullable(),
  /** What to draw: the server's label, or the project's name. */
  label: z.string().min(1),
  /**
   * Whether this is the catch-all rather than a group somebody made.
   *
   * A flag and not a magic key, because the two are different things to draw: a
   * project with four sessions in it is a place, and "no project" is the absence
   * of one, which a screen usually puts last and styles quietly.
   */
  unfiled: z.boolean(),
});
export type CatalogueGroup = z.infer<typeof catalogueGroupSchema>;

/**
 * One row of an answer: a node, and everything the hub knows about it.
 *
 * The node half is exactly `layoutNodeSchema`'s fields, restated rather than
 * composed, and the restatement is deliberate: this frame is allowed to grow
 * fields a layout has no business carrying -- a group, a match, a whole session
 * -- and a client reading a layout must not start depending on them.
 */
export const catalogueItemSchema = z.object({
  id: nodeIdSchema,
  /** `null` is the root, which is not a node: see migration 0004. */
  parentId: nodeIdSchema.nullable(),
  kind: nodeKindSchema,
  /** Order among siblings, as the tree stores it. Not the order of this page. */
  position: z.int().nonnegative(),
  /**
   * The node's own name, or `null` when nothing has named it.
   *
   * Still `null` rather than a hub-minted placeholder, for the reason
   * `layoutNodeSchema` gives. What is different here is that the hub also says
   * what it *sorted* by, in `displayName` below, so a client has both the true
   * absence and the string the order was built on.
   */
  name: z.string().min(1).nullable(),
  /** Whether that name came from the user rather than from a transcript title. */
  named: z.boolean(),
  /**
   * What this node points at, or `null` for one that points at nothing.
   *
   * Kept beside `session` rather than replaced by it: an anchor with no session
   * beside it is a node whose session no server can presently see, which is a
   * thing to label, and a client needs the ref to say which one.
   */
  anchor: sessionRefSchema.nullable(),
  /**
   * How deep this node sits, the root's children being zero.
   *
   * Carried rather than derived from `parentId`, because within one page it
   * cannot be derived: a page that resumes in the middle of a subtree holds
   * children whose parents were on the page before. A client indenting off the
   * parent chain would flatten the first rows of every page but the first.
   */
  depth: z.int().nonnegative(),
  /**
   * The name the hub sorted and searched by, after the fallbacks.
   *
   * The one string a client can render without deciding anything, and the one
   * the order is actually in -- a client that rendered its own fallback would
   * draw a list whose order it could not explain.
   */
  displayName: z.string().min(1),
  /** Which of the three the `displayName` came from, so a client can style it. */
  nameSource: catalogueNameSourceSchema,
  /**
   * The fleet state's row for this session, whole, or `null`.
   *
   * `null` for every node that anchors nothing -- a folder, a project, a doc --
   * and also for a session node whose session no connected server currently
   * reports. Those are two different situations and `anchor` is what tells them
   * apart: an anchor with no row is a session that is unreachable or gone.
   *
   * Whole, and exactly the row the machine state carries, because the client
   * joins nothing: the alternative is a client holding a page and a state that
   * disagree, with nothing able to say which is right.
   */
  session: sessionRowSchema.nullable(),
  /** For a project node, the directory it is. `null` for every other kind. */
  directory: z.string().min(1).nullable(),
  /**
   * For a doc node, the server holding the file. `null` for every other kind.
   *
   * Present on the shape and answered `null` by this build: the docs index
   * knows which machine holds a file, and the catalogue query does not read it
   * yet -- a document's machine is named on a listing today and not on a page.
   * The field is on the frame rather than off it because it is what makes this
   * item shape the answer for the whole tree rather than the answer for the
   * part of it a query happens to join today.
   */
  server: serverRegistrationIdSchema.nullable(),
  /** Which group this item falls in, or `null` when `groupBy` is `'none'`. */
  group: catalogueGroupSchema.nullable(),
  /** Which field the search matched, or `null` when nothing was searched for. */
  matched: catalogueMatchFieldSchema.nullable(),
});
export type CatalogueItem = z.infer<typeof catalogueItemSchema>;
