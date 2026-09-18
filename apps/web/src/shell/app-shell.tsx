import { useState, type JSX } from 'react';
import type { NodeId, ServerRegistrationId, SessionRef } from '@agentplex/protocol';
import type { TokenStore } from '../auth/token.js';
import { createCatalogueStore, type CatalogueStore } from '../catalogue/catalogue-store.js';
import { useDocRoute } from '../docs/doc-route.js';
import { LayoutScreen } from '../layout/layout-screen.js';
import { narrowedToMachine } from '../machines/machine-selector-model.js';
import { SessionListScreen } from '../sessions/session-list-screen.js';
import { SettingsRoute } from '../settings/settings-route.js';
import type { HubStore } from '../store/hub-store.js';
import { useHubLayout, useHubSnapshot } from '../store/use-hub-store.js';
import { sessionHash, useSessionRoute } from '../terminal/session-route.js';
import { Box, useComputedColorScheme } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { useDestination, type Destination } from './destinations.js';
import { Sidebar } from './sidebar.js';
import { TopBar } from './top-bar.js';

/**
 * The frame: a bar across the top, a sidebar down the left, and a content
 * region every screen mounts into.
 *
 * The chrome is persistent, which is the whole point of this file. A session
 * used to replace the page -- the layout screen was the page -- and in the
 * mockups it keeps the sidebar, so the route decides what the content region
 * holds and nothing more. What that buys is that the tree, the machine
 * selector and the nav survive navigation: the catalogue is asked once and
 * not once per screen, and a session is somewhere you go rather than somewhere
 * you end up.
 *
 * Two facts live here because two things read each of them, and one writer is
 * what keeps the two from disagreeing:
 *
 *   * the machine the app is narrowed to. The selector at the top of the
 *     sidebar writes it; the catalogue query and the cards in the content
 *     region read it. `machine-selector-model.ts` argues why it is one fact.
 *   * the catalogue question itself, as a store. The panel draws it and the
 *     selection narrows it, and the store outlives both the panel's tab and
 *     whatever screen is mounted, so the question and the rows already paged
 *     survive a screen being swapped. Leaving the Projects tab does drop the
 *     interest and returning asks again -- the store is what the answer is
 *     kept in, not what stops it being re-asked.
 *
 * Narrow widths: the sidebar and the content cannot both be on screen, so each
 * is rendered exactly once and carries `visibleFrom` while the other is the
 * one being shown. The same decision the session list makes about its columns,
 * for the same reason -- a media-query hook would be a second source of truth
 * about one breakpoint. Above the breakpoint neither carries it and both are
 * drawn, so the toggle cannot strand a wide screen with half a page. The phone
 * chrome proper is AGX-125.
 *
 * No effects: the routes are external stores read through
 * `useSyncExternalStore`, and so is the hub.
 */
export interface AppShellProps {
  /** The page's one hub store, built by `main.tsx` and handed in. */
  readonly hub: HubStore;
  /** Where the credential lives: written by Settings, read by the store. */
  readonly tokens: TokenStore;
}

