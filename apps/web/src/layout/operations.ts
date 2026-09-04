import type { SessionRef } from '@agentplex/protocol';
import {
  RATIO_BOUNDS,
  emptyPane,
  type Branch,
  type LayoutTree,
  type PaneContent,
  type PaneLeaf,
  type PanePath,
  type SplitDirection,
} from './tree.js';

/**
 * The tree's transforms, as pure functions: tree in, tree out, nothing
 * touched. Purity is what makes each rule below one assertion in a test —
 * splitting, closing, and dragging never meet a component, a socket, or a
 * clock — and it is what lets the store treat "did the tree change" as an
 * identity check when deciding whether a save is owed.
 *
 * Every transform that changes shape also answers where focus should land,
 * because a structural edit invalidates paths and only the transform knows
 * how. Focus itself stays outside: it is a fact about this tab, held by the
 * layout store and never serialized.
 */

export function nodeAt(tree: LayoutTree, path: PanePath): LayoutTree | null {
  let node: LayoutTree = tree;
  for (const branch of path) {
    if (node.kind !== 'split') return null;
    node = node[branch];
  }
  return node;
}

export function paneAt(tree: LayoutTree, path: PanePath): PaneLeaf | null {
  const node = nodeAt(tree, path);
  return node !== null && node.kind === 'pane' ? node : null;
}

/** The replacement, or the tree unchanged when the path names nothing. */
function replaceAt(tree: LayoutTree, path: PanePath, replacement: LayoutTree): LayoutTree {
  const branch = path[0];
  if (branch === undefined) return replacement;
  if (tree.kind !== 'split') return tree;
  return { ...tree, [branch]: replaceAt(tree[branch], path.slice(1), replacement) };
}

/** Every pane, left to right and top to bottom, as the tree orders them. */
export function panes(tree: LayoutTree): readonly { path: PanePath; leaf: PaneLeaf }[] {
  if (tree.kind === 'pane') return [{ path: [], leaf: tree }];
  const prefix = (branch: Branch) =>
    panes(tree[branch]).map(({ path, leaf }) => ({ path: [branch, ...path], leaf }));
  return [...prefix('first'), ...prefix('second')];
}

/** Where this session is already showing, or `null` when it is not. */
export function findSessionPane(tree: LayoutTree, session: SessionRef): PanePath | null {
  for (const { path, leaf } of panes(tree)) {
    if (
      leaf.content.type === 'session' &&
      leaf.content.session.storeId === session.storeId &&
      leaf.content.session.sessionId === session.sessionId
    ) {
      return path;
    }
  }
  return null;
}

export interface StructuralChange {
  readonly tree: LayoutTree;
  /** Where focus lands after the change. */
  readonly focus: PanePath;
}

/**
 * Splits the pane at `path` in two: the pane keeps the first half, a fresh
 * empty pane takes the second and the focus — the reason anyone splits is to
 * put something in the new space. `null` when the path names no pane.
 */
export function splitPane(
  tree: LayoutTree,
  path: PanePath,
  direction: SplitDirection,
): StructuralChange | null {
  const pane = paneAt(tree, path);
  if (pane === null) return null;
  const split: LayoutTree = {
    kind: 'split',
    direction,
    ratio: 0.5,
    first: pane,
    second: emptyPane(),
  };
  return { tree: replaceAt(tree, path, split), focus: [...path, 'second'] };
}

/**
 * Closes the pane at `path`, promoting its sibling into the parent's place.
 * Focus lands on the first pane of the promoted subtree. `null` when the path
 * names no pane, or names the root: the last pane is the screen, and closing
 * the screen is not a layout operation.
 */
export function closePane(tree: LayoutTree, path: PanePath): StructuralChange | null {
  if (paneAt(tree, path) === null) return null;
  const parentPath = path.slice(0, -1);
  const closed = path.at(-1);
  if (closed === undefined) return null;
  const parent = nodeAt(tree, parentPath);
  if (parent === null || parent.kind !== 'split') return null;
  const sibling = parent[closed === 'first' ? 'second' : 'first'];
  const promoted = replaceAt(tree, parentPath, sibling);
  const landing = panes(sibling)[0];
  return {
    tree: promoted,
    focus: landing === undefined ? [] : [...parentPath, ...landing.path],
  };
}

