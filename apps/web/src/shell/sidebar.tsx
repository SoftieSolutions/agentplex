import { useState, useSyncExternalStore, type JSX } from 'react';
import type { FrameId, Layout, MachineState, ServerRegistrationId } from '@agentplex/protocol';
import { CataloguePanel } from '../catalogue/catalogue-panel.js';
import type { CatalogueStore } from '../catalogue/catalogue-store.js';
import { appLayoutStore } from '../layout/app-layout.js';
import type { LayoutStore } from '../layout/layout-store.js';
import { MachineSelector } from '../machines/machine-selector.js';
import { pendingRows } from '../sessions/pending-rows-model.js';
import { appSessionFiltersStore } from '../sessions/session-filters-store.js';
import { SettingsSectionNav } from '../settings/settings-section-nav.js';
import type { HubStore } from '../store/hub-store.js';
import { shallowEqual, useHubSelector } from '../store/use-hub-store.js';
import type { HubSnapshot } from '../store/views.js';
import { startHash } from '../terminal/start-route.js';
import { Box, SegmentedControl, Stack, Text, UnstyledButton } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import {
  destinationHash,
  NAV,
  type Destination,
  type SettingsSection,
  type SettingsSectionEntry,
} from './destinations.js';
import { SidebarFilter } from './sidebar-filter.js';
import { SidebarSessions } from './sidebar-sessions.js';

/**
 * The left-hand column every mockup shares: what the app is narrowed to, the
 * two readings of the fleet, and the nav at the foot.
 *
 * The machine selector sits above the tabs because that is what it narrows --
 * both readings at once, and the cards in the content region with them -- and
 * the selection itself is held by the shell rather than here, so there is one
 * writer for the one fact. `machine-selector-model.ts` has the argument.
 *
 * The tab pair chooses which reading is drawn, and only one is mounted at a
 * time: the choice is an act of the user's rather than a breakpoint, so there
 * is nothing for CSS to decide. Leaving the Projects tab unmounts the panel
 * and drops the catalogue interest with it, so coming back asks the question
 * again; what the shell's store keeps across that is the question itself and
 * the rows already paged, which is why the tab is cheap to leave and why the
 * rows are there before the answer is.
 *
 * The one thing that chooses for the person is the address. `#/projects` is a
 * place only a phone has a content region for, and at this width
 * `resolveDestination` lands it on the session list -- so something following
 * that address, the palette's project rows above all, would otherwise change
 * nothing a person can see while the tree it meant sits one tab away. The tab
 * adopts the address when the address moves to Projects and at no other
 * moment: it is a starting point and not a binding, so pressing Sessions under
 * `#/projects` stays on Sessions, and a second project followed from that same
 * address moves nothing, because the address did not move either. Revealing
 * and selecting the node itself is a ticket of its own; this is the column
 * being on the right reading when the person arrives.
 *
 * Under the tabs is the filter row both mockups draw (6a, 6b, 7a), and it is
 * one row over two tabs rather than one per tab. What the box narrows is the
 * tab's: the tree's letters are held here, because the panel under them is
 * unmounted by a tab switch and a filter that emptied itself on the way back
 * would be a box that forgets; the sessions' letters are the `search` field of
 * the narrowings the popover writes and the cards in the content region read,
 * which is the whole reason that store exists.
 *
 * The popover beside the box is the tab's too. On the Sessions tab it holds
 * the sessions' narrowings; on the Projects tab it holds the catalogue
 * query's sort and its provider and status narrowings, which is a departure
 * from mockup 6a -- that draws the Projects tab with the box alone -- made on
 * purpose, because those controls otherwise stack as selects above the tree.
 * Neither tab's popover counts the other's narrowings: the tab is independent
 * of the route, so with a session or a document open in the content region a
 * session narrowing counted over the tree would be a badge over rows nobody
 * can see. Mounting the catalogue's popover with the tab is also what keeps
 * the catalogue interest to the Projects tab.
 *
 * Nothing above a fleet: with no `MachineState` there is no option to offer,
 * no count to draw and nothing to narrow, so the row is not drawn at all
 * rather than drawn inert over "waiting for the hub".
 *
 * The nav is whatever `destinations.ts` says can honestly be reached. Graphs
 * and Library are named in the mockups and built by nobody yet, so they are
 * not drawn at all.
 *
 * While the content region is Settings, the column above the nav is the
 * settings sections instead (AGX-388): nothing in settings is a reading of the
 * fleet, so a selector, two tabs and a filter over it would be controls that
 * narrow nothing on screen. It is a branch inside this component rather than
 * a second sidebar swapped in by the shell, so the tab and the tree's letters
 * are held above it and are exactly as they were when the person leaves
 * settings. Moving into settings does unmount the catalogue panel, which drops
 * the catalogue interest the way choosing the Sessions tab does.
 */

