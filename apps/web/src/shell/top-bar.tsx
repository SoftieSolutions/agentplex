import type { JSX, ReactNode } from 'react';
import { Box, Button, Group, Text, UnstyledButton } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { destinationHash } from './destinations.js';

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
  /** Whether the sidebar is showing at widths too narrow to hold both. */
  readonly sidebarOpen: boolean;
  readonly onToggleSidebar: () => void;
}

export function TopBar({ scheme, status, sidebarOpen, onToggleSidebar }: TopBarProps): JSX.Element {
  return (
    <Group
      component="header"
      gap={12}
      align="center"
      wrap="nowrap"
      px={14}
      py={8}
      style={{ borderBottom: `1px solid ${colorForRole('border', scheme)}`, flexShrink: 0 }}
    >
      {/* Below the breakpoint the sidebar and the content cannot both be on
          screen, so this is what swaps them. Above it the sidebar is always
          drawn and the button is not: the phone chrome proper is AGX-125. */}
      <Button
        hiddenFrom="md"
        size="compact-xs"
        variant="default"
        aria-expanded={sidebarOpen}
        aria-label={sidebarOpen ? 'Hide the sidebar' : 'Show the sidebar'}
        onClick={onToggleSidebar}
      >
        {sidebarOpen ? 'Close' : 'Menu'}
      </Button>

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
