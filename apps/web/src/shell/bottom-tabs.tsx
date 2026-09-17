import type { JSX } from 'react';
import { Box, Stack, Text, UnstyledButton } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { destinationHash, TABS, type Destination, type NavEntry } from './destinations.js';
import { withSafeArea } from './safe-area.js';

/**
 * The bar across the foot of the phone chrome: Sessions, Projects, More.
 *
 * Anchors and not buttons, for the reason the sidebar's nav rows are anchors:
 * a tab is an address, so it can be long-pressed, opened in another tab and
 * gone back from, and the browser's own back gesture is then the one that
 * works. `TABS` decides which exist; this decides what one looks like.
 *
 * The bar sits above the display's bottom inset rather than under it. A home
 * indicator over a tab is a tab that cannot be tapped, and `viewport-fit=cover`
 * -- which the terminal wants -- is what puts it there.
 */

/** The bar's own height, before the display's inset is added below it. */
export const TAB_BAR_HEIGHT = 54;

export interface BottomTabsProps {
  /**
   * The tab to mark as the page, or `null` when the address names a thing
   * rather than a place -- a session or a document. Nothing is current then,
   * because the thing on screen is not any of these three places and a tab
   * claiming otherwise would be pointing at the wrong one.
   */
  readonly current: Destination | null;
  readonly scheme: Scheme;
}

export function BottomTabs({ current, scheme }: BottomTabsProps): JSX.Element {
  return (
    <Box
      component="nav"
      aria-label="Sections"
      style={{
        display: 'flex',
        flexShrink: 0,
        background: colorForRole('surfaceAlt', scheme),
        borderTop: `1px solid ${colorForRole('border', scheme)}`,
        paddingBottom: withSafeArea(0, 'bottom'),
        paddingLeft: withSafeArea(0, 'left'),
        paddingRight: withSafeArea(0, 'right'),
      }}
    >
      {TABS.map((tab) => (
        <BottomTab
          key={tab.destination}
          tab={tab}
          current={tab.destination === current}
          scheme={scheme}
        />
      ))}
    </Box>
  );
}

interface BottomTabProps {
  readonly tab: NavEntry;
  readonly current: boolean;
  readonly scheme: Scheme;
}

/**
 * One tab: a label, and a rule above it when this is where the app is.
 *
 * The rule carries the accent and the label carries the weight, so the current
 * tab is legible to somebody who cannot tell the two hues apart. `aria-current`
 * is what says it to everyone else.
 */
function BottomTab({ tab, current, scheme }: BottomTabProps): JSX.Element {
  return (
    <UnstyledButton
      component="a"
      href={destinationHash(tab.destination)}
      aria-current={current ? 'page' : undefined}
      style={{ flex: 1, minWidth: 0, height: TAB_BAR_HEIGHT }}
    >
      <Stack gap={0} align="center" justify="center" style={{ height: '100%' }}>
        <Box
          aria-hidden
          style={{
            width: 22,
            height: 2,
            borderRadius: 1,
            marginBottom: 7,
            background: current ? colorForRole('accent', scheme) : 'transparent',
          }}
        />
        <Text
          component="span"
          fz={11.5}
          fw={current ? 600 : 400}
          c={colorForRole(current ? 'text' : 'textMuted', scheme)}
        >
          {tab.label}
        </Text>
      </Stack>
    </UnstyledButton>
  );
}