/** Which reading of the fleet the sidebar is showing. */
export type SidebarTab = 'projects' | 'sessions';

export interface SidebarProps {
  readonly store: HubStore;
  /** The fleet, or `null` while the hub has not answered with one yet. */
  readonly state: MachineState | null;
  /** The tree, for what a move may offer and what is not in it. */
  readonly layout: Layout | null;
  /** The catalogue question, held by the shell because the selector writes it. */
  readonly catalogue: CatalogueStore;
  readonly machine: ServerRegistrationId | null;
  readonly onPickMachine: (machine: ServerRegistrationId | null) => void;
  /** Where the content region is, so the nav can say which row is current. */
  readonly destination: Destination;
  /**
   * The address itself, before the form resolved it -- which is a different
   * fact from the one above, and the difference is the whole of why this is
   * here: at this width `#/projects` resolves to the session list, so
   * `destination` cannot say that the projects were asked for. Handed down
   * rather than parsed here, because the shell already reads the hash through
   * `useDestination` and a second parser would be a second answer.
   */
  readonly address: Destination;
  /**
   * The settings section the address names, already resolved against what is
   * offered, and the sections offered. Both are the shell's, which hands the
   * same two to the content region: one reading is what keeps the column and
   * the screen beside it from marking different sections current.
   */
  readonly section: SettingsSection;
  readonly sections: readonly SettingsSectionEntry[];
  readonly scheme: Scheme;
  /**
   * The clock the column is read against, injected so a test can pin an age.
   * Read once per render and handed to both of the things below that measure
   * one -- the row's age window and the rows' ages -- because two readings of
   * `Date.now` in one render are two answers to how old a session is.
   */
  readonly now?: () => number;
  /** Where a start's row opens its pane: the page's arrangement unless a test's. */
  readonly layoutStore?: LayoutStore;
}

