import { CATALOGUE_MAX_OPEN_PROJECTS, nodeIdSchema, type NodeId } from '@agentplex/protocol';
import { parsePaneLayout, serializePaneLayout, type LayoutTree } from './tree.js';

/**
 * The one blob the hub stores for this user, and the arrangements in it.
 *
 * The hub holds exactly one opaque pane-layout string and parses none of it
 * (`paneLayoutTextSchema`), so a second arrangement to remember — which
 * containers of the catalogue tree are closed, and which projects are open —
 * is either a second frame on the protocol or a section of this one. Each is a
 * section, for two reasons that both come down to there being one writer:
 *
 *   * A second opaque blob is a second `*-save` frame, a second stored column
 *     and a second migration, to carry a list of ids that is smaller than the
 *     pane tree it would sit beside. The protocol change buys nothing the
 *     bytes need.
 *   * The hub does not echo a save back, so a client that wrote one section
 *     from the answer it was last *given* would write a stale copy of the
 *     other over a change it made a moment ago. One parse, one serialize and
 *     one store (`layout-store.ts`) is what keeps that impossible, and that
 *     store is the sole writer of this blob.
 *
 * Read leniently and written exactly, like the pane tree itself, and for the
 * same reason: what comes back is whatever some client once saved. A section
 * this build cannot read costs itself and nothing else — it is kept verbatim
 * in `rest` and written back untouched, so an older client passing through a
 * newer one's blob does not launder away what it could not understand.
 */

/** The catalogue section's own version, beside the envelope's. */
const CATALOGUE_SECTION_VERSION = 1;

const CATALOGUE_SECTION_KEY = 'catalogue';

/** The projects section's own version, kept apart so either can move alone. */
const PROJECTS_SECTION_VERSION = 1;

const PROJECTS_SECTION_KEY = 'projects';

/**
 * How many closed containers are remembered.
 *
 * The blob is bounded on the wire (`PANE_LAYOUT_MAX_CHARS`), so this list has
 * to be bounded somewhere, and the honest place is here rather than in a
 * refusal the user meets after collapsing one folder too many. The oldest
 * entries go first: a folder nobody has touched in months is the cheapest
 * thing to forget, and forgetting one opens it rather than losing anything.
 */
export const MAX_REMEMBERED_COLLAPSES = 500;

/**
 * What this tab has arranged, as the blob carries it.
 *
 * `collapsed` and not `expanded`, which is the one choice here worth the
 * sentence: a tree persisted as a set of open containers is a tree where
 * everything arrives shut, and a folder created a moment ago would then hide
 * the thing that was just put in it. Collapsing is the deliberate act, so it
 * is the one that is written down; the default is open. Oldest first, so the
 * bound above drops the stalest entry.
 *
 * Projects are the opposite, and `expanded` is written down for them. A
 * project is not a folder somebody just put a thing in: it is the top of the
 * Projects tab, which draws projects and nothing else at its root, and the
 * hub draws a project that is not named open as one row (`openProjects` on the
 * catalogue query). A tab that opened every project by default would ask the
 * hub for the whole tree and page through all of it to show a list of names,
 * which is the cost the closed default exists to avoid. So opening one is the
 * deliberate act here, and the list is bounded by what one query may name,
 * oldest first for the same reason.
 */
