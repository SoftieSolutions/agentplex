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

import { colorForRole, hues, shadows } from './tokens.js';

/**
 * The mockup palette (tokens.ts) wired into Mantine. Dark-first: the provider
 * falls back to dark when nothing has been chosen (see App.tsx), and the
 * light scheme is the mockup's paper variant, not Mantine's stock white. Both
 * are reachable: Settings carries the control, see ui/color-scheme.ts.
 *
 * Fonts are self-hosted through the fontsource imports above — Manrope for
 * UI, Fira Code for code and metadata — so nothing is fetched from a font CDN
 * at runtime. Components that color a status still call colorForTone rather
 * than reaching into a palette.
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
const lineHeights = { xs: '1.2', sm: '1.35', md: 'normal', lg: '1.5', xl: '1.65' };

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
  colors: { amber, dark },
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
      vars: (_theme, props) => ({ root: { '--button-fz': controlFontSize(props.size) } }),
    }),
    Input: Input.extend({
      vars: (_theme, props) => ({ wrapper: { '--input-fz': controlFontSize(props.size) } }),
    }),
    SegmentedControl: SegmentedControl.extend({
      vars: (_theme, props) => ({ root: { '--sc-font-size': controlFontSize(props.size) } }),
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
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  dark: {
    '--mantine-color-body': colorForRole('background', 'dark'),
    '--mantine-color-text': colorForRole('text', 'dark'),
    '--mantine-color-dimmed': colorForRole('textMuted', 'dark'),
    '--mantine-color-default-border': colorForRole('border', 'dark'),
    '--mantine-color-anchor': colorForRole('link', 'dark'),
    '--mantine-shadow-md': shadows.dark.popover,
  },
  light: {
    '--mantine-color-body': colorForRole('background', 'light'),
    '--mantine-color-text': colorForRole('text', 'light'),
    '--mantine-color-dimmed': colorForRole('textMuted', 'light'),
    '--mantine-color-default-border': colorForRole('border', 'light'),
    '--mantine-color-anchor': colorForRole('link', 'light'),
    '--mantine-shadow-md': shadows.light.popover,
  },
});
