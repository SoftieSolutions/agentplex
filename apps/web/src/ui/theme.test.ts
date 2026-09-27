import { describe, expect, it } from 'vitest';
import { relativeLuminance } from './contrast.js';
import { colorForRole, hues, shadows } from './tokens.js';
import { SECTION_LABEL, cssVariablesResolver, phoneTypeRule, theme, themeRules } from './theme.js';

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

  it('fills every gray slot from tokens too, which the light scheme draws its stock chrome in', () => {
    expect(theme.colors?.gray).toHaveLength(10);
    const named = new Set<string>(Object.values(hues));
    for (const shade of theme.colors?.gray ?? []) {
      expect(named.has(shade), shade).toBe(true);
    }
    // Mantine writes an idle segment's word in gray-7 on paper; the mock
    // writes it in shale (7b).
    expect(theme.colors?.gray?.[7]).toBe(hues.shale);
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

  it('gives a paragraph of prose the 1.5 the mock sets its one paragraph in (7c TASK)', () => {
    expect(theme.lineHeights?.prose).toBe('1.5');
  });

  it('sets the phone body at 14px, as 6c and 7e draw every phone screen, by a rule on :root', () => {
    const rule = phoneTypeRule();
    const match = /--mantine-font-size-md:\s*([\d.]+rem)/.exec(rule);
    expect(pixels(match?.[1])).toBe(14);
    // On :root, so a popover portalled to the end of <body> takes it too, and
    // doubled so it outranks the :root block Mantine writes the scale in.
    expect(rule.startsWith(':root:root')).toBe(true);
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

  it('writes a placeholder in the muted text hue in both schemes, as every mock field does', () => {
    for (const scheme of ['dark', 'light'] as const) {
      expect(resolved[scheme]['--mantine-color-placeholder']).toBe(
        colorForRole('textMuted', scheme),
      );
    }
  });

  it('names the control hues each scheme draws, transcribed from the mocks', () => {
    // Allow and Send: amber under char in dark, ink under white in light (7a, 7b, 7d).
    expect(resolved.dark['--agx-primary-button']).toBe(hues.amber);
    expect(resolved.dark['--agx-on-primary-button']).toBe(hues.char);
    expect(resolved.light['--agx-primary-button']).toBe(hues.ink);
    expect(resolved.light['--agx-on-primary-button']).toBe(hues.paper);
    // Deny, Pause, Copy: no fill, a ridge edge and oat words in dark, sand and
    // ink in light (7a, 7c, 7f, 7b, 7d).
    expect(resolved.dark['--agx-control-border']).toBe(hues.ridge);
    expect(resolved.dark['--agx-control-text']).toBe(hues.oat);
    expect(resolved.light['--agx-control-border']).toBe(hues.sand);
    expect(resolved.light['--agx-control-text']).toBe(hues.ink);
    // A field sits in the page's own hue in dark and on paper in light (6d, 7b).
    expect(resolved.dark['--agx-input-bg']).toBe(hues.char);
    expect(resolved.light['--agx-input-bg']).toBe(hues.paper);
  });

  it('names the segmented control the mocks draw (7a, 7b)', () => {
    expect(resolved.dark['--agx-segment-track']).toBe(hues.umber);
    expect(resolved.dark['--agx-segment-border']).toBe(`1px solid ${hues.seam}`);
    expect(resolved.dark['--agx-segment-active']).toBe(hues.walnut);
    expect(resolved.dark['--agx-segment-shadow']).toBe(shadows.dark.raised);
    expect(resolved.dark['--agx-segment-idle']).toBe(hues.stone);
    expect(resolved.light['--agx-segment-track']).toBe(hues.dune);
    expect(resolved.light['--agx-segment-border']).toBe('none');
    expect(resolved.light['--agx-segment-active']).toBe(hues.paper);
    expect(resolved.light['--agx-segment-shadow']).toBe(shadows.light.raised);
    expect(resolved.light['--agx-segment-idle']).toBe(hues.shale);
  });

  it('gives the light scheme the paper background, not stock white', () => {
    expect(resolved.light['--mantine-color-body']).toBe(hues.parchment);
    expect(resolved.light['--mantine-color-body']).not.toBe(hues.paper);
  });
});

/**
 * A component's theme `vars` resolver, called the way Mantine calls it. The
 * resolvers here read nothing from the theme, only the props.
 */
function controlVars(
  component: 'Button' | 'Input' | 'SegmentedControl',
  props: Record<string, unknown> = {},
): Record<string, Record<string, string | undefined>> {
  const extension = theme.components?.[component] as
    | { vars?: (theme: never, props: never) => Record<string, Record<string, string | undefined>> }
    | undefined;
  if (extension?.vars === undefined) throw new Error(`${component} has no vars resolver`);
  return extension.vars({} as never, props as never);
}

/** The word weight the theme gives a button of these props. */
function buttonWeight(props: Record<string, unknown>): unknown {
  const extension = theme.components?.Button as
    { styles?: (theme: never, props: never) => { root?: { fontWeight?: unknown } } } | undefined;
  if (typeof extension?.styles !== 'function') throw new Error('Button has no styles resolver');
  return extension.styles({} as never, props as never).root?.fontWeight;
}

describe('control styles', () => {
  it('fills a primary button with the scheme primary and sets its word at 700', () => {
    const vars = controlVars('Button').root ?? {};
    expect(vars['--button-bg']).toBe('var(--agx-primary-button)');
    expect(vars['--button-color']).toBe('var(--agx-on-primary-button)');
    expect(buttonWeight({})).toBe(700);
  });

  it('draws a default button unfilled with a hairline edge, its word at 400', () => {
    const vars = controlVars('Button', { variant: 'default' }).root ?? {};
    expect(vars['--button-bg']).toBe('transparent');
    expect(vars['--button-bd']).toBe('1px solid var(--agx-control-border)');
    expect(vars['--button-color']).toBe('var(--agx-control-text)');
    expect(buttonWeight({ variant: 'default' })).toBe(400);
  });

  it('writes a subtle button in the muted hue at 400, as the mock draws Clear all (6b)', () => {
    const vars = controlVars('Button', { variant: 'subtle' }).root ?? {};
    expect(vars['--button-color']).toBe('var(--mantine-color-dimmed)');
    expect(buttonWeight({ variant: 'subtle' })).toBe(400);
  });

  it('leaves a button that names its own colour to Mantine', () => {
    const vars = controlVars('Button', { color: 'red' }).root ?? {};
    expect(vars['--button-bg']).toBeUndefined();
    expect(vars['--button-color']).toBeUndefined();
  });

  it('sets a field in the scheme field hue', () => {
    const wrapper = controlVars('Input').wrapper ?? {};
    expect(wrapper['--input-bg']).toBe('var(--agx-input-bg)');
  });

  it('carries the segmented states Mantine has no variable for in the theme rules', () => {
    const rules = themeRules();
    expect(rules).toContain('background: var(--agx-segment-track)');
    expect(rules).toContain('border: var(--agx-segment-border)');
    expect(rules).toMatch(/\[data-active\][^}]*font-weight: 600/);
    expect(rules).toMatch(/SegmentedControl-label \{[^}]*font-weight: 400/);
  });
});

describe('control sizes', () => {
  // Measured with getBoundingClientRect off the mocks: the header and toolbar
  // buttons (Pause, Publish, Simulate, Copy) are 29px, the card's Allow and
  // Deny, the filter field and the selects 31px, onboarding's Skip and Adopt
  // 36px. Mantine's own are 30, 36 and 42.
  it('sets the buttons xs 29, sm 31, md 36 high, with the padding the mock draws', () => {
    const root = controlVars('Button').root ?? {};
    expect(pixels(root['--button-height-xs'])).toBe(29);
    expect(pixels(root['--button-height-sm'])).toBe(31);
    expect(pixels(root['--button-height-md'])).toBe(36);
    expect(pixels(root['--button-padding-x-xs'])).toBe(10);
    expect(pixels(root['--button-padding-x-sm'])).toBe(12);
    expect(pixels(root['--button-padding-x-md'])).toBe(16);
  });

  it('sets the inputs to the same heights, so a field and the button beside it line up', () => {
    const wrapper = controlVars('Input').wrapper ?? {};
    expect(pixels(wrapper['--input-height-xs'])).toBe(29);
    expect(pixels(wrapper['--input-height-sm'])).toBe(31);
    expect(pixels(wrapper['--input-height-md'])).toBe(36);
  });

  it('draws a segment 25px high inside a 3px track, as the Projects/Sessions switch is', () => {
    const root = controlVars('SegmentedControl').root ?? {};
    // 12px Manrope at its own line height is 16.4px; 4px above and below.
    expect(root['--sc-padding-xs']).toBe('4px 8px');
    expect(root['--sc-padding-sm']).toBe('4px 10px');
  });
});
