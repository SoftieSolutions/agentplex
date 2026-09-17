import type { JSX, ReactNode } from 'react';
import { Box, Group, Text, UnstyledButton } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { destinationHash } from './destinations.js';
import { withSafeArea } from './safe-area.js';

/**
 * The bar across the top: the brand mark, and the one slot the chrome keeps
 * for saying how things are.
 *
 * The mockups put a search field beside the mark. It is the command palette
 * (AGX-139) and it is not built, so nothing is drawn for it: a box that looks
 * like a search field and answers no keystroke is worse than the space it
 * would fill. The bell, the New popover (AGX-124) and the avatar are absent
 * for the same reason.
 *
 * The mark is a link and not a picture, because it is how a person gets back
 * to the session list from a destination that has no other way out.
 *
 * This bar is the wide form's alone. It carried a menu button that swapped the
 * sidebar for the content at narrow widths, which was a stand-in until the
 * phone chrome existed (AGX-125); it does not exist below the breakpoint any
 * more, so the button would be a control that never appears.
 */
export interface TopBarProps {
  readonly scheme: Scheme;
  /**
   * The right-hand slot: how the connection is doing, and whatever else the
   * chrome has to say at every width. AGX-119 fills it -- the shell already
   * holds the snapshot that knows, and this is where it goes, so that ticket
   * is a component and a prop rather than a second row of chrome.
   */
  readonly status?: ReactNode;
}

export function TopBar({ scheme, status }: TopBarProps): JSX.Element {
  return (
    <Group
      component="header"
      gap={12}
      align="center"
      wrap="nowrap"
      style={{
        borderBottom: `1px solid ${colorForRole('border', scheme)}`,
        flexShrink: 0,
        // The desk chrome is what a notched phone draws in landscape -- it is
        // wider than the breakpoint -- so this bar is under the cutout there,
        // and the brand mark is the thing it would swallow.
        paddingTop: withSafeArea(8, 'top'),
        paddingBottom: 8,
        paddingLeft: withSafeArea(14, 'left'),
        paddingRight: withSafeArea(14, 'right'),
      }}
    >
      <UnstyledButton component="a" href={destinationHash('sessions')} aria-label="agentplex">
        <Group gap={9} align="center" wrap="nowrap">
          <Box
            aria-hidden
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              display: 'grid',
              placeItems: 'center',
              background: colorForRole('accent', scheme),
              color: colorForRole('onAccent', scheme),
              fontWeight: 800,
            }}
          >
            a
          </Box>
          <Text component="span" fz={14} fw={700} c={colorForRole('text', scheme)}>
            agentplex
          </Text>
        </Group>
      </UnstyledButton>

      <Group gap={8} align="center" wrap="nowrap" style={{ marginLeft: 'auto' }}>
        {status}
      </Group>
    </Group>
  );
}
