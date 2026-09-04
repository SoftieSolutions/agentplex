import { describe, expect, it } from 'vitest';
import {
  colorForRole,
  colorForTone,
  hues,
  roles,
  toneHues,
  type Role,
  type Scheme,
  type Tone,
} from './tokens.js';

const schemes: Scheme[] = ['dark', 'light'];
const tones: Tone[] = ['running', 'needs-you', 'blocked', 'idle'];

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
  it('resolves every tone in every scheme to the hue its mapping names', () => {
    for (const scheme of schemes) {
      for (const tone of tones) {
        expect(colorForTone(tone, scheme)).toBe(hues[toneHues[scheme][tone]]);
      }
    }
  });

  it('defaults to the dark scheme, because the app is dark-first', () => {
    for (const tone of tones) {
      expect(colorForTone(tone)).toBe(colorForTone(tone, 'dark'));
    }
  });

  it('gives needs-you the accent hue in both schemes: what the app points at is what wants a human', () => {
    for (const scheme of schemes) {
      expect(colorForTone('needs-you', scheme)).toBe(colorForRole('accent', scheme));
    }
  });

  it('keeps the tones of one scheme distinct from each other', () => {
    for (const scheme of schemes) {
      const values = tones.map((tone) => colorForTone(tone, scheme));
      expect(new Set(values).size, scheme).toBe(values.length);
    }
  });
});

describe('colorForRole', () => {
  it('resolves every role in every scheme', () => {
    for (const scheme of schemes) {
      for (const role of Object.keys(roles[scheme]) as Role[]) {
        expect(colorForRole(role, scheme)).toBe(hues[roles[scheme][role]]);
      }
    }
  });

  it('keeps the terminal dark in the light scheme, so output never changes character', () => {
    expect(colorForRole('terminalBackground', 'light')).toBe(hues.ink);
    expect(colorForRole('terminalText', 'light')).toBe(colorForRole('terminalText', 'dark'));
  });

  it('names both schemes over the same role set, so a consumer can switch schemes blindly', () => {
    expect(Object.keys(roles.light).sort()).toEqual(Object.keys(roles.dark).sort());
  });
});
