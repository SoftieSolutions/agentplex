import { createTheme, type MantineThemeOverride } from '@mantine/core';

/**
 * Dark-first: the provider mounts with defaultColorScheme="dark" (see
 * App.tsx), and Mantine's own dark palette carries the chrome. The hues this
 * project names — surfaces, text, the status tones — live in tokens.ts;
 * components that color a status call colorForTone rather than reaching into
 * a palette. Wiring the tokens into Mantine's CSS variables is deliberately
 * left to the ticket that first needs a themed component, so the mapping is
 * driven by a real use rather than invented up front.
 */
export const theme: MantineThemeOverride = createTheme({
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  fontFamilyMonospace:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
});
