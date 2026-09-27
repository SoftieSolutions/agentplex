import { describe, expect, it } from 'vitest';
import { relativeLuminance } from './contrast.js';
import { colorForRole, hues, shadows } from './tokens.js';
import { SECTION_LABEL, cssVariablesResolver, theme } from './theme.js';

/** A theme size in rem back to the pixels the mock writes. */
function pixels(value: string | undefined): number {
  const match = /^(\d+(?:\.\d+)?)rem$/.exec(value ?? '');
  if (match === null) throw new Error(`${value} is not a rem size`);
  return Number(match[1]) * 16;
}

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
    expect(theme.autoContrast).toBe(true);
    const threshold = theme.luminanceThreshold ?? 0;
    expect(relativeLuminance(colorForRole('accent', 'dark'))).toBeGreaterThan(threshold);
    expect(relativeLuminance(colorForRole('accent', 'light'))).toBeLessThan(threshold);
  });

  it('fills every dark-tuple slot from tokens, so no stock blue-gray survives', () => {
    expect(theme.colors?.dark).toHaveLength(10);
    const named = new Set<string>(Object.values(hues));
    for (const shade of theme.colors?.dark ?? []) {
      expect(named.has(shade), shade).toBe(true);
    }
  });
});

describe('the type scale', () => {
  it('maps xs..lg to the mock scale 11/12/13/14, with md the 13px body', () => {
    const sizes = theme.fontSizes ?? {};
    expect(pixels(sizes.xs)).toBe(11);
    expect(pixels(sizes.sm)).toBe(12);
    expect(pixels(sizes.md)).toBe(13);
    expect(pixels(sizes.lg)).toBe(14);
    expect(pixels(sizes.xl)).toBe(16);
  });

  it('names the sizes between and around them that the mock uses: 9, 10, 12.5, 15, 26', () => {
    const sizes = theme.fontSizes ?? {};
    expect(pixels(sizes['3xs'])).toBe(9);
    expect(pixels(sizes['2xs'])).toBe(10);
    expect(pixels(sizes.row)).toBe(12.5);
    expect(pixels(sizes.title)).toBe(15);
    expect(pixels(sizes.display)).toBe(26);
  });

  it('leaves the body line height to the font, as every mock screen does', () => {
    expect(theme.lineHeights?.md).toBe('normal');
  });

  it('sizes the headings h1 20, h2 18, h3 16, h4 14', () => {
    const headings = theme.headings?.sizes;
    expect(pixels(headings?.h1?.fontSize)).toBe(20);
    expect(pixels(headings?.h2?.fontSize)).toBe(18);
    expect(pixels(headings?.h3?.fontSize)).toBe(16);
    expect(pixels(headings?.h4?.fontSize)).toBe(14);
  });

  it('exports the section label as the mock draws it: 600 9px Fira Code, .08em, uppercase', () => {
    expect(SECTION_LABEL).toEqual({
      fontFamily: 'var(--mantine-font-family-monospace)',
      fontSize: 'var(--mantine-font-size-3xs)',
      fontWeight: 600,
      letterSpacing: '.08em',
      textTransform: 'uppercase',
    });
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

  it('resolves shadow md, which every shadow="md" popover and menu asks for, to each scheme popover token', () => {
    expect(theme.shadows?.md).toBe(shadows.dark.popover);
    for (const scheme of ['dark', 'light'] as const) {
      expect(resolved[scheme]['--mantine-shadow-md']).toBe(shadows[scheme].popover);
    }
  });

  it('gives the light scheme the paper background, not stock white', () => {
    expect(resolved.light['--mantine-color-body']).toBe(hues.parchment);
    expect(resolved.light['--mantine-color-body']).not.toBe(hues.paper);
  });
});
