import type { CSSProperties, JSX } from 'react';
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
 * The count comes from `needsYouCount`, which counts the sessions waiting on a
 * human that something can actually be done about. It is deliberately not the
 * Needs you chip's number, which is larger whenever a machine is unreachable:
 * a chip promises how many rows pressing it yields, and a badge claims
 * somebody's attention. `needsYouCount` carries the argument.
 */

/** The button's diameter. Comfortably past the 44px a fingertip needs. */
const DIAMETER = 56;

/**
 * Off screen, and still read out. `display: none` and `visibility: hidden` are
 * both dropped from the accessibility tree, which for a live region means it
 * announces nothing at all.
 */
const OFF_SCREEN: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

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
      {/* Mounted at every count, empty at zero. A live region inserted at the
          moment its number appears is a region nothing was watching, so the
          first session to start waiting -- the one announcement worth making
          -- is the one that would be missed. */}
      <Box role="status" style={OFF_SCREEN}>
        {needsYou === 0 ? '' : needsYouWords(needsYou)}
      </Box>
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
 * Drawing only, and outside the button: a badge inside would join the button's
 * accessible name, and "Start a session, 2" is not what either half means. The
 * words are said by the live region above, which is mounted whether or not
 * this is -- a screen reader announcing "2" on its own announces nothing.
 */
function NeedsYouBadge({ count, scheme }: NeedsYouBadgeProps): JSX.Element {
  return (
    <Box
      aria-hidden
      data-needs-you={count}
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
      <Text component="span" fz={12} fw={700} lh={1} c={colorForRole('text', scheme)}>
        {count}
      </Text>
    </Box>
  );
}

/** What the badge says when it is read out rather than looked at. */
export function needsYouWords(count: number): string {
  return count === 1 ? '1 session needs you' : `${String(count)} sessions need you`;
}
