import type { JSX, ReactNode } from 'react';
import type { MachineState, ServerRegistrationId } from '@agentplex/protocol';
import { MachineSelector } from '../machines/machine-selector.js';
import { Box, Group } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { BottomTabs } from './bottom-tabs.js';
import type { Destination } from './destinations.js';
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
 * The header carries the machine selector and nothing else. The mockup puts a
 * search entry beside it, which is the command palette (AGX-139) and is not
 * built; a box that looks like a search field and answers no keystroke is
 * worse than the space it would fill, which is the same call the top bar made.
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
  /** The tab to mark, or `null` when the address names a session or a document. */
  readonly current: Destination | null;
  /** How many sessions want a human, as the session list's chip counts them. */
  readonly needsYou: number;
  /** Opens the start form the shell holds -- the same one New session opens. */
  readonly onStartSession: () => void;
  readonly scheme: Scheme;
  /** The content region: whatever the address resolved to. */
  readonly children: ReactNode;
}

export function MobileChrome({
  state,
  machine,
  onPickMachine,
  current,
  needsYou,
  onStartSession,
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
        px={12}
        py={8}
        style={{ borderBottom: `1px solid ${colorForRole('border', scheme)}`, flexShrink: 0 }}
      >
        <MachineSelector state={state} chosen={machine} onPick={onPickMachine} scheme={scheme} />
      </Group>

      <Box component="main" style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto' }}>
        {children}
      </Box>

      <StartSessionButton needsYou={needsYou} onStart={onStartSession} scheme={scheme} />
      <BottomTabs current={current} scheme={scheme} />
    </Box>
  );
}
