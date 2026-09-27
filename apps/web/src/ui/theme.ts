import '@fontsource/manrope/400.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import '@fontsource/manrope/800.css';
import '@fontsource/fira-code/400.css';
import '@fontsource/fira-code/500.css';
import '@fontsource/fira-code/600.css';

import type { CSSProperties } from 'react';
import {
  Button,
  Combobox,
  createTheme,
  Input,
  Menu,
  SegmentedControl,
  type CSSVariablesResolver,
  type MantineColorsTuple,
  type MantineThemeOverride,
} from '@mantine/core';

import { colorForRole, hues, shadows, type Scheme } from './tokens.js';

/**
 * The mockup palette (tokens.ts) wired into Mantine. Dark-first: the provider
 * falls back to dark when nothing has been chosen (see App.tsx), and the
 * light scheme is the mockup's paper variant, not Mantine's stock white. Both
 * are reachable: Settings carries the control, see ui/color-scheme.ts.
 *
 * Fonts are self-hosted through the fontsource imports above — Manrope for
 * UI, Fira Code for code and metadata — so nothing is fetched from a font CDN
 * at runtime. Components that color a status still ask tokens.ts for a tone
 * (colorForTone for a dot, colorForToneText for a word) rather than reaching
 * into a palette.
 */

/**
 * Mantine wants ten shades per color. The mockup defines three ambers — the
 * wash, the dark-scheme accent, the light-scheme accent — plus the link
 * bronze; the tuple repeats them into the slots Mantine reads. primaryShade
 * below points each scheme at its own accent: shade 5 (amber) in dark, shade
 * 6 (ochre) in light, exactly the two accents the mockup shows.
 */
const amber: MantineColorsTuple = [
  hues.cream,
  hues.cream,
  hues.cream,
  hues.amber,
  hues.amber,
  hues.amber,
  hues.ochre,
  hues.ochre,
  hues.bronze,
  hues.bronze,
];

/**
 * Mantine's dark scheme is driven by this tuple: 0 is text, 1-3 dim toward
 * the background, 4 is the border slot, and 5-9 are the surfaces. Mapping the
 * warm grays here is what removes Mantine's stock blue-gray chrome.
 */
const dark: MantineColorsTuple = [
  hues.bone,
  hues.oat,
  hues.stone,
  hues.shale,
  hues.seam,
  hues.walnut,
  hues.umber,
  hues.char,
  hues.soot,
  hues.pitch,
];

/**
 * Mantine draws its light-scheme chrome in this tuple the way it draws the
 * dark one in `dark`: the segmented track, an idle segment's word, a code
 * chip, a hover wash, a disabled field. Left stock, those are Bootstrap's
 * blue-grays on warm paper. 0-4 are the light surfaces and borders from the
 * page back, 5-7 the muted and faint text, 8-9 the ink. Stone stands in for
 * 5 as well as 6: the mock has no hue between pumice and stone, and Mantine
 * reads 5 only for a light placeholder, which the resolver sets anyway.
 */
const gray: MantineColorsTuple = [
  hues.parchment,
  hues.linen,
  hues.dune,
  hues.sand,
  hues.pumice,
  hues.stone,
  hues.stone,
  hues.shale,
  hues.ridge,
  hues.ink,
];

/** A pixel size from the mock as the rem Mantine's own scale is written in. */
function rem(pixels: number): string {
  return `${pixels / 16}rem`;
}

/**
 * The mock's type scale. Mantine's five names carry the sizes its components
 * ask for by default, and md is the body: every mock screen is set at 13px,
 * and Mantine draws the body, a bare Text and an Anchor at md. The default
 * control size is sm, so a Button, an input and a menu item are 12px, the size
 * the mock draws Allow, Deny, Copy and the filter field at.
 *
 * The rest of the scale gets names rather than numbers at the call site:
 * `3xs` is the section label, `2xs` the Fira Code metadata, `row` the 12.5px
 * the mock sets menus, notification rows and the sidebar's nav rows in,
 * `title` the 15px name at the head of a session or graph, and `display` the
 * onboarding sentence.
 */
const fontSizes = {
  '3xs': rem(9),
  '2xs': rem(10),
  xs: rem(11),
  sm: rem(12),
  row: rem(12.5),
  md: rem(13),
  lg: rem(14),
  title: rem(15),
  xl: rem(16),
  display: rem(26),
};