/** The split's ratio, clamped so neither side vanishes. `null`: no split there. */
export function setRatio(tree: LayoutTree, path: PanePath, ratio: number): LayoutTree | null {
  const node = nodeAt(tree, path);
  if (node === null || node.kind !== 'split') return null;
  const clamped = Math.min(RATIO_BOUNDS.max, Math.max(RATIO_BOUNDS.min, ratio));
  return replaceAt(tree, path, { ...node, ratio: clamped });
}

/** Replaces what the pane at `path` shows. `null` when the path names no pane. */
export function setPaneContent(
  tree: LayoutTree,
  path: PanePath,
  content: PaneContent,
): LayoutTree | null {
  const pane = paneAt(tree, path);
  if (pane === null) return null;
  return replaceAt(tree, path, { kind: 'pane', content });
}

/** A pane's share of the screen, in unit coordinates. */
export interface PaneRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Every pane with the rectangle the ratios give it, for focus geometry. */
export function paneRects(tree: LayoutTree): readonly { path: PanePath; rect: PaneRect }[] {
  function walk(
    node: LayoutTree,
    rect: PaneRect,
    path: PanePath,
  ): { path: PanePath; rect: PaneRect }[] {
    if (node.kind === 'pane') return [{ path, rect }];
    const first: PaneRect =
      node.direction === 'row'
        ? { ...rect, width: rect.width * node.ratio }
        : { ...rect, height: rect.height * node.ratio };
    const second: PaneRect =
      node.direction === 'row'
        ? { ...rect, x: rect.x + first.width, width: rect.width - first.width }
        : { ...rect, y: rect.y + first.height, height: rect.height - first.height };
    return [
      ...walk(node.first, first, [...path, 'first']),
      ...walk(node.second, second, [...path, 'second']),
    ];
  }
  return walk(tree, { x: 0, y: 0, width: 1, height: 1 }, []);
}

export type FocusDirection = 'left' | 'right' | 'up' | 'down';

const EPSILON = 1e-6;

/**
 * The pane focus moves to, or `null` when nothing lies that way.
 *
 * Geometric rather than structural: what the user sees is rectangles, and
 * "the pane to the left" means the one sharing the boundary the eye crosses,
 * not any relative in the tree. Of the panes across that boundary with any
 * overlap along it, the widest overlap wins — the pane most in front of you.
 */
export function moveFocus(
  tree: LayoutTree,
  from: PanePath,
  direction: FocusDirection,
): PanePath | null {
  const rects = paneRects(tree);
  const key = JSON.stringify(from);
  const origin = rects.find(({ path }) => JSON.stringify(path) === key);
  if (origin === undefined) return null;
  const at = origin.rect;

  const across = (rect: PaneRect): boolean => {
    switch (direction) {
      case 'left':
        return Math.abs(rect.x + rect.width - at.x) < EPSILON;
      case 'right':
        return Math.abs(rect.x - (at.x + at.width)) < EPSILON;
      case 'up':
        return Math.abs(rect.y + rect.height - at.y) < EPSILON;
      case 'down':
        return Math.abs(rect.y - (at.y + at.height)) < EPSILON;
    }
  };

  const overlap = (rect: PaneRect): number =>
    direction === 'left' || direction === 'right'
      ? Math.min(at.y + at.height, rect.y + rect.height) - Math.max(at.y, rect.y)
      : Math.min(at.x + at.width, rect.x + rect.width) - Math.max(at.x, rect.x);

  let best: { path: PanePath; size: number } | null = null;
  for (const { path, rect } of rects) {
    if (!across(rect)) continue;
    const size = overlap(rect);
    if (size <= EPSILON) continue;
    if (best === null || size > best.size) best = { path, size };
  }
  return best?.path ?? null;
}
