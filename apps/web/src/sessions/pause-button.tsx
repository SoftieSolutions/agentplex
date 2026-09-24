import { useState, type JSX, type MouseEvent } from 'react';
import type { FrameId, SessionHolder, SessionRef } from '@agentplex/protocol';
import type { HubStore } from '../store/hub-store.js';
import { useHubSnapshot } from '../store/use-hub-store.js';
import { Button, Group, Text } from '../ui/components.js';
import { colorForTone, type Scheme } from '../ui/tokens.js';
import {
  offersPause,
  offersResume,
  pauseButtonWords,
  pauseCommand,
  pauseFollowUp,
  pauseNote,
  resumeCommand,
} from './pause-model.js';

/**
 * Pause, and Resume, wherever a holder says one is possible: in the pane
 * header and on a session card, beside the stop.
 *
 * One component for both words because they are one control: the holder the
 * hub published says which of the two applies, and the same button sends the
 * other command the next time. It renders nothing for a session nobody is
 * running, and it owns nothing but the id of the command it is waiting on.
 * Everything it decides comes from pause-model.ts.
 *
 * A refusal is shown beside the button, in the blocked tone, and changes
 * nothing else: the session is exactly as paused as it was, and the sentence
 * is why this attempt was not what changed it.
 */
export interface PauseButtonProps {
  readonly store: HubStore;
  readonly sessionRef: SessionRef;
  /** The hub's published holder for this session. `null` means no button. */
  readonly holder: SessionHolder | null;
  readonly scheme: Scheme;
  /** Mantine's size scale; a card wants the smallest one. */
  readonly size?: string;
}

export function PauseButton({
  store,
  sessionRef,
  holder,
  scheme,
  size = 'xs',
}: PauseButtonProps): JSX.Element | null {
  const snapshot = useHubSnapshot(store);
  /** The pause or resume awaiting an answer, or `null` while none is. */
  const [pending, setPending] = useState<FrameId | null>(null);
  /** The store's own "no" -- an overflowed queue, a failed connection. */
  const [rejected, setRejected] = useState<string | null>(null);

  if (!offersPause(holder) && !offersResume(holder)) return null;

  const followUp = pauseFollowUp(
    pending,
    snapshot.lastPaused,
    snapshot.lastResumed,
    snapshot.lastRefusal,
  );
  const refused = followUp.kind === 'refused' ? followUp.words : rejected;
  const resuming = offersResume(holder);
  const note = pauseNote(holder);

  function toggle(event: MouseEvent<HTMLButtonElement>): void {
    // The card around this button is a link to the session. A pause is not a
    // navigation, and a person aiming at the button meant the button.
    event.preventDefault();
    event.stopPropagation();
    setRejected(null);
    const command = resuming ? resumeCommand(sessionRef) : pauseCommand(sessionRef);
    const outcome = store.sendCommand(command);
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
        onClick={toggle}
        disabled={followUp.kind === 'waiting'}
        aria-label={`${resuming ? 'resume' : 'pause'} ${sessionRef.sessionId}`}
      >
        {pauseButtonWords(holder, followUp)}
      </Button>
      {note === null ? null : (
        // The honest word for the interval between asking and the boundary:
        // the agent is still working, and its keyboard is still open.
        <Text fz={11} role="status" style={{ color: colorForTone('paused', scheme) }}>
          {note}
        </Text>
      )}
      {refused === null ? null : (
        <Text fz={11} role="status" style={{ color: colorForTone('blocked', scheme) }}>
          {refused}
        </Text>
      )}
    </Group>
  );
}
