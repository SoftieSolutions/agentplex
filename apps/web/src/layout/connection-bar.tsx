import type { JSX } from 'react';
import type { TokenStore } from '../auth/token.js';
import { connectionNotice, nextAction } from '../sessions/session-list-model.js';
import type { HubStore } from '../store/hub-store.js';
import { useHubSnapshot } from '../store/use-hub-store.js';
import { Anchor, Group, Text, useComputedColorScheme } from '../ui/components.js';
import { ToneDot } from '../ui/tone-dot.js';
import { colorForRole, colorForTone, type Scheme, type Tone } from '../ui/tokens.js';

/**
 * What the connection is doing, in the chrome of the screens that draw panes.
 *
 * The session list has said this since it had a connection to say it about;
 * the session and document routes, which are the whole viewport of panes, said
 * nothing at all. A hub that goes away there is a terminal that stops -- no
 * word for why, and no way back to the one place a person can act. So the bar
 * is the list's two halves, moved onto the other screen: `connectionNotice`
 * for what is happening, `nextAction` for the one thing to do about it.
 *
 * The wording is borrowed whole and not re-decided. Two screens that answered
 * "is the hub there" in two sentences would be two claims about one fact, and
 * the sentences in the model are the careful ones -- a state shown across a
 * dead connection is labelled stale, and the token is only named where naming
 * it is not a guess at a cause.
 *
 * It draws nothing in the good case, which is most of the time: no strip, no
 * reserved row, no pane a pixel shorter for a connection that is up.
 */
export function ConnectionBar({ store, tokens }: ConnectionBarProps): JSX.Element | null {
  const snapshot = useHubSnapshot(store);
  const scheme: Scheme = useComputedColorScheme('dark');

  const hasState = snapshot.machineState !== null;
  const notice = connectionNotice(snapshot.phase, snapshot.problem, hasState);
  // Nothing to say is the good case: connected, with a fleet on screen.
  if (notice === null) return null;

  // The token is read on render rather than subscribed to, as the list reads
  // it: nothing writes it from these routes -- Settings is another screen --
  // and a stale read here would only outlive the next snapshot the socket
  // pushes, which a reconnection or a refusal always sends.
  const action = nextAction(snapshot.phase, hasState, tokens.read() !== null);
  const tone = toneForPhase(snapshot.phase === 'failed');

  return (
    <Group
      role="status"
      gap={8}
      wrap="nowrap"
      px="sm"
      py={6}
      style={{
        flex: 'none',
        background: colorForRole('surface', scheme),
        // The tone on the edge rather than behind the words: the bar sits over
        // a terminal well, and a wash the width of the viewport would be a
        // second surface competing with it for the eye.
        borderBottom: `1px solid ${colorForTone(tone, scheme)}`,
      }}
    >
      <ToneDot tone={tone} scheme={scheme} />
      <Text fz={12} style={{ color: colorForRole('textSecondary', scheme) }}>
        {notice}
      </Text>
      {action === null ? null : (
        <Anchor href={action.href} fz={12}>
          {action.words}
        </Anchor>
      )}
    </Group>
  );
}

/**
 * Two tones and no more. A connection that is retrying wants a human only in
 * the sense that it might want one soon, which is what the accent says
 * everywhere else in this app; a connection that has stopped retrying is
 * blocked, and nothing but a person will move it.
 */
function toneForPhase(failed: boolean): Tone {
  return failed ? 'blocked' : 'needs-you';
}

export interface ConnectionBarProps {
  readonly store: HubStore;
  /** Read to decide whether the next step is to type a token or to check one. */
  readonly tokens: TokenStore;
}
