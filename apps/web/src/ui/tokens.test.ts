import { describe, expect, it } from 'vitest';
import { contrastRatio, relativeLuminance } from './contrast.js';
import {
  cardBorders,
  colorForRole,
  colorForTone,
  colorForToneText,
  hues,
  insets,
  roles,
  shadows,
  toneHues,
  toneTextHues,
  translucent,
  type Role,
  type Scheme,
  type Tone,
} from './tokens.js';

const schemes: Scheme[] = ['dark', 'light'];
const tones: Tone[] = ['running', 'needs-you', 'blocked', 'idle', 'paused'];

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

  it('gives needs-you the accent hue in both schemes: what the app points at is what wants a human', () => {
    for (const scheme of schemes) {
      expect(colorForTone('needs-you', scheme)).toBe(colorForRole('accent', scheme));
    }
  });

  it('names every tone in both schemes, so a fifth tone cannot be half-coloured', () => {
    for (const scheme of schemes) {
      expect(Object.keys(toneHues[scheme]).sort()).toEqual([...tones].sort());
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

describe('the mock tag', () => {
  it('is no status hue in its scheme, so sample data is never read as a session state', () => {
    for (const scheme of schemes) {
      const toneValues = tones.map((tone) => colorForTone(tone, scheme));
      expect(toneValues, scheme).not.toContain(colorForRole('mockTag', scheme));
    }
  });

  it('draws its word in a hue other than its own background', () => {
    for (const scheme of schemes) {
      expect(colorForRole('onMockTag', scheme), scheme).not.toBe(colorForRole('mockTag', scheme));
    }
  });
});

describe('colorForToneText', () => {
  it('names every tone in both schemes', () => {
    for (const scheme of schemes) {
      expect(Object.keys(toneTextHues[scheme]).sort()).toEqual([...tones].sort());
      for (const tone of tones) {
        expect(colorForToneText(tone, scheme)).toBe(hues[toneTextHues[scheme][tone]]);
      }
    }
  });

  it('meets AA (4.5:1) for every word that reports a state, on the surface and the page of its scheme', () => {
    for (const scheme of schemes) {
      for (const tone of tones.filter((t) => t !== 'idle')) {
        const text = colorForToneText(tone, scheme);
        for (const ground of ['surface', 'background'] as const) {
          const ratio = contrastRatio(text, colorForRole(ground, scheme));
          expect(ratio, `${scheme} ${tone} on ${ground}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });

  it('holds idle to 3:1, the floor for muted secondary text, as the mock draws it in stone', () => {
    for (const scheme of schemes) {
      expect(colorForToneText('idle', scheme)).toBe(colorForRole('textMuted', scheme));
      for (const ground of ['surface', 'background'] as const) {
        const ratio = contrastRatio(colorForToneText('idle', scheme), colorForRole(ground, scheme));
        expect(ratio, `${scheme} idle on ${ground}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('takes the mock light text hues: a darker word than the dot beside it', () => {
    expect(colorForToneText('running', 'light')).toBe(hues.moss);
    expect(colorForToneText('blocked', 'light')).toBe(hues.rust);
    expect(colorForToneText('needs-you', 'light')).toBe(hues.bronze);
  });

  it('keeps the dot hue as the word in dark wherever the dot already passes', () => {
    for (const tone of ['running', 'needs-you', 'blocked', 'paused'] as const) {
      expect(colorForToneText(tone, 'dark')).toBe(colorForTone(tone, 'dark'));
    }
  });
});

describe('translucent', () => {
  it('appends the alpha byte to the named hue, as the mock writes an 8-digit hex', () => {
    expect(translucent('lichen', 0x22)).toBe(`${hues.lichen}22`);
    expect(translucent('ochre', 0x1f)).toBe(`${hues.ochre}1f`);
    expect(translucent('umbra', 0x80)).toBe(`${hues.umbra}80`);
  });

  it('pads a small alpha to two digits', () => {
    expect(translucent('umbra', 0x0f)).toBe(`${hues.umbra}0f`);
  });

  it('refuses an alpha outside one byte rather than writing a colour CSS would drop', () => {
    expect(() => translucent('umbra', 256)).toThrow();
    expect(() => translucent('umbra', -1)).toThrow();
    expect(() => translucent('umbra', 0.5)).toThrow();
  });
});

describe('shadows', () => {
  const names = [
    'popover',
    'fab',
    'raised',
    'needsYouRing',
    'needsYouNodeRing',
    'runningRing',
    'focusRing',
    'glow',
  ] as const;

  it('names the same shadows in both schemes', () => {
    for (const scheme of schemes) {
      expect(Object.keys(shadows[scheme]).sort(), scheme).toEqual([...names].sort());
    }
  });

  it('carries the mock popover shadow per scheme (7a, 7b)', () => {
    expect(shadows.dark.popover).toBe(`0 12px 32px ${hues.umbra}80`);
    expect(shadows.light.popover).toBe(`0 12px 32px ${hues.umbra}22`);
  });

  it('carries the mock action button shadow per scheme, with the dark hairline ring (7e)', () => {
    expect(shadows.dark.fab).toBe(`0 8px 24px ${hues.umbra}80, 0 0 0 1px ${hues.char}`);
    expect(shadows.light.fab).toBe(`0 8px 24px ${hues.umbra}33`);
  });

  it('draws the needs-you card ring at 3px and the graph node ring at 4px, both at .12 (6a, 6d, 7b)', () => {
    expect(shadows.light.needsYouRing).toBe(`0 0 0 3px ${hues.ochre}1f`);
    expect(shadows.dark.needsYouRing).toBe(`0 0 0 3px ${hues.amber}1f`);
    expect(shadows.dark.needsYouNodeRing).toBe(`0 0 0 4px ${hues.amber}1f`);
  });

  it('draws the running ring at 4px in the running tone, alpha 22 exactly (6d)', () => {
    expect(shadows.dark.runningRing).toBe(`0 0 0 4px ${hues.lichen}22`);
    expect(shadows.light.runningRing).toBe(`0 0 0 4px ${colorForTone('running', 'light')}22`);
  });

  it('rings a pressed control in its scheme accent at a quarter (7a)', () => {
    for (const scheme of schemes) {
      expect(shadows[scheme].focusRing).toBe(`0 0 0 3px ${colorForRole('accent', scheme)}40`);
    }
  });

  it('lifts a raised light segment by a hairline and leaves dark flat (7a, 7b)', () => {
    expect(shadows.light.raised).toBe(`0 1px 2px ${hues.umbra}0f`);
    expect(shadows.dark.raised).toBe('none');
  });

  it('glows a connected dot in the running tone (7f)', () => {
    expect(shadows.dark.glow).toBe(`0 0 8px ${hues.lichen}`);
  });

  it('writes every colour it holds as a token hue, with or without an alpha byte', () => {
    const named = new Set<string>(Object.values(hues));
    for (const scheme of schemes) {
      for (const value of Object.values(shadows[scheme])) {
        for (const hex of value.match(/#[0-9a-f]+/g) ?? []) {
          expect(named.has(hex.slice(0, 7)), `${scheme} ${hex}`).toBe(true);
        }
      }
    }
  });
});

describe('cardBorders', () => {
  it('carries the mock translucent card borders per scheme (7a, 7b, 7e, 7f)', () => {
    expect(cardBorders.dark).toEqual({
      blocked: `${hues.ember}99`,
      needsYou: `${hues.amber}99`,
      focused: `${hues.bone}55`,
      connected: `${hues.lichen}66`,
    });
    expect(cardBorders.light).toEqual({
      blocked: `${hues.brick}88`,
      needsYou: hues.ochre,
      focused: hues.ink,
      connected: `${hues.fir}66`,
    });
  });
});

describe('insets', () => {
  it('names the onboarding well, row and border hues mock 7f draws in dark', () => {
    expect(hues[insets.dark.well]).toBe(hues.tar);
    expect(hues[insets.dark.row]).toBe(hues.void);
    expect(hues[insets.dark.border]).toBe(hues.slag);
  });

  it('steps down from the page: well, then the row inside it', () => {
    const page = relativeLuminance(colorForRole('background', 'dark'));
    expect(relativeLuminance(hues[insets.dark.well])).toBeGreaterThan(page);
    expect(relativeLuminance(hues[insets.dark.row])).toBeLessThan(
      relativeLuminance(hues[insets.dark.well]),
    );
  });

  it('names the same insets in both schemes', () => {
    expect(Object.keys(insets.light).sort()).toEqual(Object.keys(insets.dark).sort());
  });
});

describe('brand and primary button roles', () => {
  it('draws the mark amber on char in dark and amber on ink in light (7a, 7b)', () => {
    expect(colorForRole('brand', 'dark')).toBe(hues.amber);
    expect(colorForRole('onBrand', 'dark')).toBe(hues.char);
    expect(colorForRole('brand', 'light')).toBe(hues.ink);
    expect(colorForRole('onBrand', 'light')).toBe(hues.amber);
  });

  it('draws the primary button amber in dark and ink with white text in light (7a, 7b)', () => {
    expect(colorForRole('primaryButton', 'dark')).toBe(hues.amber);
    expect(colorForRole('onPrimaryButton', 'dark')).toBe(hues.char);
    expect(colorForRole('primaryButton', 'light')).toBe(hues.ink);
    expect(colorForRole('onPrimaryButton', 'light')).toBe(hues.paper);
  });

  it('keeps the word on each readable at AA', () => {
    for (const scheme of schemes) {
      for (const [ground, word] of [
        ['brand', 'onBrand'],
        ['primaryButton', 'onPrimaryButton'],
      ] as const) {
        const ratio = contrastRatio(colorForRole(word, scheme), colorForRole(ground, scheme));
        expect(ratio, `${scheme} ${word} on ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
