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
import { useComputedColorScheme as useMantineComputedColorScheme } from '@mantine/core';

export {
  Anchor,
  Box,
  Button,
  CloseButton,
  Code,
  Drawer,
  Group,
  MantineProvider,
  Menu,
  Modal,
  Paper,
  PasswordInput,
  Popover,
  SegmentedControl,
  Select,
  SimpleGrid,
  Slider,
  Stack,
  Stepper,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
  UnstyledButton,
} from '@mantine/core';

/**
 * The resolved scheme, 'light' | 'dark' — the same union the tokens key on.
 *
 * Wrapped rather than re-exported straight, for the option. Mantine's own
 * default is `getInitialValueInEffect: true`, which paints the first frame
 * from the fallback and corrects in an effect. Half this app's colour is
 * inline styles read during that frame, so with System chosen on a light
 * device the app would flash the dark palette before landing on paper. The
 * media query is answerable during the first render in a browser -- Mantine's
 * own `useMantineColorScheme` reads it with `false` for the same reason -- so
 * it is asked then.
 */
export function useComputedColorScheme(defaultValue: 'light' | 'dark'): 'light' | 'dark' {
  return useMantineComputedColorScheme(defaultValue, { getInitialValueInEffect: false });
}
