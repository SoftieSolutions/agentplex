import { describe, expect, it } from 'vitest';
import { colorForRole, hues } from './tokens.js';
import { cssVariablesResolver, theme } from './theme.js';

describe('theme', () => {
  it('leads with Manrope for UI text and Fira Code for monospace', () => {
    expect(theme.fontFamily).toMatch(/^Manrope,/);
    expect(theme.headings?.fontFamily).toMatch(/^Manrope,/);
    expect(theme.fontFamilyMonospace).toMatch(/^"Fira Code",/);
  });

  it('makes amber the primary color, with each scheme pointed at its own accent shade', () => {
    expect(theme.primaryColor).toBe('amber');
    const shade = theme.primaryShade as { light: number; dark: number };
    expect(theme.colors?.amber?.[shade.dark]).toBe(colorForRole('accent', 'dark'));
    expect(theme.colors?.amber?.[shade.light]).toBe(colorForRole('accent', 'light'));
  });

  it('splits autoContrast between the two accents: dark text on amber, white on ochre', () => {
    // Relative luminance of an sRGB hex, per WCAG.
    function luminance(hex: string): number {
      const channel = (at: number): number => {
        const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
    }
    expect(theme.autoContrast).toBe(true);
    const threshold = theme.luminanceThreshold ?? 0;
    expect(luminance(colorForRole('accent', 'dark'))).toBeGreaterThan(threshold);
    expect(luminance(colorForRole('accent', 'light'))).toBeLessThan(threshold);
  });

  it('fills every dark-tuple slot from tokens, so no stock blue-gray survives', () => {
    expect(theme.colors?.dark).toHaveLength(10);
    const named = new Set<string>(Object.values(hues));
    for (const shade of theme.colors?.dark ?? []) {
      expect(named.has(shade), shade).toBe(true);
    }
  });
});

describe('cssVariablesResolver', () => {
  // The resolver reads nothing from the theme it is passed; tokens.ts is the
  // source. A bare object cast keeps the test free of a Mantine construction.
  const resolved = cssVariablesResolver(
    {} as unknown as Parameters<typeof cssVariablesResolver>[0],
  );

  it('sets each scheme body and text from the token roles', () => {
    for (const scheme of ['dark', 'light'] as const) {
      expect(resolved[scheme]['--mantine-color-body']).toBe(colorForRole('background', scheme));
      expect(resolved[scheme]['--mantine-color-text']).toBe(colorForRole('text', scheme));
    }
  });

  it('gives the light scheme the paper background, not stock white', () => {
    expect(resolved.light['--mantine-color-body']).toBe(hues.parchment);
    expect(resolved.light['--mantine-color-body']).not.toBe(hues.paper);
  });
});
