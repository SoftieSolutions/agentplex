import type { JSX } from 'react';
import { Box, Button, Text } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { TAB_BAR_HEIGHT } from './bottom-tabs.js';
import { withSafeArea } from './safe-area.js';

/**
 * The round button floating above the phone chrome's tab bar: start a session,
 * and how many sessions are waiting on a human.
 *
 * One button doing two jobs is the mockup's, and it is defensible because the
 * two are the same errand: the badge is what makes a person open the app, and
 * starting work is what they do when nothing is waiting. It is the same start
 * the New session button opens on a wide screen -- the shell holds the form and
 * this opens it -- rather than a second way in with its own rules.
 *
 * The count comes from `needsYouCount`, which is the number the session list's
 * Needs you chip carries. Deliberately one derivation: on a phone the chip and
 * this badge are on the same screen, and two numbers for one question is how a
 * badge stops being believed.
 */

/** The button's diameter. Comfortably past the 44px a fingertip needs. */
const DIAMETER = 56;

export interface StartSessionButtonProps {
  /** How many sessions want a human. Zero draws no badge at all. */
  readonly needsYou: number;
  readonly onStart: () => void;
  readonly scheme: Scheme;
}

export function StartSessionButton({
  needsYou,
  onStart,
  scheme,
}: StartSessionButtonProps): JSX.Element {
  return (
    <Box
      style={{
        position: 'absolute',
        right: withSafeArea(16, 'right'),
        // Clear of the bar and of whatever the display keeps below it, so the
        // button is never the thing a home indicator sits on.
        bottom: withSafeArea(TAB_BAR_HEIGHT + 14, 'bottom'),
        zIndex: 20,
      }}
    >
      <Button
        aria-label="Start a session"
        radius="xl"
        w={DIAMETER}
        h={DIAMETER}
        p={0}
        onClick={onStart}
      >
        {/* A plus and not an icon set, the same way the machine selector's
            disclosure is one character: the app ships no icons. */}
        <Text component="span" aria-hidden fz={24} fw={500} lh={1}>
          +
        </Text>
      </Button>
      {needsYou === 0 ? null : <NeedsYouBadge count={needsYou} scheme={scheme} />}
    </Box>
  );
}

interface NeedsYouBadgeProps {
  readonly count: number;
  readonly scheme: Scheme;
}

/**
 * The count, stuck to the corner of the button.
 *
 * Outside the button rather than inside it: a badge inside would join the
 * button's accessible name, and "Start a session, 2" is not what either half
 * means. It is a live region instead, so a session that begins waiting while
 * the app is open says so, and it carries the words rather than only the
 * digit -- a screen reader announcing "2" alone announces nothing.
 */
function NeedsYouBadge({ count, scheme }: NeedsYouBadgeProps): JSX.Element {
  return (
    <Box
      role="status"
      aria-label={needsYouWords(count)}
      style={{
        position: 'absolute',
        top: -2,
        right: -2,
        minWidth: 22,
        height: 22,
        paddingInline: 6,
        borderRadius: 11,
        display: 'grid',
        placeItems: 'center',
        pointerEvents: 'none',
        background: colorForRole('background', scheme),
        border: `1px solid ${colorForRole('borderStrong', scheme)}`,
      }}
    >
      <Text component="span" aria-hidden fz={12} fw={700} lh={1} c={colorForRole('text', scheme)}>
        {count}
      </Text>
    </Box>
  );
}

/** What the badge says when it is read out rather than looked at. */
export function needsYouWords(count: number): string {
  return count === 1 ? '1 session needs you' : `${String(count)} sessions need you`;
}
