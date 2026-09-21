import { type JSX } from 'react';
import { Text } from '../ui/components.js';
import { colorForRole, colorForTone, type Scheme } from '../ui/tokens.js';
import { ageLabel, unseenPrompt, type SessionListItem } from './session-list-model.js';

/**
 * What a session's line of small print says: the provider, how long since it
 * last wrote, and the qualifications a person has to have before the age means
 * what it looks like it means.
 *
 * Lifted out of the card the moment the list view wanted the same sentence.
 * Every clause in it is a judgement made once -- an unseen prompt reads as
 * waiting time in the accent rather than as an age; an acknowledged one says
 * "seen" in words rather than by the absence of the accent, so that a session
 * still wanting a human does not read as one that has stopped wanting
 * anything; a muted one says so, because dimming alone is not a word; and an
 * unreachable one is labelled rather than hidden or drawn as live. Two copies
 * of that would be two chances for one form of the list to drop a
 * qualification and over-claim.
 *
 * It truncates rather than wraps in both forms. A row that wrapped would be
 * two lines high, and a card whose small print wrapped would be taller than
 * the card beside it; the fact that gets cut is the last qualification, and
 * the accent and the dimming beside it are still saying so.
 */
export interface SessionMetaLineProps {
  readonly item: SessionListItem;
  readonly scheme: Scheme;
  /** The moment this render's age is measured against. */
  readonly now: number;
}

export function SessionMetaLine({ item, scheme, now }: SessionMetaLineProps): JSX.Element {
  const muted = colorForRole('textMuted', scheme);
  const age = ageLabel(now, item.updatedAt);
  const unseen = unseenPrompt(item);
  return (
    <Text fz={11} c={muted} truncate="end" style={{ minWidth: 0 }}>
      {item.provider} {'·'}{' '}
      {unseen ? (
        <Text component="span" fz={11} c={colorForTone('needs-you', scheme)}>
          waiting {age}
        </Text>
      ) : (
        age
      )}
      {item.needsYou && item.acknowledged ? (
        <Text component="span" fz={11} c={muted}>
          {' '}
          {'·'} seen
        </Text>
      ) : null}
      {item.muted ? (
        <Text component="span" fz={11} c={muted}>
          {' '}
          {'·'} muted
        </Text>
      ) : null}
      {item.reachable ? null : (
        <Text component="span" fz={11} c={muted}>
          {' '}
          {'·'} unreachable
        </Text>
      )}
    </Text>
  );
}
