import { useState, type JSX } from 'react';
import type {
  Layout,
  MachineState,
  NodeId,
  ServerRegistrationId,
  SessionRef,
} from '@agentplex/protocol';
import type { TokenStore } from '../auth/token.js';
import { CataloguePanel } from '../catalogue/catalogue-panel.js';
import { createCatalogueStore, type CatalogueStore } from '../catalogue/catalogue-store.js';
import { useDocRoute } from '../docs/doc-route.js';
import { LayoutScreen } from '../layout/layout-screen.js';
import { narrowedToMachine } from '../machines/machine-selector-model.js';
import { NewSessionForm } from '../sessions/new-session-form.js';
import { notificationList } from '../sessions/notification-model.js';
import { listSessions } from '../sessions/session-list-model.js';
import { SessionListScreen } from '../sessions/session-list-screen.js';
import { SettingsRoute } from '../settings/settings-route.js';
import type { HubStore } from '../store/hub-store.js';
import { useHubLayout, useHubSnapshot } from '../store/use-hub-store.js';
import { useSessionRoute } from '../terminal/session-route.js';
import { Box, useComputedColorScheme } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { AttentionBell } from './attention-bell.js';
import { connectionView } from './connection-model.js';
import { ConnectionStatus } from './connection-status.js';
import { resolveDestination, useDestination, type Destination } from './destinations.js';
import { MobileChrome } from './mobile-chrome.js';
import { MoreScreen } from './more-screen.js';
import { withSafeArea } from './safe-area.js';
import { useShellForm, type ShellForm } from './shell-form.js';
import { Sidebar } from './sidebar.js';
import { TopBar } from './top-bar.js';

/**
 * The frame, in both the shapes it takes: a bar across the top with a sidebar
 * down the left, or -- on a phone -- a compact header with a tab bar across the
 * foot. One shell either way. The route model, the screens, and the facts the
 * chrome holds are shared; `shell-form.ts` decides which frame they are drawn
 * in, and `mobile-chrome.tsx` is the other one.
 *
 * The chrome is persistent, which is the point of this file. A session used to
 * replace the page -- the layout screen was the page -- and in the mockups it
 * keeps the chrome, so the route decides what the content region holds and
 * nothing more. What that buys is that the tree, the machine selector and the
 * nav survive navigation: the catalogue is asked once and not once per screen,
 * and a session is somewhere you go rather than somewhere you end up.
 *
 * Three facts live here because more than one thing reads each of them, and one
 * writer is what keeps those readers from disagreeing:
 *
 *   * the machine the app is narrowed to. The selector writes it -- it is in
 *     the sidebar in one form and in the header in the other; the catalogue
 *     query and the cards in the content region read it. The bell above them
 *     deliberately does not: see the node it is built in.
 *     `machine-selector-model.ts` argues why it is one fact.
 *   * the catalogue question itself, as a store. The panel draws it and the
 *     selection narrows it, and the store outlives both the panel's tab and
 *     whatever screen is mounted, so the question and the rows already paged
 *     survive a screen being swapped. Leaving the Projects tab does drop the
 *     interest and returning asks again -- the store is what the answer is
 *     kept in, not what stops it being re-asked.
 *   * whether the start form is open. On a phone it is opened by the action
 *     button in the chrome, which is on screen over every destination, so the
 *     form belongs to the chrome rather than to the list underneath it.
 *
 * No effects: the routes are external stores read through
 * `useSyncExternalStore`, and so are the hub and the window's own width.
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
  const form = useShellForm();
  const [machine, setMachine] = useState<ServerRegistrationId | null>(null);
  // Built once and inert until something subscribes: creating a catalogue
  // store dials nothing, and the panel's first subscriber is what asks.
  const [catalogue] = useState<CatalogueStore>(() => createCatalogueStore({ hub }));
  const [starting, setStarting] = useState(false);

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

  const state = snapshot.machineState;
  // Where the address lands in the form the shell is actually in: Projects and
  // More are places only where there is no sidebar holding both already.
  const place = resolveDestination(destination, form);
  /**
   * The connection line, built once and drawn by whichever chrome is on.
   *
   * The token is read during render, the way the settings screen reads it: it
   * is not a reactive source, and nothing here can subscribe to another tab's
   * localStorage. It does not need to be. A token typed on the settings screen
   * is picked up by the next ticket exchange, that exchange moves the phase,
   * and a phase change is a snapshot change and therefore this render again --
   * so the line corrects itself within one backoff rather than needing a
   * watcher nothing can supply.
   */
  const status = (
    <ConnectionStatus
      view={connectionView({
        phase: snapshot.phase,
        problem: snapshot.problem,
        hasState: state !== null,
        hasToken: tokens.read() !== null,
      })}
      scheme={scheme}
    />
  );
  /**
   * The bell and the panel behind it, built here for the same reason the
   * connection line is: one node, handed to whichever chrome is drawn, so a
   * phone and a desk cannot come to different numbers for one fleet.
   *
   * `machine` is deliberately not passed, and neither is a narrowed list. The
   * bell counts the fleet whole, which means a person who has narrowed to one
   * machine sees a chip on the list counting fewer than the bell does. That is
   * the right way round: the bell is the app's count of what is asking -- the
   * same count the browser tab carries, and the tab strip has no selector on
   * it -- and it has to keep meaning that on the Projects tab and over a
   * session, where no list is drawn to compare it against. What it opens has
   * to be the same fleet, or the panel would answer the mark with a shorter
   * list than the mark counted.
   *
   * `null` is the hub not having answered yet rather than a quiet fleet, and
   * it draws an unmarked bell over an empty panel: the direction that does not
   * over-claim.
   *
   * The clock is read during render, the way the session list reads it for its
   * own ages. It is not a reactive source and nothing subscribes to it: what
   * moves an age on screen is the next snapshot, which is this render again.
   */
  const notifications = notificationList(state === null ? [] : listSessions(state), Date.now());
  const actions = <AttentionBell list={notifications} form={form} scheme={scheme} />;
  const region = content({
    hub,
    tokens,
    state,
    layout,
    catalogue,
    sessionRef,
    doc,
    destination: place,
    machine,
    form,
    scheme,
  });

  if (form === 'phone') {
    return (
      <MobileChrome
        state={state}
        machine={machine}
        onPickMachine={pickMachine}
        // A session or a document is a thing and not one of the three places
        // the bar offers, so no tab claims to be where the app is.
        current={sessionRef !== null || doc !== null ? null : place}
        onStartSession={() => setStarting(true)}
        status={status}
        actions={actions}
        scheme={scheme}
      >
        {region}
        {/* The chrome's own copy of the start form, because the button that
            opens it is the chrome's: the list screen's New session button is
            not drawn at this width. */}
        <NewSessionForm
          store={hub}
          opened={starting}
          onClose={() => setStarting(false)}
          scheme={scheme}
        />
      </MobileChrome>
    );
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
      <TopBar scheme={scheme} status={status} actions={actions} />
      <Box style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <Box
          component="aside"
          w={240}
          style={{
            flexShrink: 0,
            minWidth: 0,
            borderRight: `1px solid ${colorForRole('border', scheme)}`,
            // A notched phone in landscape is wider than the breakpoint, so
            // this chrome is what it draws and these two are its outer edges.
            paddingLeft: withSafeArea(0, 'left'),
          }}
        >
          <Sidebar
            store={hub}
            state={state}
            layout={layout}
            catalogue={catalogue}
            machine={machine}
            onPickMachine={pickMachine}
            destination={place}
            scheme={scheme}
          />
        </Box>
        <Box
          component="main"
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflowY: 'auto',
            paddingRight: withSafeArea(0, 'right'),
          }}
        >
          {region}
        </Box>
      </Box>
    </Box>
  );
}

