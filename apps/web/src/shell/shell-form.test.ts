import { describe, expect, it } from 'vitest';
import { shellForm, WIDE_FROM } from './shell-form.js';

/**
 * The one decision the two forms of the shell turn on, as a function of a
 * number. jsdom has no layout and a headless run has no viewport, so the rule
 * is pinned here rather than through anything rendered: the components are
 * tested by being rendered directly in the form under test.
 */

describe('which form the shell is in', () => {
  it('is the phone chrome below the breakpoint', () => {
    // The widths of the phones the mockups are drawn at, portrait.
    expect(shellForm(320)).toBe('phone');
    expect(shellForm(390)).toBe('phone');
    expect(shellForm(430)).toBe('phone');
  });

  it('is the desk chrome at the breakpoint and above', () => {
    expect(shellForm(WIDE_FROM)).toBe('wide');
    expect(shellForm(1024)).toBe('wide');
    expect(shellForm(2560)).toBe('wide');
  });

  it('changes shape exactly once, and on the edge below the breakpoint', () => {
    expect(shellForm(WIDE_FROM - 1)).toBe('phone');
    expect(shellForm(WIDE_FROM)).toBe('wide');
  });

  it('answers the phone chrome for a width no viewport has', () => {
    // A hidden tab, a window collapsed to nothing, a measurement taken before
    // layout: zero is not an error, and the narrow answer is the one that
    // fits whatever the width turns out to be.
    expect(shellForm(0)).toBe('phone');
  });
});
