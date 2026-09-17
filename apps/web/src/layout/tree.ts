import {
  nodeIdSchema,
  sessionRefSchema,
  type FrameId,
  type NodeId,
  type SessionRef,
} from '@agentplex/protocol';

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
 * Adding a kind does not bump the format version, and that is the forward
 * compatibility working in both directions rather than an omission. A build
 * that has never heard of `doc` reads one as an `unknown` pane, keeps the raw
 * node and writes it back verbatim on the next save, so a person with two
 * builds open loses neither arrangement; a version bump would have said the
 * whole document was unreadable to the older one, which is the over-claim.
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
  /**
   * A document, by the node it is. The node id and nothing else, for the
   * reason every doc frame carries one: the file's name, its project and the
   * machine holding it are the hub's rows, and a layout that restated any of
   * them would be a saved arrangement that could contradict the tree.
   */
  | { readonly type: 'doc'; readonly nodeId: NodeId }
  /**
   * A session that has been asked for and has no name yet, held by the handle
   * the asking is already known by: the id of this connection's own
   * `session-start` frame.
   *
   * The gap this fills is the provider's. A fresh spawn has no session id
   * until the provider mints one and writes it, so between the click and that
   * moment there is a process producing output and no `{ storeId, sessionId }`
   * to address it with. The handle is the name that exists in the gap, and it
   * is the frame's own id rather than anything invented here: an id minted in
   * the node-tree's namespace would be a second name for the same act, and one
   * the hub could never agree with. It is also why this never reaches the
   * route -- an address is for a session that exists, and a start handle is
   * local to one socket.
   *
   * Which is the same reason it is not saved: see `encodeNode`, where it
   * serializes as the empty pane it will stop being.
   */
  | { readonly type: 'pending'; readonly startId: FrameId }
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

export function docPane(nodeId: NodeId): PaneLeaf {
  return { kind: 'pane', content: { type: 'doc', nodeId } };
}

export function pendingPane(startId: FrameId): PaneLeaf {
  return { kind: 'pane', content: { type: 'pending', startId } };
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
  if (raw['type'] === 'doc') {
    const nodeId = nodeIdSchema.safeParse(raw['nodeId']);
    return nodeId.success ? { type: 'doc', nodeId: nodeId.data } : null;
  }
  if (raw['type'] === 'pending') {
    // Read as the empty pane it is written as, and not as an unreadable node
    // kept verbatim. A start handle names a frame on one socket: the socket
    // that minted it is gone by the time anything reads this back, so there is
    // no pane here to preserve -- only a claim nothing on this connection
    // could resolve. This build writes none; a build that did would be
    // asserting a local handle at everything that shares the layout.
    return { type: 'empty' };
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
      case 'doc':
        return { kind: 'pane', content: { type: 'doc', nodeId: node.content.nodeId } };
      case 'pending':
      case 'empty':
        // A pending pane is saved as an empty one, which is the only honest
        // thing to write: what it holds is this connection's handle on a start
        // it made, and the tab on the other device that reads this back has no
        // such connection and no way to resolve one. Saving the handle would
        // put a pane on somebody else's screen that could only ever say it was
        // waiting for something that already happened. The arrangement is
        // kept -- the split, the ratio, the place -- and what fills it is not.
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

/**
 * The characters a save carries. The inverse of `parsePaneLayout`.
 *
 * `sections` is everything else the one stored blob holds — the catalogue's
 * expansion state, and any section written by a build this one has never met.
 * They are written back around the panes rather than merged into them, and the
 * panes always win the two keys they own: a section arriving with a `v` or a
 * `root` on it was never this file's to read, and letting one overwrite the
 * arrangement would lose a layout to a stranger's key collision. `workspace.ts`
 * is where the sections are given their shape.
 */
export function serializePaneLayout(
  tree: LayoutTree,
  sections: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify({ ...sections, v: FORMAT_VERSION, root: encodeNode(tree) });
}