interface ContentProps {
  readonly hub: HubStore;
  readonly tokens: TokenStore;
  /** The fleet, or `null` while the hub has not answered with one. */
  readonly state: MachineState | null;
  readonly layout: Layout | null;
  readonly catalogue: CatalogueStore;
  /** The session the address names, or `null` for no session route. */
  readonly sessionRef: SessionRef | null;
  /** The document the address names, or `null` for no document route. */
  readonly doc: NodeId | null;
  /** Already resolved for the form: see `resolveDestination`. */
  readonly destination: Destination;
  readonly machine: ServerRegistrationId | null;
  /** Passed on to the session list, which draws one control only in one form. */
  readonly form: ShellForm;
  readonly scheme: Scheme;
}

/**
 * What the content region holds, which is the whole of what the route decides
 * now that the chrome is persistent.
 *
 * A session or a document wins over a destination: both are addresses of a
 * thing rather than of a place, and the layout screen is how a thing is shown.
 * It is deliberately not keyed on the route -- the layout outlives navigation,
 * and the panes key their own mounts.
 *
 * Projects is here rather than in the phone chrome because the two forms share
 * one content region: the tree is the sidebar's on a wide screen and a
 * destination on a phone, and `resolveDestination` has already decided which of
 * those this call is. The panel itself is the same component either way, over
 * the same catalogue store, so tapping Projects on a phone asks the hub nothing
 * it has already been asked.
 */
function content({
  hub,
  tokens,
  state,
  layout,
  catalogue,
  sessionRef,
  doc,
  destination,
  machine,
  form,
  scheme,
}: ContentProps): JSX.Element {
  if (sessionRef !== null || doc !== null) {
    return <LayoutScreen session={sessionRef} doc={doc} store={hub} />;
  }
  if (destination === 'settings') {
    return <SettingsRoute store={hub} tokens={tokens} />;
  }
  if (destination === 'projects') {
    return (
      <Box p={12}>
        <CataloguePanel
          store={hub}
          state={state}
          layout={layout}
          scheme={scheme}
          catalogue={catalogue}
        />
      </Box>
    );
  }
  if (destination === 'more') {
    return <MoreScreen scheme={scheme} />;
  }
  return <SessionListScreen store={hub} machine={machine} form={form} />;
}
