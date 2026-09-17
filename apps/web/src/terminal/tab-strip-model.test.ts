import { describe, expect, it } from 'vitest';
import { activeTab, tabAfter, tabForKey, type SessionTab } from './tab-strip-model.js';

/**
 * The strip's two questions, asked of the lists it will really be handed: the
 * one tab that exists today, and the four the mockup draws once Transcript,
 * Diff and Approvals land. Nothing here knows how many there are supposed to
 * be, which is the point -- a strip that assumed four would draw three empty
 * slots for a year.
 */

function tab(id: string, label: string, badge: string | null = null): SessionTab {
  return { id, label, badge };
}

const ONE: readonly SessionTab[] = [tab('terminal', 'Terminal')];
const FOUR: readonly SessionTab[] = [
  tab('terminal', 'Terminal'),
  tab('transcript', 'Transcript'),
  tab('diff', 'Diff', '+142 -38'),
  tab('approvals', 'Approvals', '3'),
];

describe('which tab a strip is showing', () => {
  it('shows the one asked for while it is in the strip', () => {
    expect(activeTab(FOUR, 'diff')).toBe('diff');
  });

  it('falls back to the first tab when the one asked for is not there', () => {
    // The case this exists for: a pane remembers Approvals, the layout
    // reopens it beside a session whose approvals tab has not shipped yet or
    // has nothing to show, and a strip that trusted the request would
    // highlight nothing and draw an empty panel.
    expect(activeTab(FOUR, 'nothing-like-this')).toBe('terminal');
    expect(activeTab(ONE, 'approvals')).toBe('terminal');
  });

  it('has nothing to show when there are no tabs at all', () => {
    expect(activeTab([], 'terminal')).toBeNull();
  });
});

describe('stepping along a strip', () => {
  it('moves one tab in the direction asked', () => {
    expect(tabAfter(FOUR, 'terminal', 1)).toBe('transcript');
    expect(tabAfter(FOUR, 'diff', -1)).toBe('transcript');
  });

  it('wraps at both ends, so the arrows never dead-end', () => {
    expect(tabAfter(FOUR, 'approvals', 1)).toBe('terminal');
    expect(tabAfter(FOUR, 'terminal', -1)).toBe('approvals');
  });

  it('stays put when there is only one tab to be on', () => {
    expect(tabAfter(ONE, 'terminal', 1)).toBe('terminal');
    expect(tabAfter(ONE, 'terminal', -1)).toBe('terminal');
  });

  it('starts at the beginning when the strip does not hold the current tab', () => {
    expect(tabAfter(FOUR, 'nothing-like-this', 1)).toBe('terminal');
  });

  it('goes nowhere from an empty strip', () => {
    expect(tabAfter([], 'terminal', 1)).toBeNull();
  });
});

describe('the keys a strip answers', () => {
  it('walks left and right, and jumps to the ends', () => {
    expect(tabForKey(FOUR, 'transcript', 'ArrowRight')).toBe('diff');
    expect(tabForKey(FOUR, 'transcript', 'ArrowLeft')).toBe('terminal');
    expect(tabForKey(FOUR, 'diff', 'Home')).toBe('terminal');
    expect(tabForKey(FOUR, 'diff', 'End')).toBe('approvals');
  });

  it('leaves every other key to whatever else wants it', () => {
    // Up and Down included: they mean nothing on a row and they are how a
    // phone scrolls a page with a keyboard attached.
    for (const key of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'a', 'Escape']) {
      expect(tabForKey(FOUR, 'diff', key)).toBeNull();
    }
  });

  it('answers nothing for an empty strip, whatever is pressed', () => {
    expect(tabForKey([], 'terminal', 'Home')).toBeNull();
    expect(tabForKey([], 'terminal', 'End')).toBeNull();
    expect(tabForKey([], 'terminal', 'ArrowRight')).toBeNull();
  });
});