export function Sidebar({
  store,
  state,
  layout,
  catalogue,
  machine,
  onPickMachine,
  destination,
  address,
  section,
  sections,
  scheme,
  now = Date.now,
  layoutStore,
}: SidebarProps): JSX.Element {
  const [tab, setTab] = useState<SidebarTab>('projects');
  // The address the tab was last reconciled with, so a move to Projects is
  // adopted once and a render for any other reason leaves the reading alone.
  // Written during render rather than from an effect: the tab is derived from
  // a prop that changed, React re-runs the body before it commits anything,
  // and an effect would draw the wrong reading for one frame.
  const [addressed, setAddressed] = useState<Destination>(address);
  if (address !== addressed) {
    setAddressed(address);
    if (address === 'projects') setTab('projects');
  }
  // The tree's letters, held by the sidebar rather than by the panel because
  // the box is drawn out here and outlives the tab that mounts the panel.
  const [treeFilter, setTreeFilter] = useState('');
  const filters = appSessionFiltersStore(store);
  const held = useSyncExternalStore(filters.subscribe, filters.getSnapshot);
  const projects = tab === 'projects';
  const moment = now();
  const { starts, terminals, connection } = useHubSelector(store, startsAndTerminals, shallowEqual);
  const pending = pendingRows(starts, terminals, state, layout, machine, {
    connection,
    now: moment,
  });
  if (destination === 'settings') {
    return (
      <Stack gap={10} p={10} style={{ height: '100%', minHeight: 0 }}>
        <Box style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <SettingsSectionNav
            current={section}
            offered={sections}
            direction="column"
            scheme={scheme}
          />
        </Box>
        <FootNav destination={destination} scheme={scheme} />
      </Stack>
    );
  }
  return (
    <Stack gap={10} p={10} style={{ height: '100%', minHeight: 0 }}>
      <MachineSelector
        state={state}
        chosen={machine}
        onPick={onPickMachine}
        scheme={scheme}
        now={() => moment}
      />

      <SegmentedControl
        size="xs"
        fullWidth
        aria-label="What the sidebar shows"
        value={tab}
        onChange={(value) => setTab(readTab(value))}
        data={[
          { value: 'projects', label: 'Projects' },
          { value: 'sessions', label: 'Sessions' },
        ]}
      />

      {/* Two elements rather than one with its props chosen by a ternary:
          each tab's popover takes different props, and the union is what
          keeps a catalogue row from being handed a session clock. */}
      {state === null ? null : projects ? (
        <SidebarFilter
          popover="catalogue"
          catalogue={catalogue}
          state={state}
          label="Filter tree"
          text={treeFilter}
          onText={setTreeFilter}
          scheme={scheme}
        />
      ) : (
        <SidebarFilter
          popover="sessions"
          state={state}
          filters={filters}
          machine={machine}
          label="Filter sessions"
          text={held.search}
          onText={(text) => filters.set({ search: text })}
          scheme={scheme}
          now={() => moment}
        />
      )}

      <Box style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {state === null ? (
          <Text fz={12} c={colorForRole('textMuted', scheme)}>
            waiting for the hub
          </Text>
        ) : projects ? (
          <CataloguePanel
            store={store}
            state={state}
            layout={layout}
            scheme={scheme}
            catalogue={catalogue}
            filter={treeFilter}
          />
        ) : (
          <SidebarSessions
            state={state}
            pending={pending}
            onOpenPending={(startId) => openPending(layoutStore ?? appLayoutStore(store), startId)}
            filters={filters}
            machine={machine}
            scheme={scheme}
            now={() => moment}
          />
        )}
      </Box>

      <FootNav destination={destination} scheme={scheme} />
    </Stack>
  );
}

/**
 * The nav at the foot of the column, under either body. Labelled because in
 * settings the section nav above it is a nav too, and two unnamed ones are two
 * a reader cannot tell apart.
 */
function FootNav({
  destination,
  scheme,
}: {
  readonly destination: Destination;
  readonly scheme: Scheme;
}): JSX.Element {
  return (
    <Stack
      component="nav"
      aria-label="Destinations"
      gap={1}
      style={{ borderTop: `1px solid ${colorForRole('border', scheme)}`, paddingTop: 8 }}
    >
      {NAV.map((entry) => (
        <UnstyledButton
          key={entry.destination}
          component="a"
          href={destinationHash(entry.destination)}
          aria-current={entry.destination === destination ? 'page' : undefined}
          fz={12.5}
          fw={entry.destination === destination ? 600 : 400}
          c={colorForRole(entry.destination === destination ? 'text' : 'textSecondary', scheme)}
          bg={entry.destination === destination ? colorForRole('raised', scheme) : 'transparent'}
          style={{ display: 'block', padding: '6px 8px', borderRadius: 6 }}
        >
          {entry.label}
        </UnstyledButton>
      ))}
    </Stack>
  );
}

/** A control hands back a string, and a string is a claim. */
function readTab(value: string): SidebarTab {
  return value === 'sessions' ? 'sessions' : 'projects';
}

/** What a start's row is read off -- its two maps and which connection is up -- and nothing else. */
function startsAndTerminals(
  snapshot: HubSnapshot,
): Pick<HubSnapshot, 'starts' | 'terminals' | 'connection'> {
  return {
    starts: snapshot.starts,
    terminals: snapshot.terminals,
    connection: snapshot.connection,
  };
}

/**
 * Opens the pane waiting on a start, then routes the content region to it.
 *
 * The pane first and the address second, so the layout screen that the new
 * address mounts finds the pane already there and only focuses it. The
 * address is what makes the region draw panes at all: from the list, the
 * layout store holding a pending pane is not something the shell is looking
 * at.
 */
function openPending(layout: LayoutStore, startId: FrameId): void {
  layout.showPendingSession(startId);
  window.location.hash = startHash(startId);
}
