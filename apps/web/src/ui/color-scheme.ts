/**
 * Which of the two schemes in tokens.ts the device is showing, and how a
 * person says so.
 *
 * Three states, not two. `dark` and `light` are a choice somebody made;
 * `system` is the choice to keep not choosing, and it is the one a PWA needs
 * most -- a phone on a home screen has no browser chrome to flip, so a device
 * that turns its own scheme over at sunset can only be followed if the app
 * offers to follow it.
 *
 * The choice is per device on purpose, so it is kept in this browser and
 * nowhere else, under a key this app names. Mantine's storage manager already
 * reads through a parser and answers the default when the read throws or the
 * stored word is not one of the three, which is the whole of what a browser
 * in privacy mode needs from this: a refused storage degrades to the default
 * scheme rather than a crash, and the person picks again next visit.
 *
 * Mantine lives behind src/ui/, so this file is where its word for the third
 * state -- `auto` -- is translated, and the rest of the app says `system`.
 */
import {
  localStorageColorSchemeManager,
  useMantineColorScheme,
  type MantineColorScheme,
  type MantineColorSchemeManager,
} from '@mantine/core';

/** What the person picked: a scheme, or the standing instruction to follow the device. */
export type ColorSchemeChoice = 'dark' | 'light' | 'system';

/**
 * The order the control offers them in: the app's own default first, the
 * scheme half the approved mockups are drawn in second, and the standing
 * instruction last.
 */
export const colorSchemeChoices = [
  'dark',
  'light',
  'system',
] as const satisfies readonly ColorSchemeChoice[];

/** The words beside each segment. */
export const colorSchemeLabels: Record<ColorSchemeChoice, string> = {
  dark: 'Dark',
  light: 'Light',
  system: 'System',
};

/**
 * The key the choice is stored under. It names this app rather than the
 * component library because the seam in this directory exists so that Mantine
 * can be replaced: a key called `mantine-color-scheme-value` would outlive
 * Mantine and turn that replacement into a migration.
 */
export const COLOR_SCHEME_STORAGE_KEY = 'agentplex.colorScheme';

/**
 * What the provider reads the choice through and writes it back to. Built
 * here rather than in App.tsx so that the key and the translation below stay
 * in one file.
 */
export const colorSchemeManager: MantineColorSchemeManager = localStorageColorSchemeManager({
  key: COLOR_SCHEME_STORAGE_KEY,
});

/**
 * A word that may or may not be a choice -- the string a control hands back,
 * which is a claim about its own data and not a fact. Answers null rather
 * than guessing.
 */
export function parseColorSchemeChoice(value: string): ColorSchemeChoice | null {
  switch (value) {
    case 'dark':
    case 'light':
    case 'system':
      return value;
    default:
      return null;
  }
}

function toMantine(choice: ColorSchemeChoice): MantineColorScheme {
  switch (choice) {
    case 'dark':
      return 'dark';
    case 'light':
      return 'light';
    case 'system':
      return 'auto';
  }
}

function fromMantine(scheme: MantineColorScheme): ColorSchemeChoice {
  switch (scheme) {
    case 'dark':
      return 'dark';
    case 'light':
      return 'light';
    case 'auto':
      return 'system';
  }
}

export interface ColorSchemeSetting {
  /** What is set now -- `system` when the device is being followed. */
  readonly choice: ColorSchemeChoice;
  /** Set it, on this device, for good. */
  choose(choice: ColorSchemeChoice): void;
}

/**
 * The setting as a control reads and writes it. The value is the one the
 * person chose and not the one it resolved to: a screen that colours itself
 * asks `useComputedColorScheme` for the resolved scheme, and a control that
 * showed `Dark` when `System` was picked would be lying about what happens at
 * sunset.
 */
export function useColorSchemeSetting(): ColorSchemeSetting {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  return {
    choice: fromMantine(colorScheme),
    choose: (choice: ColorSchemeChoice) => setColorScheme(toMantine(choice)),
  };
}