export function AppShell({ hub, tokens }: AppShellProps): JSX.Element {
  const scheme: Scheme = useComputedColorScheme('dark');
  const snapshot = useHubSnapshot(hub);
  // Declaring interest in the tree here rather than in the sidebar, because
  // the chrome is what is always looking at it now: it is what sends the
  // layout request, and what has it sent again after every reconnection.
  const layout = useHubLayout(hub);
  const sessionRef = useSessionRoute();
  const doc = useDocRoute();
  const destination = useDestination();
  const [machine, setMachine] = useState<ServerRegistrationId | null>(null);
  // Built once and inert until something subscribes: creating a catalogue
  // store dials nothing, and the panel's first subscriber is what asks.
  const [catalogue] = useState<CatalogueStore>(() => createCatalogueStore({ hub }));
  // The sidebar's own openness below the breakpoint, and the address it was
  // opened at. Two fields and not one because the content is `display: none`
  // while the sidebar is open there: a tap on a session row or a nav link
  // would otherwise change the address and leave the person looking at the
  // sidebar they tapped in. Reading it back against the current address is
  // what closes it, rather than a handler on every link -- the address is
  // what "somewhere else" means, and this way the rows, the nav and the brand
  // mark all count without any of them knowing about the sidebar.
  const [sidebar, setSidebar] = useState<SidebarOpening>({ open: false, address: '' });
  const address = addressOf(destination, sessionRef, doc);
  const sidebarOpen = sidebar.open && sidebar.address === address;

  /**
   * The one place the selection moves from. Two things read it -- the cards
   * and the catalogue query -- and they are written together here rather than
   * kept in step afterwards. The query's copy is the filter field itself,
   * because that is what goes on the wire. It is in the body because it writes
   * this component's state and the store this component holds; everything it
   * decides is in the model it calls.
   */
  function pickMachine(next: ServerRegistrationId | null): void {
    setMachine(next);
    catalogue.reshape(narrowedToMachine(catalogue.getSnapshot().shape, next));
  }

  return (
    <Box
      style={{
        height: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        background: colorForRole('background', scheme),
      }}
    >
      <TopBar
        scheme={scheme}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebar({ open: !sidebarOpen, address })}
      />
      <Box style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <Box
          component="aside"
          w={{ base: '100%', md: 240 }}
          {...(sidebarOpen ? {} : { visibleFrom: 'md' as const })}
          style={{
            flexShrink: 0,
            minWidth: 0,
            borderRight: `1px solid ${colorForRole('border', scheme)}`,
          }}
        >
          <Sidebar
            store={hub}
            state={snapshot.machineState}
            layout={layout}
            catalogue={catalogue}
            machine={machine}
            onPickMachine={pickMachine}
            destination={destination}
            scheme={scheme}
          />
        </Box>
        <Box
          component="main"
          {...(sidebarOpen ? { visibleFrom: 'md' as const } : {})}
          style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto' }}
        >
          {content({ hub, tokens, sessionRef, doc, destination, machine })}
        </Box>
      </Box>
    </Box>
  );
}

/** The sidebar being open, and the address it was opened at. */
interface SidebarOpening {
  readonly open: boolean;
  readonly address: string;
}

/**
 * The address the shell resolved, as one string to compare. Every route this
 * file reads is in it, so a session row, a nav link and the brand mark are all
 * a change of address -- which is the only thing the sidebar has to notice.
 */
function addressOf(
  destination: Destination,
  sessionRef: SessionRef | null,
  doc: NodeId | null,
): string {
  if (sessionRef !== null) return sessionHash(sessionRef);
  if (doc !== null) return `doc/${doc}`;
  return destination;
}

interface ContentProps {
  readonly hub: HubStore;
  readonly tokens: TokenStore;
  /** The session the address names, or `null` for no session route. */
  readonly sessionRef: SessionRef | null;
  /** The document the address names, or `null` for no document route. */
  readonly doc: NodeId | null;
  readonly destination: Destination;
  readonly machine: ServerRegistrationId | null;
}

/**
 * What the content region holds, which is the whole of what the route decides
 * now that the chrome is persistent.
 *
 * A session or a document wins over a destination: both are addresses of a
 * thing rather than of a place, and the layout screen is how a thing is shown.
 * It is deliberately not keyed on the route -- the layout outlives navigation,
 * and the panes key their own mounts.
 */
function content({
  hub,
  tokens,
  sessionRef,
  doc,
  destination,
  machine,
}: ContentProps): JSX.Element {
  if (sessionRef !== null || doc !== null) {
    return <LayoutScreen session={sessionRef} doc={doc} store={hub} />;
  }
  if (destination === 'settings') {
    return <SettingsRoute store={hub} tokens={tokens} />;
  }
  return <SessionListScreen store={hub} machine={machine} />;
}
