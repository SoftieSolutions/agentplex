import { useState, type JSX, type MouseEvent } from 'react';
import type { FrameId, SessionHolder, SessionRef } from '@agentplex/protocol';
import type { HubStore } from '../store/hub-store.js';
import { useHubSnapshot } from '../store/use-hub-store.js';
import { Button, Group, Text } from '../ui/components.js';
import { colorForTone, type Scheme } from '../ui/tokens.js';
import { offersStop, stopCommand, stopFollowUp } from './stop-model.js';

/**
 * Stop, wherever a holder says one is possible: on a session card, in the
 * pane header, and beside the refusal that says a start could not happen
 * because the session is already running somewhere.
 *
 * One component for all three, because the rule is one rule. It renders
 * nothing at all unless the holder the hub published says `stoppable` -- a
 * busy holder gets no button, and neither does a session nobody is running --
 * and it owns nothing but the id of the stop it is waiting on. Everything it
 * decides comes from stop-model.ts.
 */
export interface StopButtonProps {
  readonly store: HubStore;
  readonly sessionRef: SessionRef;
  /** The hub's published holder for this session. `null` means no button. */
  readonly holder: SessionHolder | null;
  readonly scheme: Scheme;
  /** Mantine's size scale; a card wants the smallest one. */
  readonly size?: string;
}

export function StopButton({
  store,
  sessionRef,
  holder,
  scheme,
  size = 'xs',
}: StopButtonProps): JSX.Element | null {
  const snapshot = useHubSnapshot(store);
  /** The stop awaiting an answer, or `null` while none is. */
  const [pending, setPending] = useState<FrameId | null>(null);
  /** The store's own "no" -- an overflowed queue, a failed connection. */
  const [rejected, setRejected] = useState<string | null>(null);

  if (!offersStop(holder)) return null;

  const followUp = stopFollowUp(pending, snapshot.lastStopped, snapshot.lastRefusal);
  const refused = followUp.kind === 'refused' ? followUp.words : rejected;

  function stop(event: MouseEvent<HTMLButtonElement>): void {
    // The card around this button is a link to the session. A stop is not a
    // navigation, and a person aiming at the button meant the button.
    event.preventDefault();
    event.stopPropagation();
    setRejected(null);
    const outcome = store.sendCommand(stopCommand(sessionRef));
    if (!outcome.accepted) {
      setRejected(outcome.reason);
      setPending(null);
      return;
    }
    setPending(outcome.id);
  }

  return (
    <Group gap={6} wrap="nowrap" align="center">
      <Button
        size={size}
        variant="default"
        onClick={stop}
        disabled={followUp.kind === 'waiting'}
        aria-label={`stop ${sessionRef.sessionId}`}
      >
        {followUp.kind === 'waiting' ? 'Stopping' : 'Stop'}
      </Button>
      {refused === null ? null : (
        // Beside the button and not in place of it: the session is still
        // running, and the sentence is why this attempt was not what stopped
        // it.
        <Text fz={11} role="status" style={{ color: colorForTone('blocked', scheme) }}>
          {refused}
        </Text>
      )}
    </Group>
  );
}
