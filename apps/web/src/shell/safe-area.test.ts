import { describe, expect, it } from 'vitest';
import { withSafeArea } from './safe-area.js';

/**
 * The inset arithmetic, pinned as strings. jsdom computes no `env()` and has
 * no display cutout to compute one from, so what a test can hold is the
 * declaration the component writes -- which is the part that was wrong when a
 * bottom bar ended up under a home indicator.
 */

describe('room left for the display cutout', () => {
  it('adds the inset to the padding a side already wanted', () => {
    expect(withSafeArea(8, 'bottom')).toBe('calc(8px + env(safe-area-inset-bottom, 0px))');
  });

  it('falls back to no inset, for every browser that has no such variable', () => {
    // The fallback is not decoration: a browser that does not know the
    // variable drops the whole declaration without one, and the padding the
    // bar asked for goes with it.
    expect(withSafeArea(0, 'left')).toContain(', 0px)');
  });

  it('answers for each side a bar can be pushed off', () => {
    expect(withSafeArea(12, 'left')).toBe('calc(12px + env(safe-area-inset-left, 0px))');
    expect(withSafeArea(12, 'right')).toBe('calc(12px + env(safe-area-inset-right, 0px))');
  });
});
