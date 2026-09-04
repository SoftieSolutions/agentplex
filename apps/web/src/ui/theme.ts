import '@fontsource/manrope/400.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import '@fontsource/manrope/800.css';
import '@fontsource/fira-code/400.css';
import '@fontsource/fira-code/500.css';
import '@fontsource/fira-code/600.css';

import {
  createTheme,
  type CSSVariablesResolver,
  type MantineColorsTuple,
  type MantineThemeOverride,
} from '@mantine/core';

import { colorForRole, hues } from './tokens.js';

/**
 * The mockup palette (tokens.ts) wired into Mantine. Dark-first: the provider
 * mounts with defaultColorScheme="dark" (see App.tsx), and the light scheme
 * is the mockup's paper variant, not Mantine's stock white. Fonts are
 * self-hosted through the fontsource imports above — Manrope for UI, Fira
 * Code for code and metadata — so nothing is fetched from a font CDN at
 * runtime. Components that color a status still call colorForTone rather
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

export const theme: MantineThemeOverride = createTheme({
  fontFamily:
    'Manrope, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  fontFamilyMonospace:
    '"Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
  headings: {
    fontFamily:
      'Manrope, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    fontWeight: '700',
  },
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
  },
  light: {
    '--mantine-color-body': colorForRole('background', 'light'),
    '--mantine-color-text': colorForRole('text', 'light'),
    '--mantine-color-dimmed': colorForRole('textMuted', 'light'),
    '--mantine-color-default-border': colorForRole('border', 'light'),
    '--mantine-color-anchor': colorForRole('link', 'light'),
  },
});
