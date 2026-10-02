import type { JSX } from 'react';
import {
  settingsSectionHash,
  type SettingsSection,
  type SettingsSectionEntry,
} from '../shell/destinations.js';
import { Group, Stack, UnstyledButton } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';

/**
 * The settings sections as links: a column in the wide sidebar, a row above
 * the content on a phone. One component for both, drawing the list
 * `destinations.ts` hands it, so the two forms cannot offer different
 * sections.
 *
 * Links rather than a segmented control, because the address is the state: a
 * section can be bookmarked, opened in a tab and reached from a link elsewhere
 * in the app, and a control holding its own choice would be a second answer to
 * which section is open. So this holds no state at all, and the current
 * section is marked with `aria-current` the way the foot nav marks Settings.
 *
 * Each row is drawn exactly as a foot nav row is (`sidebar.tsx`), so the
 * column reads as the same kind of nav as the one below it.
 */
export interface SettingsSectionNavProps {
  readonly current: SettingsSection;
  /** The sections there is something behind, in the order they are drawn. */
  readonly offered: readonly SettingsSectionEntry[];
  readonly direction: 'column' | 'row';
  readonly scheme: Scheme;
}

export function SettingsSectionNav({
  current,
  offered,
  direction,
  scheme,
}: SettingsSectionNavProps): JSX.Element {
  const links = offered.map((entry) => (
    <SectionLink
      key={entry.section}
      entry={entry}
      current={entry.section === current}
      scheme={scheme}
    />
  ));
  return direction === 'column' ? (
    <Stack component="nav" aria-label="Settings sections" gap={1}>
      {links}
    </Stack>
  ) : (
    <Group component="nav" aria-label="Settings sections" gap={4}>
      {links}
    </Group>
  );
}

function SectionLink({
  entry,
  current,
  scheme,
}: {
  readonly entry: SettingsSectionEntry;
  readonly current: boolean;
  readonly scheme: Scheme;
}): JSX.Element {
  return (
    <UnstyledButton
      component="a"
      href={settingsSectionHash(entry.section)}
      aria-current={current ? 'page' : undefined}
      fz={12.5}
      fw={current ? 600 : 400}
      c={colorForRole(current ? 'text' : 'textSecondary', scheme)}
      bg={current ? colorForRole('raised', scheme) : 'transparent'}
      style={{ display: 'block', padding: '6px 8px', borderRadius: 6 }}
    >
      {entry.label}
    </UnstyledButton>
  );
}