/**
 * The line heights the mock writes: 1.2 under the machine selector's two
 * lines, 1.35 in the notification rows, 1.5 and 1.65 in the transcript and
 * the terminal. md is the body and a bare Text, and the mock sets no line
 * height there at all, so it is `normal`: the font's own, which is 1.37 for
 * Manrope and different for Fira Code. A number would be right for one of
 * the two and put every monospace line off the mock by a pixel or two.
 */
const lineHeights = {
  xs: '1.2',
  sm: '1.35',
  md: 'normal',
  lg: '1.5',
  xl: '1.65',
  /**
   * A paragraph somebody reads rather than scans: an explanation in Settings,
   * a step of onboarding, the task a session was given. The mock has one
   * paragraph of prose, the TASK block in 7c, and sets it at 1.5; its one-
   * and two-line helper copy (7f's step captions) stays at the font's own.
   * Named apart from `lg` although the number is the same, so a paragraph
   * says what it is and the transcript can move without moving it.
   */
  prose: '1.5',
};

/**
 * The phone's body size. Every phone mock (6c, 7e) is set at 14px where the
 * desk mocks are 13: the same scale one step up at arm's length, for a
 * thumb and a smaller, closer screen. Only the body moves; the metadata,
 * labels and controls keep their sizes, as the mocks draw them.
 */
const PHONE_BODY = rem(14);

/**
 * The rule that moves the body to the phone size, rendered by the root while
 * the shell is in its phone form (see App.tsx). A rule on `:root` rather than
 * a wrapper's style, so what Mantine portals to the end of <body> -- menus,
 * drawers, the palette -- is set at the same size as the page under it. The
 * selector is doubled to outrank the `:root` block Mantine writes the scale
 * in without depending on which of the two style elements came first.
 */
export function phoneTypeRule(): string {
  return `:root:root { --mantine-font-size-md: ${PHONE_BODY}; }`;
}

/**
 * The small capitals over a group of rows: NEEDS YOU, EARLIER, the context
 * panel's headings, a graph node's kind (mocks 6b, 6d, 7b, 7c). One style so a
 * label reads the same in every panel that has one.
 */
export const SECTION_LABEL: CSSProperties = {
  fontFamily: 'var(--mantine-font-family-monospace)',
  fontSize: 'var(--mantine-font-size-3xs)',
  fontWeight: 600,
  letterSpacing: '.08em',
  textTransform: 'uppercase',
};

/**
 * The word on a control at the sizes the app uses, xs and compact-xs as well
 * as the default sm: 12px, as the mock draws every small control (the filter
 * field, the Projects/Sessions segment, Allow and Deny, Copy). Mantine would
 * take xs to the 11px of the scale, a step below any control the mock has.
 * Undefined leaves Mantine's own answer, for the sizes the app never asks for.
 */
function controlFontSize(size: string | undefined): string | undefined {
  return size === 'xs' || size === 'compact-xs' ? 'var(--mantine-font-size-sm)' : undefined;
}

/**
 * The control heights, measured with getBoundingClientRect off the mocks.
 * The toolbar and header buttons (Pause, Hand off, Publish, Simulate, Copy)
 * are 29px, the card's Allow and Deny, the filter field and the selects 31px,
 * and onboarding's Skip and Adopt 36px: xs, the default sm, and md. Mantine's
 * own are 30, 36 and 42, which put every default control a third taller than
 * the mock. A button and a field share one scale, so a field and the button
 * beside it line up.
 */
const CONTROL_HEIGHT = { xs: rem(29), sm: rem(31), md: rem(36) };

/** The inline padding the mock gives a button's word at each height. */
const BUTTON_PADDING_X = { xs: rem(10), sm: rem(12), md: rem(16) };

/**
 * A button's colours by variant, as scheme-resolved variables the resolver
 * below defines. Mantine's own filled button is the accent under white, and
 * its default a filled umber with white words; the mocks draw neither.
 *
 * - filled (the default variant): amber under char in dark, and ink under
 *   white in light, as Allow and Send are (7a, 7b, 7d). White on ochre is
 *   2.5:1; ink is what the light mock reaches for every time.
 * - default: no fill and a hairline edge, oat words in dark and ink in light
 *   (Deny, Pause, Copy, Publish in 7a-7f and 6d).
 * - subtle: the muted hue, as the mock writes Clear all (6b).
 *
 * A button that names its own colour asked Mantine for that colour and gets
 * it: undefined leaves Mantine's answer.
 */
