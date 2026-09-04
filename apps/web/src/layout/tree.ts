import { sessionRefSchema, type SessionRef } from '@agentplex/protocol';

/**
 * The split-pane layout tree, and the parser that is the whole reason it can
 * live where it does.
 *
 * The hub stores this tree as characters it never reads (see the protocol's
 * `paneLayoutTextSchema`), which means every shape rule is this module's:
 * what a split is, what a ratio means, which kinds of pane exist. A new pane
 * type is an edit here and no service release anywhere.
 *
 * That placement has a price, and the parser pays it. What comes back from
 * the hub is whatever some client once saved — an older build, a newer one, a
 * hand-edited database — so it is a claim, parsed and never cast, and it
 * degrades in the direction that does not over-claim:
 *
 *   * characters that are not a layout at all become the default layout,
 *     because there is no arrangement in them to preserve;
 *   * a node that is not readable costs itself, not the tree: it becomes an
 *     `unknown` pane that renders as a placeholder and — the half that
 *     matters — keeps the raw value it arrived as, so that saving the tree
 *     writes the stranger's node back out verbatim. An older client passing
 *     through a newer one's layout must not launder it into placeholders.
 *
 * Splits are binary, deliberately: one ratio per split keeps a divider drag
 * one number, and a three-way split is two nested ones. Panes are addressed
 * by path — the run of `first`/`second` choices from the root — rather than
 * by id, because a path needs no minting and no persistence: focus is a fact
 * about this tab, and this tab can point into its own tree.
 */

/** What one pane shows. The closed set today; `unknown` is tomorrow's entry. */
export type PaneContent =
  | { readonly type: 'session'; readonly session: SessionRef }
  /** No session here yet. Later tickets put a picker in it. */
  | { readonly type: 'empty' }
  /**
   * A pane this build cannot read: a newer client's pane type, or damage.
   * `raw` is the value as it arrived, held only to be written back on save.
   */
  | { readonly type: 'unknown'; readonly raw: unknown };

export interface PaneLeaf {
  readonly kind: 'pane';
  readonly content: PaneContent;
}

/** `row` lays first|second side by side; `column` stacks first over second. */
export type SplitDirection = 'row' | 'column';

export interface Split {
  readonly kind: 'split';
  readonly direction: SplitDirection;
  /** The share of the axis the first child takes, within RATIO_BOUNDS. */
  readonly ratio: number;
  readonly first: LayoutTree;
  readonly second: LayoutTree;
}

export type LayoutTree = PaneLeaf | Split;

/** One step into a split; a pane's address is the run of steps from the root. */
export type Branch = 'first' | 'second';
export type PanePath = readonly Branch[];

/**
 * No pane vanishes behind a divider: a ratio is clamped here on parse and on
 * drag, so the smaller pane always keeps a twentieth of the axis.
 */
export const RATIO_BOUNDS = { min: 0.05, max: 0.95 } as const;

/**
 * Deeper than anyone splits a screen, shallow enough that a maliciously
 * nested blob cannot become a stack problem. A node past the cap degrades
 * like any other unreadable node: it costs itself.
 */
const MAX_DEPTH = 16;

/** The version this build writes. Read leniently, written exactly. */
const FORMAT_VERSION = 1;

/** What a screen shows before anyone has arranged anything. */
export const DEFAULT_TREE: LayoutTree = { kind: 'pane', content: { type: 'empty' } };

export function emptyPane(): PaneLeaf {
  return { kind: 'pane', content: { type: 'empty' } };
}

export function sessionPane(session: SessionRef): PaneLeaf {
  return { kind: 'pane', content: { type: 'session', session } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampRatio(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5;
  return Math.min(RATIO_BOUNDS.max, Math.max(RATIO_BOUNDS.min, value));
}

/** The placeholder an unreadable node degrades to, its arrival value kept. */
function unknownPane(raw: unknown): PaneLeaf {
  return { kind: 'pane', content: { type: 'unknown', raw } };
}

/** A readable pane content, or `null` for one this build cannot read. */
function parseContent(raw: unknown): PaneContent | null {
  if (!isRecord(raw)) return null;
  if (raw['type'] === 'empty') return { type: 'empty' };
  if (raw['type'] === 'session') {
    const session = sessionRefSchema.safeParse(raw['session']);
    // A session pane whose ref does not parse is not a session pane with a
    // guess in it; it is a pane this build cannot honestly show.
    return session.success ? { type: 'session', session: session.data } : null;
  }
  return null;
}

function parseNode(raw: unknown, depth: number): LayoutTree {
  if (depth > MAX_DEPTH || !isRecord(raw)) return unknownPane(raw);
  if (raw['kind'] === 'pane') {
    const content = parseContent(raw['content']);
    // The whole node is kept when the content is strange, so that a save
    // writes back what arrived rather than this build's reading of half of it.
    return content === null ? unknownPane(raw) : { kind: 'pane', content };
  }
  if (raw['kind'] === 'split') {
    const direction = raw['direction'];
    if (direction !== 'row' && direction !== 'column') return unknownPane(raw);
    return {
      kind: 'split',
      direction,
      ratio: clampRatio(raw['ratio']),
      first: parseNode(raw['first'], depth + 1),
      second: parseNode(raw['second'], depth + 1),
    };
  }
  return unknownPane(raw);
}

/**
 * Whatever the hub answered, into a tree this build can render.
 *
 * `null` is the hub saying nothing was ever saved, and characters that carry
 * no layout at all — not JSON, not the envelope — read as the same fact:
 * there is no arrangement in them to keep, so the answer is the default
 * layout rather than a screen-wide placeholder. Anything below the envelope
 * degrades per node; see the module comment.
 */
export function parsePaneLayout(text: string | null): LayoutTree {
  if (text === null) return DEFAULT_TREE;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return DEFAULT_TREE;
  }
  if (!isRecord(raw) || typeof raw['v'] !== 'number' || !('root' in raw)) return DEFAULT_TREE;
  return parseNode(raw['root'], 0);
}

function encodeNode(node: LayoutTree): unknown {
  if (node.kind === 'pane') {
    switch (node.content.type) {
      case 'session':
        return { kind: 'pane', content: { type: 'session', session: node.content.session } };
      case 'empty':
        return { kind: 'pane', content: { type: 'empty' } };
      case 'unknown':
        // Verbatim: what this build could not read, it must not rewrite.
        return node.content.raw;
    }
  }
  return {
    kind: 'split',
    direction: node.direction,
    ratio: node.ratio,
    first: encodeNode(node.first),
    second: encodeNode(node.second),
  };
}

/** The characters a save carries. The inverse of `parsePaneLayout`. */
export function serializePaneLayout(tree: LayoutTree): string {
  return JSON.stringify({ v: FORMAT_VERSION, root: encodeNode(tree) });
}
