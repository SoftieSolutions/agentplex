import { describe, expect, it } from 'vitest';
import { sessionRefSchema } from '@agentplex/protocol';
import {
  closePane,
  findSessionPane,
  moveFocus,
  paneRects,
  panes,
  setPaneContent,
  setRatio,
  splitPane,
} from './operations.js';
import { emptyPane, sessionPane, type LayoutTree } from './tree.js';

const SESSION = sessionRefSchema.parse({ storeId: 'store-work', sessionId: 'session-1' });
const OTHER = sessionRefSchema.parse({ storeId: 'store-work', sessionId: 'session-2' });

/**
 * Left pane beside a right column of two:
 *
 *   +----------+----------+
 *   |          |  other   |
 *   | session  +----------+
 *   |          |  empty   |
 *   +----------+----------+
 */
const ARRANGED: LayoutTree = {
  kind: 'split',
  direction: 'row',
  ratio: 0.5,
  first: sessionPane(SESSION),
  second: {
    kind: 'split',
    direction: 'column',
    ratio: 0.5,
    first: sessionPane(OTHER),
    second: emptyPane(),
  },
};

describe('splitPane', () => {
  it('replaces the pane with a half-and-half split and focuses the new space', () => {
    const changed = splitPane(sessionPane(SESSION), [], 'row');
    expect(changed).not.toBeNull();
    expect(changed?.tree).toEqual({
      kind: 'split',
      direction: 'row',
      ratio: 0.5,
      first: sessionPane(SESSION),
      second: emptyPane(),
    });
    expect(changed?.focus).toEqual(['second']);
  });

  it('answers null for a path that names a split rather than a pane', () => {
    expect(splitPane(ARRANGED, ['second'], 'row')).toBeNull();
  });

  it('does not touch the original tree', () => {
    const before = JSON.stringify(ARRANGED);
    splitPane(ARRANGED, ['first'], 'column');
    expect(JSON.stringify(ARRANGED)).toBe(before);
  });
});

describe('closePane', () => {
  it('promotes the sibling into the parent and focuses its first pane', () => {
    const changed = closePane(ARRANGED, ['first']);
    expect(changed?.tree).toEqual(ARRANGED.kind === 'split' ? ARRANGED.second : null);
    expect(changed?.focus).toEqual(['first']);
  });

  it('promotes a whole subtree, with focus landing inside it', () => {
    const changed = closePane(ARRANGED, ['second', 'first']);
    expect(changed?.tree).toEqual({
      kind: 'split',
      direction: 'row',
      ratio: 0.5,
      first: sessionPane(SESSION),
      second: emptyPane(),
    });
    expect(changed?.focus).toEqual(['second']);
  });

  it('refuses to close the last pane: the screen is not a pane', () => {
    expect(closePane(sessionPane(SESSION), [])).toBeNull();
  });
});

describe('setRatio', () => {
  it('sets a split ratio and clamps it so neither side vanishes', () => {
    const wide = setRatio(ARRANGED, [], 0.7);
    expect(wide?.kind === 'split' && wide.ratio).toBe(0.7);
    const gone = setRatio(ARRANGED, [], 0.001);
    expect(gone?.kind === 'split' && gone.ratio).toBe(0.05);
  });

  it('answers null for a path that names a pane rather than a split', () => {
    expect(setRatio(ARRANGED, ['first'], 0.5)).toBeNull();
  });
});

describe('setPaneContent and findSessionPane', () => {
  it('replaces what a pane shows', () => {
    const tree = setPaneContent(ARRANGED, ['second', 'second'], {
      type: 'session',
      session: SESSION,
    });
    expect(tree === null ? null : findSessionPane(tree, SESSION)).toEqual(['first']);
    // Both panes now show it; the first in tree order is the answer.
  });

  it('finds a showing session by value, and answers null for one not showing', () => {
    expect(findSessionPane(ARRANGED, OTHER)).toEqual(['second', 'first']);
    expect(
      findSessionPane(
        ARRANGED,
        sessionRefSchema.parse({ storeId: 'store-work', sessionId: 'session-9' }),
      ),
    ).toBeNull();
  });
});

describe('paneRects', () => {
  it('gives each pane the share of the unit square its ratios say', () => {
    expect(paneRects(ARRANGED)).toEqual([
      { path: ['first'], rect: { x: 0, y: 0, width: 0.5, height: 1 } },
      { path: ['second', 'first'], rect: { x: 0.5, y: 0, width: 0.5, height: 0.5 } },
      { path: ['second', 'second'], rect: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 } },
    ]);
  });
});

describe('moveFocus', () => {
  it('crosses a vertical boundary to the pane with the widest overlap', () => {
    expect(moveFocus(ARRANGED, ['first'], 'right')).toEqual(['second', 'first']);
  });

  it('moves within a column and back across the boundary', () => {
    expect(moveFocus(ARRANGED, ['second', 'first'], 'down')).toEqual(['second', 'second']);
    expect(moveFocus(ARRANGED, ['second', 'second'], 'up')).toEqual(['second', 'first']);
    expect(moveFocus(ARRANGED, ['second', 'second'], 'left')).toEqual(['first']);
  });

  it('answers null at the edge of the screen', () => {
    expect(moveFocus(ARRANGED, ['first'], 'left')).toBeNull();
    expect(moveFocus(ARRANGED, ['first'], 'up')).toBeNull();
    expect(moveFocus(ARRANGED, ['first'], 'down')).toBeNull();
  });

  it('picks the neighbour most in front of the eye, not the first in tree order', () => {
    // Right side is one tall pane; left is a column. From the tall pane going
    // left, the wider-overlapping left pane depends on the divider: skew the
    // column so its second pane holds most of the shared edge.
    const skewed: LayoutTree = {
      kind: 'split',
      direction: 'row',
      ratio: 0.5,
      first: {
        kind: 'split',
        direction: 'column',
        ratio: 0.2,
        first: sessionPane(SESSION),
        second: sessionPane(OTHER),
      },
      second: emptyPane(),
    };
    expect(moveFocus(skewed, ['second'], 'left')).toEqual(['first', 'second']);
  });
});

describe('panes', () => {
  it('lists every pane in tree order with its path', () => {
    expect(panes(ARRANGED).map(({ path }) => path)).toEqual([
      ['first'],
      ['second', 'first'],
      ['second', 'second'],
    ]);
  });
});
