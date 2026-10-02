import type { JSX, ReactNode } from 'react';
import { Box, Group, Text, UnstyledButton } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { destinationHash } from './destinations.js';
import { withSafeArea } from './safe-area.js';

/**
 * The bar across the top: the brand mark, and the three slots the chrome keeps
 * -- what it searches, how things are, and what it offers at every address.
 *
 * The search bar is the command palette (AGX-139), and it is a real control
 * now: it opens a dialog that searches the fleet and ends on an address. Its
 * trigger sits on the bar's midline by explicit request, departing from 7a,
 * which draws it beside the mark: the bar is a grid whose two outer tracks are
 * sized alike, so the middle one is centred whatever the status words say. The bell and the New menu arrive in the actions
 * slot: the bell has something true to say at every count and a panel that says
 * the rest, and New offers only the kinds that exist rather than a row per kind
 * the mockup drew (AGX-124).
 *
 * The avatar the mockups draw beside it is not built and is not waiting on a
 * ticket. There is one person on a hub they paired themselves, so a portrait
 * of them would be chrome that tells them who they are; what lives behind it
 * elsewhere -- an account, a sign-out -- this app has no such thing.
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
   * The palette's trigger, centred on the bar's midline by explicit request
   * rather than beside the mark where mockup 7a draws it.
   *
   * It is wrapped in a cell of its own because the palette hands back a
   * fragment, and a grid would otherwise lay out each of its parts as a cell.
   *
   * A node the shell builds, for the reason the two slots below are: the
   * palette is one control over one fleet, and the phone chrome is handed the
   * same one rather than a second copy that could search something else.
   */
  readonly search?: ReactNode;
  /**
   * The right-hand slot: how the connection is doing, and whatever else the
   * chrome has to say at every width.
   *
   * A node and not a snapshot, because the phone header holds the same one:
   * the shell builds it once from the facts it already has
   * (`connection-model.ts`) and hands it to whichever chrome is drawn, so a
   * dropped socket is worded once rather than once per form.
   */
  readonly status?: ReactNode;
  /**
   * The far end of that slot: the controls the chrome offers wherever the app
   * is, which here are the attention bell and the New menu beside it.
   *
   * A node for the reason `status` is one, and built by the shell for the same
   * reason: the phone header is handed its own, holding the bell without the
   * menu, because a phone has an action button that starts a session and two
   * controls doing one thing is what this ticket took away. Which controls a
   * form offers is one decision in the shell rather than one per frame here.
   *
   * After the status line rather than before it, so the bar reads as a
   * sentence that ends in the thing a person clicks and the corner holds a
   * control rather than prose.
   */
  readonly actions?: ReactNode;
}

/**
 * The narrowest the right-hand track gets: the bell, the New menu, and a status
 * word with the Retry or Settings button it carries when it has one.
 *
 * The left track takes the same floor although the mark needs less, because the
 * two outer tracks being equal is what keeps the trigger on the midline. A floor
 * on the right alone would let a long status line widen that track and push the
 * trigger off centre; with both equal, a status line longer than its track is
 * truncated in place instead.
 */
const SIDE_TRACK_FLOOR = 220;

const TOP_BAR_COLUMNS = `minmax(${String(SIDE_TRACK_FLOOR)}px, 1fr) minmax(0, auto) minmax(${String(SIDE_TRACK_FLOOR)}px, 1fr)`;

export function TopBar({ scheme, search, status, actions }: TopBarProps): JSX.Element {
  return (
    <Box
      component="header"
      style={{
        display: 'grid',
        gridTemplateColumns: TOP_BAR_COLUMNS,
        alignItems: 'center',
        columnGap: 12,
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
      <UnstyledButton
        component="a"
        href={destinationHash('sessions')}
        aria-label="agentplex"
        style={{ justifySelf: 'start' }}
      >
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

      <Box data-search-slot style={{ display: 'flex', justifyContent: 'center', minWidth: 0 }}>
        {search}
      </Box>

      {/* The alignment is in the style rather than Group's props: those are a
          class and CSS variables, and the style is what a test can read. */}
      <Group
        gap={8}
        align="center"
        wrap="nowrap"
        style={{ minWidth: 0, justifyContent: 'flex-end' }}
      >
        {status}
        {actions}
      </Group>
    </Box>
  );
}
