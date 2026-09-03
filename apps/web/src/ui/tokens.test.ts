import { describe, expect, it } from 'vitest';
import { colorForTone, hues, toneHues, type Tone } from './tokens.js';

describe('hues', () => {
  it('are lowercase six-digit hex, so downstream consumers never re-parse formats', () => {
    for (const [name, value] of Object.entries(hues)) {
      expect(value, name).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('are distinct: two names for one value means one of them is a lie', () => {
    const values = Object.values(hues);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('colorForTone', () => {
  it('resolves every tone to the hue its mapping names', () => {
    for (const tone of Object.keys(toneHues) as Tone[]) {
      expect(colorForTone(tone)).toBe(hues[toneHues[tone]]);
    }
  });
});