function buttonColours(
  variant: string | undefined,
  color: string | undefined,
): Record<string, string | undefined> {
  if (color !== undefined) return {};
  switch (variant ?? 'filled') {
    case 'filled':
      return {
        '--button-bg': 'var(--agx-primary-button)',
        '--button-hover': 'var(--agx-primary-button-hover)',
        '--button-color': 'var(--agx-on-primary-button)',
      };
    case 'default':
      return {
        '--button-bg': 'transparent',
        '--button-hover': 'var(--agx-control-hover)',
        '--button-bd': '1px solid var(--agx-control-border)',
        '--button-color': 'var(--agx-control-text)',
      };
    case 'subtle':
      return {
        '--button-hover': 'var(--agx-control-hover)',
        '--button-color': 'var(--mantine-color-dimmed)',
      };
    default:
      return {};
  }
}

/**
 * The weight of a button's word: 700 on a filled button and 400 on the rest,
 * as every button in the mocks is set. Mantine sets them all at 600.
 */
function buttonWeight(variant: string | undefined): number {
  return (variant ?? 'filled') === 'filled' ? 700 : 400;
}

/**
 * The few theme rules Mantine offers no variable or prop for, rendered once by
 * the root (App.tsx). A segmented control's word changes weight and colour
 * with its state, 600 in the text hue when chosen and 400 in the idle hue
 * when not (7a, 7b), and a style prop cannot tell a chosen segment from the
 * others. Every value is a variable the resolver sets per scheme; the class
 * names are Mantine's static ones, and each selector is weighted to outrank
 * Mantine's own rule whichever stylesheet came first.
 */
export function themeRules(): string {
  // Doubled: Mantine's own track rule is one class behind a zero-weight
  // :where, the same weight as a single class here, and would win on order.
  const root = '.mantine-SegmentedControl-root.mantine-SegmentedControl-root';
  const label = `${root} .mantine-SegmentedControl-label`;
  return [
    `${root} { background: var(--agx-segment-track); border: var(--agx-segment-border); padding: 3px; }`,
    `${root} .mantine-SegmentedControl-indicator { background: var(--agx-segment-active); box-shadow: var(--agx-segment-shadow); border-radius: var(--mantine-radius-xs); }`,
    `${label} { font-weight: 400; color: var(--agx-segment-idle); }`,
    `${label}:not([data-active]):hover { color: var(--mantine-color-text); }`,
    `${label}[data-active] { font-weight: 600; color: var(--mantine-color-text); }`,
  ].join('\n');
}

export const theme: MantineThemeOverride = createTheme({
  fontFamily:
    'Manrope, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  fontFamilyMonospace:
    '"Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  headings: {
    fontFamily:
      'Manrope, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    fontWeight: '700',
    // Page titles are 16-20px in the mocks and nothing is larger but the
    // onboarding sentence, which sets its own size. Mantine's stock h1 is 34.
    sizes: {
      h1: { fontSize: rem(20), lineHeight: '1.3' },
      h2: { fontSize: rem(18), lineHeight: '1.3' },
      h3: { fontSize: rem(16), lineHeight: '1.35' },
      h4: { fontSize: rem(14), lineHeight: '1.4' },
    },
  },
  fontSizes,
  lineHeights,
  /**
   * The dark popover shadow. Scheme-independent here because the theme is;
   * the resolver below sets each scheme's own, so `shadow="md"` on a menu or
   * popover draws the mock's shadow in whichever scheme is showing.
   */
  shadows: { md: shadows.dark.popover },
  colors: { amber, dark, gray },
  primaryColor: 'amber',
  primaryShade: { light: 6, dark: 5 },
  /**
   * The dark accent takes dark text (the mockup's dark-on-amber buttons), the
   * light accent takes white. The threshold sits between the two ambers'
   * luminances so autoContrast decides exactly that way.
   */
  autoContrast: true,
  luminanceThreshold: 0.42,
  white: hues.paper,
  black: hues.ink,
  /** The mockup's radii: chips at 5-6, controls at 7, floating surfaces at 10. */
  defaultRadius: 'md',
  radius: { xs: '0.3125rem', sm: '0.375rem', md: '0.4375rem', lg: '0.625rem', xl: '0.875rem' },
  components: {
    Button: Button.extend({
      vars: (_theme, props) => ({
        root: {
          ...buttonColours(props.variant, props.color),
          '--button-fz': controlFontSize(props.size),
          '--button-height-xs': CONTROL_HEIGHT.xs,
          '--button-height-sm': CONTROL_HEIGHT.sm,
          '--button-height-md': CONTROL_HEIGHT.md,
          '--button-padding-x-xs': BUTTON_PADDING_X.xs,
          '--button-padding-x-sm': BUTTON_PADDING_X.sm,
          '--button-padding-x-md': BUTTON_PADDING_X.md,
        },
      }),
      styles: (_theme, props) => ({ root: { fontWeight: buttonWeight(props.variant) } }),
    }),
    Input: Input.extend({
      vars: (_theme, props) => ({
        wrapper: {
          '--input-fz': controlFontSize(props.size),
          '--input-bg': 'var(--agx-input-bg)',
          '--input-height-xs': CONTROL_HEIGHT.xs,
          '--input-height-sm': CONTROL_HEIGHT.sm,
          '--input-height-md': CONTROL_HEIGHT.md,
        },
      }),
    }),
    // The Projects/Sessions switch (7a, 6b): 25px segments, 12px words with
    // 4px above and below, in the 3px track `themeRules` draws. Mantine's
    // segment padding is 3px, which draws the same control two pixels
    // shorter.
    SegmentedControl: SegmentedControl.extend({
      vars: (_theme, props) => ({
        root: {
          '--sc-font-size': controlFontSize(props.size),
          '--sc-padding-xs': '4px 8px',
          '--sc-padding-sm': '4px 10px',
        },
      }),
    }),
    Combobox: Combobox.extend({
      vars: (_theme, props) => ({
        options: { '--combobox-option-fz': controlFontSize(props.size) },
        dropdown: { '--combobox-option-fz': controlFontSize(props.size) },
      }),
    }),
    // Menus are set at 12.5px in the mocks (7a, 7b), between the control
    // size and the body.
    Menu: Menu.extend({ styles: { item: { fontSize: 'var(--mantine-font-size-row)' } } }),
  },
});

