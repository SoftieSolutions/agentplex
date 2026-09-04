import { type JSX } from 'react';
import { Box, Group, Text } from '../ui/components.js';
import { colorForRole, colorForTone, type Scheme } from '../ui/tokens.js';
import { ageLabel, type SessionListItem } from './session-list-model.js';
import { SessionSummaryLine } from './session-summary-line.js';

/**
 * One compact session card, from the approved mockup (turn 7, screens 7a/7e):
 * tone dot, name, machine label in the monospace face, one summary line, and
 * a provider-and-age line. A needs-you card carries the accent border -- the
 * partition is also visible per card -- and its age reads as waiting time.
 * The Allow/Deny affordances the mockup shows belong to the approvals
 * milestone and are deliberately absent: an approval that cannot be granted
 * yet must not be drawn as if it could.
 */
export interface SessionCardProps {
  readonly item: SessionListItem;
  readonly scheme: Scheme;
  /** The moment the ages on this render are measured against. */
  readonly now: number;
}

export function SessionCard({ item, scheme, now }: SessionCardProps): JSX.Element {
  const border = item.needsYou ? colorForTone('needs-you', scheme) : colorForRole('border', scheme);
  const muted = colorForRole('textMuted', scheme);
  const age = ageLabel(now, item.updatedAt);
  return (
    <Box
      component="article"
      bg={colorForRole('surface', scheme)}
      style={{
        border: `1px solid ${border}`,
        borderRadius: 10,
        padding: '11px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: 0,
      }}
    >
      <Group gap={7} wrap="nowrap">
        <Box
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            flexShrink: 0,
            background: colorForTone(item.tone, scheme),
          }}
        />
        <Text fw={600} truncate="end" style={{ flex: 1 }} c={colorForRole('text', scheme)}>
          {item.name}
        </Text>
        <Text ff="monospace" fz={10} fw={500} c={muted}>
          {item.machine}
        </Text>
      </Group>
      <SessionSummaryLine text={item.summary} scheme={scheme} />
      <Text fz={11} c={muted}>
        {item.provider} {'·'}{' '}
        {item.needsYou ? (
          <Text component="span" fz={11} c={colorForTone('needs-you', scheme)}>
            waiting {age}
          </Text>
        ) : (
          age
        )}
        {item.reachable ? null : (
          // The row stays, labelled: an unreachable session is a fact with an
          // age on it, not a session to hide and not one to show as live.
          <Text component="span" fz={11} c={muted}>
            {' '}
            {'·'} unreachable
          </Text>
        )}
      </Text>
    </Box>
  );
}
