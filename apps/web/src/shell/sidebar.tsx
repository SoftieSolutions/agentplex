import { useState, useSyncExternalStore, type JSX } from 'react';
import type { Layout, MachineState, ServerRegistrationId } from '@agentplex/protocol';
import { CataloguePanel } from '../catalogue/catalogue-panel.js';
import type { CatalogueStore } from '../catalogue/catalogue-store.js';
import { MachineSelector } from '../machines/machine-selector.js';
import { appSessionFiltersStore } from '../sessions/session-filters-store.js';
import type { HubStore } from '../store/hub-store.js';
import { Box, SegmentedControl, Stack, Text, UnstyledButton } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { destinationHash, NAV, type Destination } from './destinations.js';
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
 * The popover comes with the Sessions tab and not with the other, which is
 * what mockup 6a draws: the Projects tab gets the box alone. Every narrowing
 * in it narrows sessions, and the tab is independent of the route -- with a
 * session or a document open in the content region there are no cards beside
 * the tree at all -- so on the Projects tab it would be a badge counting rows
 * nobody can see, over a line saying how many sessions are hidden directly
 * above a tree saying how many nodes are.
 *
 * Nothing above a fleet: with no `MachineState` there is no option to offer,
 * no count to draw and nothing to narrow, so the row is not drawn at all
 * rather than drawn inert over "waiting for the hub".
 *
 * The nav is whatever `destinations.ts` says can honestly be reached. Graphs
 * and Library are named in the mockups and built by nobody yet, so they are
 * not drawn at all.
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
  readonly scheme: Scheme;
  /**
   * The clock the column is read against, injected so a test can pin an age.
   * Read once per render and handed to both of the things below that measure
   * one -- the row's age window and the rows' ages -- because two readings of
   * `Date.now` in one render are two answers to how old a session is.
   */
  readonly now?: () => number;
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
  scheme,
  now = Date.now,
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
  return (
    <Stack gap={10} p={10} style={{ height: '100%', minHeight: 0 }}>
      <MachineSelector state={state} chosen={machine} onPick={onPickMachine} scheme={scheme} />

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

      {state === null ? null : (
        <SidebarFilter
          state={state}
          filters={filters}
          machine={machine}
          label={projects ? 'Filter tree' : 'Filter sessions'}
          text={projects ? treeFilter : held.search}
          onText={(text) => {
            if (projects) setTreeFilter(text);
            else filters.set({ search: text });
          }}
          popover={!projects}
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
            filters={filters}
            machine={machine}
            scheme={scheme}
            now={() => moment}
          />
        )}
      </Box>

      <Stack
        component="nav"
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
    </Stack>
  );
}

/** A control hands back a string, and a string is a claim. */
function readTab(value: string): SidebarTab {
  return value === 'sessions' ? 'sessions' : 'projects';
}
