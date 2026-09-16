import type { JSX } from 'react';
import {
  colorSchemeChoices,
  colorSchemeLabels,
  parseColorSchemeChoice,
  useColorSchemeSetting,
} from '../ui/color-scheme.js';
import { SegmentedControl, Stack, Text, Title } from '../ui/components.js';

/**
 * The control that makes the light scheme reachable.
 *
 * It sits on the Settings screen rather than in the top-level chrome because
 * it is a preference somebody sets once per device, not a thing they reach
 * for while they work -- and because the chrome is a screen the app spends
 * its whole life in, where a scheme toggle would take the place of something
 * about the sessions.
 *
 * The segments carry the choice, not the resolved scheme: `System` stays lit
 * after the device flips at sunset, because what was chosen is still to
 * follow the device.
 */
export const COLOR_SCHEME_FIELD_NAME = 'color-scheme';

export function ColorSchemeControl(): JSX.Element {
  const setting = useColorSchemeSetting();
  return (
    <Stack gap="sm">
      <Title order={4}>Appearance</Title>
      <Text size="sm" c="dimmed">
        The colour scheme is kept on this device only. Follow the system and a phone that turns
        itself over at sunset takes the app with it.
      </Text>
      <SegmentedControl
        name={COLOR_SCHEME_FIELD_NAME}
        value={setting.choice}
        data={colorSchemeChoices.map((choice) => ({
          value: choice,
          label: colorSchemeLabels[choice],
        }))}
        onChange={(value: string) => {
          // A control hands back a string, which is a claim about its own
          // data. Parsed rather than trusted; an unreadable one changes
          // nothing, which is the direction that does not over-claim.
          const choice = parseColorSchemeChoice(value);
          if (choice !== null) setting.choose(choice);
        }}
      />
    </Stack>
  );
}
