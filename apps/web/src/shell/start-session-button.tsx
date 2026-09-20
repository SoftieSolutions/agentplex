import type { JSX } from 'react';
import { Box, Button, Text } from '../ui/components.js';
import { TAB_BAR_HEIGHT } from './bottom-tabs.js';
import { withSafeArea } from './safe-area.js';

/**
 * The round button floating above the phone chrome's tab bar: start a session.
 *
 * That and nothing else. It carried a needs-you badge, which the mockup draws
 * and which read well on its own, but the badge counted the sessions on the
 * machine the header had picked while the bell above it counts the whole
 * fleet -- so a phone could show two different numbers for one fleet and leave
 * a person to work out which was which. One attention number per screen, and
 * the bell is the one that keeps it, because it is the number the browser tab
 * says too.
 *
 * What the button loses with the badge is the argument for putting it here at
 * all, which was that a person opens the app because something is waiting.
 * It stays because the other half of that argument holds: starting work is
 * what somebody does when nothing is, and this is the same start the New
 * session button opens on a wide screen -- the shell holds the form and this
 * opens it -- rather than a second way in with its own rules.
 */

/** The button's diameter. Comfortably past the 44px a fingertip needs. */
const DIAMETER = 56;

export interface StartSessionButtonProps {
  readonly onStart: () => void;
}

export function StartSessionButton({ onStart }: StartSessionButtonProps): JSX.Element {
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
        {/* A plus and not an icon, the same way the machine selector's
            disclosure is one character: the app ships no icon set, and the
            bell's glyph is the one drawn shape, argued where it is drawn. */}
        <Text component="span" aria-hidden fz={24} fw={500} lh={1}>
          +
        </Text>
      </Button>
    </Box>
  );
}
