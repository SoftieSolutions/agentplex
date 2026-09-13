import { useState, type JSX } from 'react';
import type { Layout, MachineState, SessionRef } from '@agentplex/protocol';
import type { CommandOutcome, HubStore } from '../store/hub-store.js';
import { useHubSnapshot } from '../store/use-hub-store.js';
import { Box, Button, Group, Stack, Text, Title } from '../ui/components.js';
import { colorForRole, colorForTone, type Scheme } from '../ui/tokens.js';
import { buildForgetRemoval, sessionsNotInTree, treeFollowUp } from './tree-model.js';

/**
 * The sessions the fleet has that the tree does not hold, and the one button
 * that puts one back.
 *
 * Derived rather than asked for: no frame lists what a hub has been told to
 * forget, and none is needed, because a removal takes the node out and leaves
 * the session exactly where it was. A session in the machine state with no
 * node in the layout is the one that was removed.
 *
 * The heading says what this list can honestly claim. A session discovery has
 * not placed yet looks identical from here, so nothing calls these removed --
 * they are sessions that are not in the tree, and whether there is a removal
 * to forget is a question only the hub can answer. It answers it: asking it to
 * forget a removal it does not remember is refused in a sentence, and that
 * sentence is shown rather than swallowed.
 */
export interface AbsentSessionsProps {
  readonly store: HubStore;
  readonly state: MachineState | null;
  readonly layout: Layout | null;
  readonly scheme: Scheme;
}

export function AbsentSessions({
  store,
  state,
  layout,
  scheme,
}: AbsentSessionsProps): JSX.Element | null {
  const snapshot = useHubSnapshot(store);
  const [pending, setPending] = useState<CommandOutcome | null>(null);

  const absent = sessionsNotInTree(state, layout);
  if (absent.length === 0) return null;

  const followUp =
    pending === null || !pending.accepted
      ? null
      : treeFollowUp(pending.id, snapshot.lastTreeChange, snapshot.lastRefusal);
  const refused = followUp?.kind === 'refused' ? followUp.words : null;

  function putBack(ref: SessionRef): void {
    const outcome = store.sendCommand(buildForgetRemoval(ref));
    setPending(outcome.accepted ? outcome : null);
  }

  return (
    <Stack gap={6}>
      <Title order={2} fz={13} c={colorForRole('textMuted', scheme)}>
        Not in your tree
      </Title>
      {refused === null ? null : (
        <Text fz={12} style={{ color: colorForTone('blocked', scheme) }}>
          {refused}
        </Text>
      )}
      {absent.map((session) => (
        <Box
          key={session.key}
          bg={colorForRole('surfaceAlt', scheme)}
          style={{
            border: `1px solid ${colorForRole('border', scheme)}`,
            borderRadius: 8,
            padding: '7px 10px',
          }}
        >
          <Group justify="space-between" wrap="nowrap" gap={8}>
            <Text fz={13} truncate="end" c={colorForRole('text', scheme)}>
              {session.name}
            </Text>
            <Button
              size="compact-xs"
              variant="default"
              onClick={() => putBack(session.ref)}
              aria-label={`Put ${session.name} back in the tree`}
            >
              Put back
            </Button>
          </Group>
        </Box>
      ))}
    </Stack>
  );
}
