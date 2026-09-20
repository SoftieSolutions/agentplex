import { useState, type JSX, type MouseEvent } from 'react';
import type { FrameId } from '@agentplex/protocol';
import type { HubCommand, HubStore } from '../store/hub-store.js';
import { useHubSnapshot } from '../store/use-hub-store.js';
import { Button, Group, Text } from '../ui/components.js';
import { colorForTone, type Scheme } from '../ui/tokens.js';
import {
  acknowledgeCommand,
  attentionFollowUp,
  muteCommand,
  offersAcknowledge,
} from './attention-model.js';
import type { SessionListItem } from './session-list-model.js';

/**
 * The two things a person can say about a session that wants them: I have seen
 * it, and stop telling me.
 *
 * One component for both, because they are one conversation with the hub --
 * the same frame id to wait on, the same refusal to render, and the same rule
 * that an unanswered frame leaves the control disabled rather than inviting a
 * second click. It owns nothing but the id it is waiting on; the facts it
 * draws come off the session row, which every tab is sent.
 *
 * Neither control is drawn where it would mean nothing. Acknowledging is
 * offered only where there is an unacknowledged prompt to acknowledge; muting
 * is offered on a session that can nag and on one already muted, because an
 * unmute must stay reachable. A quiet, unmuted session gets no chrome at all.
 */
export interface AttentionControlsProps {
  readonly item: SessionListItem;
  readonly store: HubStore;
  readonly scheme: Scheme;
  /** Mantine's size scale; a card wants the smallest one. */
  readonly size?: string;
}

/** Whether muting this session says anything. See the component's note. */
function offersMute(item: SessionListItem): boolean {
  return item.muted || item.needsYou;
}

export function AttentionControls({
  item,
  store,
  scheme,
  size = 'xs',
}: AttentionControlsProps): JSX.Element | null {
  const snapshot = useHubSnapshot(store);
  /** The frame awaiting an answer, or `null` while none is. */
  const [pending, setPending] = useState<FrameId | null>(null);
  /** The store's own "no" -- an overflowed queue, a failed connection. */
  const [rejected, setRejected] = useState<string | null>(null);

  const acknowledges = offersAcknowledge(item);
  const mutes = offersMute(item);
  if (!acknowledges && !mutes) return null;

  const followUp = attentionFollowUp(pending, snapshot.lastAttention, snapshot.lastRefusal);
  const refused = followUp.kind === 'refused' ? followUp.words : rejected;
  const waiting = followUp.kind === 'waiting';

  function submit(event: MouseEvent<HTMLButtonElement>, command: HubCommand): void {
    // The card around these buttons is a link to the session. Saying "seen" is
    // not a navigation, and a person aiming at the button meant the button.
    event.preventDefault();
    event.stopPropagation();
    setRejected(null);
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
      {acknowledges ? (
        <Button
          size={size}
          variant="subtle"
          disabled={waiting}
          onClick={(event) => submit(event, acknowledgeCommand(item))}
          aria-label={`acknowledge ${item.name}`}
        >
          Seen
        </Button>
      ) : null}
      {mutes ? (
        <Button
          size={size}
          variant="subtle"
          disabled={waiting}
          onClick={(event) => submit(event, muteCommand(item, !item.muted))}
          aria-label={`${item.muted ? 'unmute' : 'mute'} ${item.name}`}
        >
          {item.muted ? 'Unmute' : 'Mute'}
        </Button>
      ) : null}
      {refused === null ? null : (
        // Beside the buttons and not in place of them: nothing changed, and
        // the sentence is why this attempt was not what changed it.
        <Text fz={11} role="status" style={{ color: colorForTone('blocked', scheme) }}>
          {refused}
        </Text>
      )}
    </Group>
  );
}