/**
 * Scheme-dependent surfaces that Mantine derives from its own palette get
 * overridden here so both schemes come from tokens.ts. Without this, the
 * light scheme's body would be stock white and dark borders would come from
 * the dark tuple's slot 4 alone.
 */
/**
 * The control hues the theme's components and `themeRules` read, per scheme.
 * Named variables rather than hues written into the components, because a
 * component's theme resolver does not know the scheme and the page switches
 * it without a re-render.
 */
function controlVariables(scheme: Scheme): Record<string, string> {
  const dark = scheme === 'dark';
  return {
    '--agx-primary-button': colorForRole('primaryButton', scheme),
    '--agx-primary-button-hover': dark ? hues.ochre : hues.ridge,
    '--agx-on-primary-button': colorForRole('onPrimaryButton', scheme),
    '--agx-control-border': colorForRole('borderStrong', scheme),
    '--agx-control-text': colorForRole(dark ? 'textSecondary' : 'text', scheme),
    '--agx-control-hover': colorForRole('raised', scheme),
    '--agx-input-bg': colorForRole(dark ? 'background' : 'surface', scheme),
    // The dark track is the inset hue with a hairline; the light one is the
    // chip hue with none, and its chosen segment is lifted on paper (7a, 7b).
    '--agx-segment-track': dark ? hues.umber : hues.dune,
    '--agx-segment-border': dark ? `1px solid ${colorForRole('border', scheme)}` : 'none',
    '--agx-segment-active': dark ? hues.walnut : hues.paper,
    '--agx-segment-shadow': shadows[scheme].raised,
    '--agx-segment-idle': colorForRole(dark ? 'textMuted' : 'textFaint', scheme),
  };
}

export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  dark: {
    '--mantine-color-body': colorForRole('background', 'dark'),
    '--mantine-color-text': colorForRole('text', 'dark'),
    '--mantine-color-dimmed': colorForRole('textMuted', 'dark'),
    '--mantine-color-default-border': colorForRole('border', 'dark'),
    '--mantine-color-anchor': colorForRole('link', 'dark'),
    '--mantine-shadow-md': shadows.dark.popover,
    '--mantine-color-placeholder': colorForRole('textMuted', 'dark'),
    ...controlVariables('dark'),
  },
  light: {
    '--mantine-color-body': colorForRole('background', 'light'),
    '--mantine-color-text': colorForRole('text', 'light'),
    '--mantine-color-dimmed': colorForRole('textMuted', 'light'),
    '--mantine-color-default-border': colorForRole('border', 'light'),
    '--mantine-color-anchor': colorForRole('link', 'light'),
    '--mantine-shadow-md': shadows.light.popover,
    '--mantine-color-placeholder': colorForRole('textMuted', 'light'),
    ...controlVariables('light'),
  },
});
