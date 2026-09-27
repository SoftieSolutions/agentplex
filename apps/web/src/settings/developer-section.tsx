import { useState, useSyncExternalStore, type JSX } from 'react';
import type { MockSwitch } from '../mock/mock-switch.js';
import { Stack, Switch, Text, Title } from '../ui/components.js';

/**
 * The one control that flips the mock switch (src/mock/mock-switch.ts).
 *
 * It is on the settings screen and nowhere in the chrome because it is a
 * developer's preference set once per device, and a toggle beside the
 * sessions would invite somebody to read sample rows as their fleet.
 *
 * The toggle reads the switch through `useSyncExternalStore` rather than
 * holding its own copy, so `?mock=1` arriving before this screen mounted and
 * a flip from anywhere else land here without an effect.
 */
export function DeveloperSection({ mock }: { readonly mock: MockSwitch }): JSX.Element {
  const on = useSyncExternalStore(mock.subscribe, mock.read);
  // Only a refusal draws: a choice that was kept is shown by the toggle.
  const [refused, setRefused] = useState(false);
  return (
    <Stack gap="sm">
      <Title order={4}>Developer</Title>
      <Switch
        label="Show mock data"
        checked={on}
        onChange={(event) => setRefused(!mock.set(event.currentTarget.checked))}
      />
      <Text size="md" c="dimmed">
        Shows sample data for features that have no backend yet. Kept on this device only.
      </Text>
      {refused && (
        <Text size="md" c="dimmed">
          This browser refused to keep it, so it holds for this page only.
        </Text>
      )}
    </Stack>
  );
}
