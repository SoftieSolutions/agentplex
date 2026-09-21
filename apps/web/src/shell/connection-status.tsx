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
 * The words truncate and the action does not. The longest sentence here is the
 * reconnect one at 78 characters, and the phone header it sits in is a
 * nowrap row beside the machine selector, so something has to give: a line
 * that overflowed would push the selector off the edge, and one that wrapped
 * would change the height of the chrome every time the socket blinked. What
 * gives is the middle of the sentence, with the whole of it on the element's
 * `title` and, unshortened, in the live region a reader hears. The link keeps
 * its own width because it is the half that is actionable -- a truncated
 * "Settings" would be the one thing worth reading made unreadable.
 *
 * Every decision is `connection-model.ts`. This draws what it decided.
 */
export interface ConnectionStatusProps {
  readonly view: ConnectionView;
  readonly scheme: Scheme;
}

export function ConnectionStatus({ view, scheme }: ConnectionStatusProps): JSX.Element {
  return (
    <Group
      // Marked because it is no longer the only live region in the chrome: the
      // bell and the palette announce their own counts, and a test looking for
      // "the status in the header" would otherwise find whichever came first.
      data-connection-status
      role="status"
      aria-live="polite"
      gap={6}
      align="center"
      wrap="nowrap"
      style={{ minWidth: 0 }}
    >
      <ToneDot tone={view.tone} scheme={scheme} />
      <Text
        component="span"
        fz={12}
        c={colorForRole('textMuted', scheme)}
        title={view.words}
        style={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {view.words}
      </Text>
      {view.action === null ? null : (
        <Text component="span" fz={12} style={{ flex: 'none' }}>
          <NextActionLink action={view.action} scheme={scheme} />
        </Text>
      )}
    </Group>
  );
}
