/**
 * The seam between the app and its component library. Every Mantine import in
 * the app lives in src/ui/, and everything a feature renders is re-exported
 * from here, so replacing Mantine with a design system later is an edit to
 * this directory rather than a migration. Lint enforces the boundary: no file
 * outside src/ui/ may import @mantine/*.
 *
 * Re-export only what the app actually uses. An unused re-export hides how
 * much of the library the app really depends on.
 */
import '@mantine/core/styles.css';

export { MantineProvider, Stack, Text, Title } from '@mantine/core';
