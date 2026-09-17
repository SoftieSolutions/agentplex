import type { JSX } from 'react';
import { Group, Text } from '../ui/components.js';
import { ToneDot } from '../ui/tone-dot.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import type { ConnectionView } from './connection-model.js';
import { NextActionLink } from './next-action.js';

/**
 * The connection, in the slot the chrome keeps for it.
 *
 * AGX-122 left the top bar one deliberate empty slot and said this ticket would
 * fill it; the phone header gets the same component rather than a compact
 * variant of it, because the thing being said is the same length in both places
 * and a second wording is a second thing to keep true.
 *
 * A live region, so the sentence reaches a screen reader when the socket drops
 * without anything having been clicked -- `polite`, because a reconnection is
 * not worth interrupting whatever is being read. The dot repeats the tone and
 * is hidden from the reader for that reason: the words are the content.
 *
 * Every decision is `connection-model.ts`. This draws what it decided.
 */
export interface ConnectionStatusProps {
  readonly view: ConnectionView;
  readonly scheme: Scheme;
}

export function ConnectionStatus({ view, scheme }: ConnectionStatusProps): JSX.Element {
  return (
    <Group role="status" aria-live="polite" gap={6} align="center" wrap="nowrap">
      <ToneDot tone={view.tone} scheme={scheme} />
      <Text component="span" fz={12} c={colorForRole('textMuted', scheme)}>
        {view.words}
      </Text>
      {view.action === null ? null : (
        <Text component="span" fz={12}>
          <NextActionLink action={view.action} scheme={scheme} />
        </Text>
      )}
    </Group>
  );
}
