import type { JSX, ReactNode } from 'react';
import { Box, Group, Text, UnstyledButton } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { destinationHash } from './destinations.js';
import { withSafeArea } from './safe-area.js';

/**
 * The bar across the top: the brand mark, and the two slots the chrome keeps
 * -- how things are, and what it offers at every address.
 *
 * The mockups put a search field beside the mark. It is the command palette
 * (AGX-139) and it is not built, so nothing is drawn for it: a box that looks
 * like a search field and answers no keystroke is worse than the space it
 * would fill. The bell and the New menu are built, and both arrive in the
 * actions slot: the bell has something true to say at every count and a panel
 * that says the rest, and New offers only the kinds that exist rather than a
 * row per kind the mockup drew (AGX-124).
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

export function TopBar({ scheme, status, actions }: TopBarProps): JSX.Element {
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
        {actions}
      </Group>
    </Group>
  );
}
