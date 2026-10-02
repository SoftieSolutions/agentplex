import { describe, expect, it } from 'vitest';
import { contrastRatio, relativeLuminance } from './contrast.js';
import { hues, translucent } from './tokens.js';

// Pairs are named hues, not literals: lint keeps every colour in tokens.ts,
// tests included. umbra is black and paper is white.

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white, the two ends of the WCAG scale', () => {
    expect(relativeLuminance(hues.umbra)).toBe(0);
    expect(relativeLuminance(hues.paper)).toBe(1);
  });

  it('reads the channels case-insensitively', () => {
    expect(relativeLuminance(hues.stone.toUpperCase())).toBe(relativeLuminance(hues.stone));
  });

  it('refuses anything but six-digit hex, rather than reading an alpha form as another colour', () => {
    expect(() => relativeLuminance(translucent('paper', 0x80))).toThrow();
    expect(() => relativeLuminance(hues.paper.slice(0, 4))).toThrow();
    expect(() => relativeLuminance('white')).toThrow();
  });
});

describe('contrastRatio', () => {
  it('is 21:1 for black on white and 1:1 for a colour on itself', () => {
    expect(contrastRatio(hues.umbra, hues.paper)).toBeCloseTo(21, 5);
    expect(contrastRatio(hues.stone, hues.stone)).toBe(1);
  });

  it('does not care which side is the text', () => {
    expect(contrastRatio(hues.moss, hues.paper)).toBe(contrastRatio(hues.paper, hues.moss));
  });

  it('matches the known ratios: stone 3.68 and ochre 2.54 on white, ember 4.96 on soot', () => {
    expect(contrastRatio(hues.stone, hues.paper)).toBeCloseTo(3.68, 2);
    expect(contrastRatio(hues.ochre, hues.paper)).toBeCloseTo(2.54, 2);
    expect(contrastRatio(hues.ember, hues.soot)).toBeCloseTo(4.96, 2);
  });
});
