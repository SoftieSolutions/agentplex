import { nodeIdSchema, type NodeId } from '@agentplex/protocol';
import { parsePaneLayout, serializePaneLayout, type LayoutTree } from './tree.js';

/**
 * The one blob the hub stores for this user, and the two arrangements in it.
 *
 * The hub holds exactly one opaque pane-layout string and parses none of it
 * (`paneLayoutTextSchema`), so a second arrangement to remember — which
 * containers of the catalogue tree are closed — is either a second frame on
 * the protocol or a section of this one. It is a section, for two reasons that
 * both come down to there being one writer:
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
 */
export interface Workspace {
  readonly panes: LayoutTree;
  readonly collapsed: readonly NodeId[];
  /** Sections this build did not write and does not read. Kept verbatim. */
  readonly rest: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The ids in the catalogue section, parsed and never cast.
 *
 * An entry that is not a node id is dropped and the rest of the list stands:
 * an unreadable item in a listing costs itself, not the listing. A section
 * from a version this build does not know is dropped whole — a `v` it has
 * never seen is the writer saying the shape is not this one.
 */
function parseCollapsed(raw: unknown): readonly NodeId[] {
  if (!readableSection(raw)) return [];
  const listed = raw['collapsed'];
  if (!Array.isArray(listed)) return [];
  const ids: NodeId[] = [];
  const seen = new Set<string>();
  for (const entry of listed) {
    const parsed = nodeIdSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data)) continue;
    seen.add(parsed.data);
    ids.push(parsed.data);
  }
  return ids.slice(-MAX_REMEMBERED_COLLAPSES);
}

/** Whether a catalogue section is one this build wrote the shape of. */
function readableSection(raw: unknown): raw is Record<string, unknown> {
  return isRecord(raw) && raw['v'] === CATALOGUE_SECTION_VERSION;
}

/**
 * Every top-level key that is neither the envelope's nor this build's.
 *
 * A catalogue section at a version this build has never seen stays here rather
 * than being dropped: it is a newer client's, and passing through it must not
 * be how a person loses it. It is written back verbatim, and overwritten only
 * when this tab has collapsed something of its own to say.
 */
function restOf(raw: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(raw)) return {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'v' || key === 'root') continue;
    if (key === CATALOGUE_SECTION_KEY && readableSection(value)) continue;
    rest[key] = value;
  }
  return rest;
}

/**
 * Whatever the hub answered, as the two arrangements and the remainder.
 *
 * The panes go through `parsePaneLayout`, which already states what characters
 * that are not a layout at all mean; everything this adds degrades the same
 * way, to the empty answer, because a blob with no readable catalogue section
 * in it is a tab that has collapsed nothing.
 */
export function parseWorkspace(text: string | null): Workspace {
  const panes = parsePaneLayout(text);
  if (text === null) return { panes, collapsed: [], rest: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { panes, collapsed: [], rest: {} };
  }
  if (!isRecord(raw)) return { panes, collapsed: [], rest: {} };
  return {
    panes,
    collapsed: parseCollapsed(raw[CATALOGUE_SECTION_KEY]),
    rest: restOf(raw),
  };
}

/**
 * The characters a save carries.
 *
 * The catalogue section is written only when there is something in it, so a
 * tab that has collapsed nothing saves exactly the bytes this build saved
 * before the section existed. That is not tidiness: it means adding the
 * section changed no stored blob that nobody has used it in, and a downgrade
 * to the build before it reads those blobs unchanged.
 */
export function serializeWorkspace(workspace: Workspace): string {
  const collapsed = workspace.collapsed.slice(-MAX_REMEMBERED_COLLAPSES);
  const sections: Record<string, unknown> = { ...workspace.rest };
  if (collapsed.length > 0) {
    sections[CATALOGUE_SECTION_KEY] = { v: CATALOGUE_SECTION_VERSION, collapsed };
  }
  return serializePaneLayout(workspace.panes, sections);
}
