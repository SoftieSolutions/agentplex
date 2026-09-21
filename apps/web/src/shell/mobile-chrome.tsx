import type { JSX, ReactNode } from 'react';
import type { MachineState, ServerRegistrationId } from '@agentplex/protocol';
import { MachineSelector } from '../machines/machine-selector.js';
import { Box, Group } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { BottomTabs } from './bottom-tabs.js';
import type { Destination } from './destinations.js';
import { withSafeArea } from './safe-area.js';
import { StartSessionButton } from './start-session-button.js';

/**
 * The phone form of the shell: a compact header, the content region, a tab bar
 * across the foot, and the action button floating above it.
 *
 * It is a breakpoint of the one shell and not a second app. The addresses are
 * the same addresses (`destinations.ts`), the content region holds the same
 * screens, and the facts the chrome owns -- the machine the app is narrowed
 * to, the catalogue question, the form the start button opens -- are the
 * shell's in both forms. What changes is where the chrome puts itself: the
 * sidebar has nowhere to be on a phone, so its two readings became two tabs
 * and its nav became the third.
 *
 * The header carries the machine selector and, across from it, the two slots
 * the top bar keeps: the connection line and the chrome's actions, the bell
 * among them. Both are nodes the shell builds once and hands to whichever
 * chrome is drawn, because a socket that has dropped has dropped at every
 * width and the count of what is waiting is the same count on a phone -- a
 * second wording or a second number here would be the app disagreeing with
 * itself. The mockup also puts a search entry in this header, which is the
 * command palette (AGX-139) and is not built; a box that looks like a search
 * field and answers no keystroke is worse than the space it would fill, which
 * is the same call the top bar made, and the New popover (AGX-124) is absent
 * for the same reason.
 *
 * No effects: every fact here arrives as a prop, and the one thing this file
 * measures -- which form to be in -- was measured by `useShellForm` before this
 * component existed.
 */
export interface MobileChromeProps {
  /** The fleet, or `null` while the hub has not answered with one. */
  readonly state: MachineState | null;
  readonly machine: ServerRegistrationId | null;
  readonly onPickMachine: (machine: ServerRegistrationId | null) => void;
  /**
   * The tab to mark, or `null` when the address names a thing -- a session or
   * a document -- rather than one of the three places.
   *
   * That absence decides two things, because it is one fact: no tab claims to
   * be where the app is, and the action button does not float. A terminal is
   * read to its last line and a round button in that corner covers it, so the
   * button belongs to the places a session is started from. The bar stays, and
   * is the way back to them.
   */
  readonly current: Destination | null;
  /**
   * Opens the start form the shell holds -- the one instance in the page, and
   * the same one the New menu's Session row opens in the wide form.
   */
  readonly onStartSession: () => void;
  /**
   * How the connection is doing, in the header's own slot: the same node the
   * top bar is handed, because a phone is a form of this shell and not a
   * second app, and a connection that is down is down at every width.
   */
  readonly status?: ReactNode;
  /**
   * What the chrome offers at every address -- the attention bell today. The
   * same node the top bar is handed, for the same reason `status` is: the
   * shell builds it from the fleet it already holds, so the bell cannot count
   * one thing on a phone and another on a desk.
   */
  readonly actions?: ReactNode;
  readonly scheme: Scheme;
  /** The content region: whatever the address resolved to. */
  readonly children: ReactNode;
}

export function MobileChrome({
  state,
  machine,
  onPickMachine,
  current,
  onStartSession,
  status,
  actions,
  scheme,
  children,
}: MobileChromeProps): JSX.Element {
  return (
    <Box
      style={{
        height: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        // The button floats against this frame rather than against the
        // viewport: `fixed` would put it over a modal and over the keyboard.
        position: 'relative',
        background: colorForRole('background', scheme),
      }}
    >
      <Group
        component="header"
        gap={10}
        align="center"
        wrap="nowrap"
        style={{
          borderBottom: `1px solid ${colorForRole('border', scheme)}`,
          flexShrink: 0,
          // Under the status bar in a PWA taken to a home screen, and under the
          // cutout in landscape: the header is the top edge the way the tab bar
          // is the bottom one.
          paddingTop: withSafeArea(8, 'top'),
          paddingBottom: 8,
          paddingLeft: withSafeArea(12, 'left'),
          paddingRight: withSafeArea(12, 'right'),
        }}
      >
        <MachineSelector state={state} chosen={machine} onPick={onPickMachine} scheme={scheme} />
        <Group gap={8} align="center" wrap="nowrap" style={{ marginLeft: 'auto', minWidth: 0 }}>
          {status}
          {actions}
        </Group>
      </Group>

      <Box component="main" style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto' }}>
        {children}
      </Box>

      {current === null ? null : <StartSessionButton onStart={onStartSession} />}
      <BottomTabs current={current} scheme={scheme} />
    </Box>
  );
}
