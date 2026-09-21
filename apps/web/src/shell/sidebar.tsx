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
 * Under the tabs is the filter row both mockups draw (6a, 6b, 7a), and it is
 * one row over two tabs rather than one per tab. What the box narrows is the
 * tab's: the tree's letters are held here, because the panel under them is
 * unmounted by a tab switch and a filter that emptied itself on the way back
 * would be a box that forgets; the sessions' letters are the `search` field of
 * the narrowings the popover writes and the cards in the content region read,
 * which is the whole reason that store exists. The popover is the sessions'
 * either way -- on the Projects tab it is narrowing the cards beside the tree
 * rather than the tree, and those are on screen, so its badge is still
 * counting something a person can see.
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
  readonly scheme: Scheme;
}

export function Sidebar({
  store,
  state,
  layout,
  catalogue,
  machine,
  onPickMachine,
  destination,
  scheme,
}: SidebarProps): JSX.Element {
  const [tab, setTab] = useState<SidebarTab>('projects');
  // The tree's letters, held by the sidebar rather than by the panel because
  // the box is drawn out here and outlives the tab that mounts the panel.
  const [treeFilter, setTreeFilter] = useState('');
  const filters = appSessionFiltersStore(store);
  const held = useSyncExternalStore(filters.subscribe, filters.getSnapshot);
  const projects = tab === 'projects';
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
          scheme={scheme}
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
          <SidebarSessions state={state} filters={filters} machine={machine} scheme={scheme} />
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