export interface Workspace {
  readonly panes: LayoutTree;
  readonly collapsed: readonly NodeId[];
  readonly expanded: readonly NodeId[];
  /** Sections this build did not write and does not read. Kept verbatim. */
  readonly rest: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One section this build reads and writes: where it lives and what it holds. */
interface IdSection {
  readonly key: string;
  readonly version: number;
  /** The field of the section that holds the ids. */
  readonly field: string;
  readonly bound: number;
}

const CATALOGUE_SECTION: IdSection = {
  key: CATALOGUE_SECTION_KEY,
  version: CATALOGUE_SECTION_VERSION,
  field: 'collapsed',
  bound: MAX_REMEMBERED_COLLAPSES,
};

const PROJECTS_SECTION: IdSection = {
  key: PROJECTS_SECTION_KEY,
  version: PROJECTS_SECTION_VERSION,
  field: 'expanded',
  bound: CATALOGUE_MAX_OPEN_PROJECTS,
};

const SECTIONS: readonly IdSection[] = [CATALOGUE_SECTION, PROJECTS_SECTION];

/**
 * The ids in a section, parsed and never cast.
 *
 * An entry that is not a node id is dropped and the rest of the list stands:
 * an unreadable item in a listing costs itself, not the listing. A section
 * from a version this build does not know is dropped whole — a `v` it has
 * never seen is the writer saying the shape is not this one.
 */
function parseIds(raw: unknown, section: IdSection): readonly NodeId[] {
  if (!readableSection(raw, section.version)) return [];
  const listed = raw[section.field];
  if (!Array.isArray(listed)) return [];
  const ids: NodeId[] = [];
  const seen = new Set<string>();
  for (const entry of listed) {
    const parsed = nodeIdSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data)) continue;
    seen.add(parsed.data);
    ids.push(parsed.data);
  }
  return ids.slice(-section.bound);
}

/** Whether a section is one this build wrote the shape of, at `version`. */
function readableSection(raw: unknown, version: number): raw is Record<string, unknown> {
  return isRecord(raw) && raw['v'] === version;
}

/**
 * Every top-level key that is neither the envelope's nor this build's.
 *
 * A section of this build's at a version this build has never seen stays here rather
 * than being dropped: it is a newer client's, and passing through it must not
 * be how a person loses it. It is written back verbatim, and overwritten only
 * when this tab has collapsed something of its own to say.
 */
function restOf(raw: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(raw)) return {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'v' || key === 'root') continue;
    const ours = SECTIONS.find((section) => section.key === key);
    if (ours !== undefined && readableSection(value, ours.version)) continue;
    rest[key] = value;
  }
  return rest;
}

/**
 * Whatever the hub answered, as the arrangements and the remainder.
 *
 * The panes go through `parsePaneLayout`, which already states what characters
 * that are not a layout at all mean; everything this adds degrades the same
 * way, to the empty answer, because a blob with no readable catalogue section
 * in it is a tab that has collapsed nothing, and one with no readable projects
 * section has opened nothing.
 */
export function parseWorkspace(text: string | null): Workspace {
  const panes = parsePaneLayout(text);
  if (text === null) return { panes, collapsed: [], expanded: [], rest: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { panes, collapsed: [], expanded: [], rest: {} };
  }
  if (!isRecord(raw)) return { panes, collapsed: [], expanded: [], rest: {} };
  return {
    panes,
    collapsed: parseIds(raw[CATALOGUE_SECTION_KEY], CATALOGUE_SECTION),
    expanded: parseIds(raw[PROJECTS_SECTION_KEY], PROJECTS_SECTION),
    rest: restOf(raw),
  };
}

/**
 * The characters a save carries.
 *
 * Each section is written only when there is something in it, so a tab that
 * has collapsed and opened nothing saves exactly the bytes this build saved
 * before either section existed. That is not tidiness: it means adding the
 * section changed no stored blob that nobody has used it in, and a downgrade
 * to the build before it reads those blobs unchanged.
 */
export function serializeWorkspace(workspace: Workspace): string {
  const sections: Record<string, unknown> = { ...workspace.rest };
  writeIds(sections, CATALOGUE_SECTION, workspace.collapsed);
  writeIds(sections, PROJECTS_SECTION, workspace.expanded);
  return serializePaneLayout(workspace.panes, sections);
}

/** A section's ids, bounded, written over the key only when there are any. */
function writeIds(
  sections: Record<string, unknown>,
  section: IdSection,
  ids: readonly NodeId[],
): void {
  const bounded = ids.slice(-section.bound);
  if (bounded.length === 0) return;
  sections[section.key] = { v: section.version, [section.field]: bounded };
}
