import type { JSX } from 'react';
import type { MachineState, ServerRegistrationId } from '@agentplex/protocol';
import {
  ageLabel,
  NO_FILTERS,
  visibleSessions,
  type SessionListItem,
} from '../sessions/session-list-model.js';
import { sessionHash } from '../terminal/session-route.js';
import { Box, Group, Stack, Text, UnstyledButton } from '../ui/components.js';
import { colorForRole, colorForTone, type Scheme } from '../ui/tokens.js';

/**
 * The sidebar's other reading of the fleet: every session, one line each, in
 * the order the list screen puts them in -- needs-you first, then by activity.
 *
 * It is a way to get somewhere, not a screen: the cards in the content region
 * are where a session is read, and this is the standing index beside them, so
 * a row carries a name, a tone, an age and the machine, and no controls at
 * all. Everything it decides comes from `session-list-model.ts`, including the
 * order and the narrowing, so the two readings cannot disagree about which
 * sessions exist or which machine one is on.
 *
 * The mockup's filter button and its applied-filter summary are deliberately
 * absent: the narrowings that exist live on the list screen, and a second set
 * of controls over the same query is a second answer to the same question.
 */
export interface SidebarSessionsProps {
  readonly state: MachineState;
  /** The machine the chrome is narrowed to, or `null` for all of them. */
  readonly machine: ServerRegistrationId | null;
  readonly scheme: Scheme;
  /** The clock, injected so a test can render fixed ages. */
  readonly now?: () => number;
}

export function SidebarSessions({
  state,
  machine,
  scheme,
  now = Date.now,
}: SidebarSessionsProps): JSX.Element {
  const rows = visibleSessions(state, { ...NO_FILTERS, server: machine });
  const moment = now();
  if (rows.length === 0) {
    return (
      <Text fz={12} c={colorForRole('textMuted', scheme)}>
        {machine === null ? 'no sessions in any store yet' : 'no sessions on this machine'}
      </Text>
    );
  }
  return (
    <Stack gap={1}>
      {rows.map((item) => (
        <SidebarSessionRow key={item.key} item={item} moment={moment} scheme={scheme} />
      ))}
    </Stack>
  );
}

interface SidebarSessionRowProps {
  readonly item: SessionListItem;
  readonly moment: number;
  readonly scheme: Scheme;
}

function SidebarSessionRow({ item, moment, scheme }: SidebarSessionRowProps): JSX.Element {
  return (
    <UnstyledButton
      component="a"
      href={sessionHash(item.ref)}
      aria-label={`open ${item.name}`}
      style={{ display: 'block', padding: '6px 8px', borderRadius: 6, minWidth: 0 }}
    >
      <Group gap={8} wrap="nowrap" align="center">
        <Box
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            flexShrink: 0,
            background: colorForTone(item.tone, scheme),
          }}
        />
        <Text
          component="span"
          fz={12.5}
          fw={item.needsYou ? 600 : 400}
          truncate="end"
          c={colorForRole(item.needsYou ? 'text' : 'textSecondary', scheme)}
          style={{ flex: 1, minWidth: 0 }}
        >
          {item.name}
        </Text>
        <Text
          component="span"
          ff="monospace"
          fz={10}
          c={colorForRole('textMuted', scheme)}
          style={{ flexShrink: 0 }}
        >
          {ageLabel(moment, item.updatedAt)}
        </Text>
      </Group>
      <Text
        component="span"
        ff="monospace"
        fz={10}
        truncate="end"
        c={colorForRole('textMuted', scheme)}
        style={{ display: 'block', paddingLeft: 14 }}
      >
        {`${item.storeId} · ${item.machine}`}
      </Text>
    </UnstyledButton>
  );
}
