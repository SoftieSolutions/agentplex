import type { JSX } from 'react';
import { Stack, Text, Title, UnstyledButton } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { destinationHash, NAV } from './destinations.js';

/**
 * What the phone chrome's More tab holds: the nav the sidebar keeps at its
 * foot, which on a phone has no foot to be kept at.
 *
 * It draws `NAV` and not a list of its own, so the day a destination is added
 * it appears in both forms of the shell at once. That is the whole of this
 * screen: More is not a place with content, it is the place the rest of the
 * places are.
 */
export interface MoreScreenProps {
  readonly scheme: Scheme;
}

export function MoreScreen({ scheme }: MoreScreenProps): JSX.Element {
  return (
    <Stack p="md" gap="sm">
      <Title order={1} fz={16}>
        More
      </Title>
      {/* Labelled because the tab bar below is a nav too, and a screen with
          two unnamed ones is a screen a reader cannot tell apart. */}
      <Stack component="nav" aria-label="Destinations" gap={2}>
        {NAV.map((entry) => (
          <UnstyledButton
            key={entry.destination}
            component="a"
            href={destinationHash(entry.destination)}
            style={{
              display: 'block',
              padding: '14px 12px',
              borderRadius: 8,
              background: colorForRole('surfaceAlt', scheme),
              border: `1px solid ${colorForRole('border', scheme)}`,
            }}
          >
            <Text component="span" fz={14} c={colorForRole('text', scheme)}>
              {entry.label}
            </Text>
          </UnstyledButton>
        ))}
      </Stack>
    </Stack>
  );
}
