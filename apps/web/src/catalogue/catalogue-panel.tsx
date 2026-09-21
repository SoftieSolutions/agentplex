import { useState, useSyncExternalStore, type JSX } from 'react';
import type {
  CatalogueGroupBy,
  CatalogueSortKey,
  CatalogueView,
  Layout,
  MachineState,
  NodeId,
  SortDirection,
} from '@agentplex/protocol';
import { appLayoutStore } from '../layout/app-layout.js';
import type { LayoutStore } from '../layout/layout-store.js';
import type { HubStore } from '../store/hub-store.js';
import { AbsentSessions } from '../tree/absent-sessions.js';
import { NodeMenu } from '../tree/node-menu.js';
import {
  Box,
  Button,
  CloseButton,
  Group,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import {
  countLabel,
  filterNote,
  filterOptions,
  filterTree,
  isNarrowed,
  rowsFor,
  sessionCounts,
  shortMachinesOf,
  withFilter,
  withGroupBy,
  withSort,
  withView,
  type CatalogueShape,
} from './catalogue-model.js';
import { CatalogueRowView } from './catalogue-row.js';
import { createCatalogueStore, type CatalogueStore } from './catalogue-store.js';

/**
 * The catalogue: the tree somebody arranged, and the flat list over the same
 * query, drawn from `catalogue-query` and nothing else.
 *
 * A sidebar at desk widths and a tab at phone widths -- the screen that holds
 * it decides which, because that is a fact about the screen and not about the
 * catalogue. Everything the user turns here maps onto a field of the query
 * frame: the view, the grouping, the sort key and direction, and the four
 * narrowings the filter names. Nothing is sorted or grouped in this file; the
 * hub answers one order and this draws it, which is the whole point of
 * decision 4.
 *
 * The one thing drawn out of less than the hub answered is the tree filter,
 * and it is a second control rather than a second opinion: the search box asks
 * the hub a narrower question over the whole catalogue, and the filter box
 * narrows the page already on screen so that it can say, underneath, how many
 * nodes that took away. `filterTree` in the model argues the division.
 *
 * No effects. The query goes out because something subscribed -- the store's
 * first subscriber is what asks -- and a change to the catalogue comes back
 * through the hub store's own re-issue. The two stores this reads are external
 * stores and are read through `useSyncExternalStore`, which is where a
 * subscription belongs.
 *
 * Virtualised rows were on the ticket and are deliberately absent: a page is
 * bounded by `CATALOGUE_PAGE_LIMIT` and the rows on screen are bounded by how
 * many pages the person asked for, so the DOM grows by an act rather than by
 * the size of the catalogue. The argument is written out where the constant is.
 */
export interface CataloguePanelProps {
  readonly store: HubStore;
  /** The fleet, for the narrowings it offers and the machines it names. */
  readonly state: MachineState | null;
  /** The tree, for what a move may offer and what is not in it. */
  readonly layout: Layout | null;
  readonly scheme: Scheme;
  /** Injected by tests and by a screen that already holds one. */
  readonly catalogue?: CatalogueStore;
  readonly layoutStore?: LayoutStore;
  /**
   * The letters to narrow by, when a row above this panel holds them.
   *
   * The sidebar's filter row is drawn over whichever tab is showing and is the
   * box for both of them (AGX-255), so on the Projects tab the letters are the
   * row's and this panel draws no box of its own: two boxes over one tree are
   * two answers to the question of what is typed. Absent is the other
   * mounting, the phone's Projects destination, where nothing above the panel
   * draws a row and the panel holds the letters itself.
   */
  readonly filter?: string;
}

const VIEWS: readonly { readonly value: CatalogueView; readonly label: string }[] = [
  { value: 'tree', label: 'Tree' },
  { value: 'list', label: 'List' },
];

const GROUPINGS: readonly { readonly value: CatalogueGroupBy; readonly label: string }[] = [
  { value: 'none', label: 'No grouping' },
  { value: 'server', label: 'Group by machine' },
  { value: 'project', label: 'Group by project' },
];

const SORT_KEYS: readonly { readonly value: CatalogueSortKey; readonly label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'updatedAt', label: 'Last updated' },
  { value: 'server', label: 'Machine' },
];

/** Everything with a screen's lifetime, built once per mount. */
interface HeldStores {
  readonly catalogue: CatalogueStore;
  readonly arrangement: LayoutStore;
}

function buildHeldStores(
  hub: HubStore,
  catalogue: CatalogueStore | undefined,
  layoutStore: LayoutStore | undefined,
): HeldStores {
  return {
    catalogue: catalogue ?? createCatalogueStore({ hub }),
    // The app's one layout store: what is collapsed here is stored in the same
    // blob as the pane arrangement, and one writer is what keeps the two from
    // writing stale copies of each other. See `layout/app-layout.ts`.
    arrangement: layoutStore ?? appLayoutStore(hub),
  };
}

export function CataloguePanel({
  store,
  state,
  layout,
  scheme,
  catalogue,
  layoutStore,
  filter,
}: CataloguePanelProps): JSX.Element {
  const [held] = useState<HeldStores>(() => buildHeldStores(store, catalogue, layoutStore));
  const snapshot = useSyncExternalStore(held.catalogue.subscribe, held.catalogue.getSnapshot);
  const arrangement = useSyncExternalStore(
    held.arrangement.subscribe,
    held.arrangement.getSnapshot,
  );

  // What the tree filter box holds when this panel is the one drawing it. A
  // screen's fact and not the query's: it narrows what is drawn out of the
  // page already held rather than asking the hub a narrower question, which is
  // what lets the footer say how many nodes it took away. `filterTree` argues
  // the division. Held either way, and read only where `filter` is absent, so
  // that whose letters these are is one condition rather than two hooks.
  const [ownFilter, setOwnFilter] = useState('');
  const letters = filter ?? ownFilter;

  const { shape, pages } = snapshot;
  // Both views, not the tree alone. The rule the tree view's exclusivity was
  // built on -- that a list has no containment for the filter to keep a hit
  // inside -- is a rule about what `filterTree` does with the ancestors, and
  // the hub flattens containers out of the list view entirely, so there are
  // none to keep and the same call is a plain match on the name drawn on the
  // row. The box above this panel is drawn over whichever view is showing,
  // and a control that sits there doing nothing is worse than no control.
  const filtering = letters.trim() !== '';
  const filtered = filterTree(pages.items, letters);
  // What a filter does to the collapsed folders and to the disclosures is
  // `rowsFor`'s rule and is argued on `RowOptions.filtering`: it lives there
  // rather than here so that a test can reach it without a DOM.
  const rows = rowsFor(filtered.items, {
    view: shape.view,
    collapsed: new Set(arrangement.collapsed),
    filtering,
  });
  const hiding = filtering ? filterNote(filtered, pages.nextCursor === null) : null;
  const counts = sessionCounts(pages);
  const machines = shortMachinesOf(state);
  const options = filterOptions(state);
  const muted = colorForRole('textMuted', scheme);

  function reshape(next: CatalogueShape, when: 'now' | 'settled' = 'now'): void {
    held.catalogue.reshape(next, when);
  }

  return (
    <Stack gap={8} style={{ minWidth: 0 }}>
      <Group justify="space-between" align="center" gap={8}>
        <Title order={2} fz={13} c={muted}>
          Projects
        </Title>
        <Text fz={11} c={muted}>
          {pages.answered ? countLabel(pages) : 'asking the hub'}
        </Text>
      </Group>

      <SegmentedControl
        size="xs"
        fullWidth
        aria-label="View"
        value={shape.view}
        onChange={(value) => reshape(withView(shape, readView(value)))}
        data={[...VIEWS]}
      />

      <Group gap={6} wrap="wrap">
        <Select
          size="xs"
          aria-label="Sort by"
          data={[...SORT_KEYS]}
          value={shape.sort.key}
          onChange={(value) => reshape(withSort(shape, readSortKey(value), shape.sort.direction))}
          allowDeselect={false}
          style={{ flex: 1, minWidth: 120 }}
        />
        <Button
          size="compact-xs"
          variant="default"
          aria-label={`Sorted ${shape.sort.direction === 'asc' ? 'ascending' : 'descending'}`}
          onClick={() => reshape(withSort(shape, shape.sort.key, flip(shape.sort.direction)))}
        >
          {shape.sort.direction === 'asc' ? 'A first' : 'Z first'}
        </Button>
      </Group>

      {/* Grouping is offered in the list view only. In a tree the containment
          is the grouping -- the hub labels the items and reorders nothing --
          so a heading here would be a second arrangement over the one the user
          made, and the two would disagree about where a thing is. */}
      {shape.view === 'list' ? (
        <Select
          size="xs"
          aria-label="Group by"
          data={[...GROUPINGS]}
          value={shape.groupBy}
          onChange={(value) => reshape(withGroupBy(shape, readGroupBy(value)))}
          allowDeselect={false}
        />
      ) : null}

      {/* No machine control: the selector above the tabs is the one control
          for that, because the selection is one fact narrowing this query and
          the cards beside it at once. See `filterOptions`. */}
      {options.providers.length === 0 ? null : (
        <Select
          size="xs"
          aria-label="Provider"
          placeholder="Any provider"
          data={[...options.providers]}
          value={shape.filter.provider ?? null}
          onChange={(value) => reshape(withFilter(shape, { field: 'provider', value }))}
          clearable
        />
      )}
      {options.statuses.length === 0 ? null : (
        <Select
          size="xs"
          aria-label="Status"
          placeholder="Any status"
          data={[...options.statuses]}
          value={shape.filter.status ?? null}
          onChange={(value) => reshape(withFilter(shape, { field: 'status', value }))}
          clearable
        />
      )}
      <TextInput
        size="xs"
        aria-label="Search the catalogue"
        placeholder="Search the catalogue"
        value={shape.filter.search ?? ''}
        onChange={(event) =>
          // The box holds what was typed at once; the query waits for the
          // burst to settle. A frame per keystroke would have the hub sorting
          // its catalogue four times for one word.
          reshape(
            withFilter(shape, { field: 'search', value: event.currentTarget.value }),
            'settled',
          )
        }
      />

      {snapshot.notice === null ? null : (
        <Text fz={11} c={muted}>
          {snapshot.notice}
        </Text>
      )}
      {snapshot.problem === null ? null : (
        <Text fz={11} c={muted}>
          {snapshot.problem}
        </Text>
      )}

      {/* The catalogue's own filter, directly over the rows it narrows, and a
          separate control from the search box above on purpose. The search
          asks the hub a narrower question -- over the whole catalogue, and
          over working directories, session ids and machine names as well as
          names -- and answers with a page. This narrows the page already on
          screen, by the name drawn on the row, at the speed of a keystroke,
          and it is the one that can say what it took away.

          Drawn only where nobody above the panel is drawing one: see
          `filter`. */}
      {filter === undefined ? (
        <TextInput
          size="xs"
          aria-label="Filter tree"
          placeholder="Filter tree"
          value={ownFilter}
          onChange={(event) => setOwnFilter(event.currentTarget.value)}
          rightSectionPointerEvents="auto"
          rightSection={
            ownFilter === '' ? null : (
              <CloseButton
                size="sm"
                aria-label="Clear the tree filter"
                onClick={() => setOwnFilter('')}
              />
            )
          }
        />
      ) : null}

      <Stack gap={2}>
        {rows.map((row) =>
          row.kind === 'group' ? (
            <Text
              key={row.key}
              fz={11}
              fw={600}
              c={row.group.unfiled ? colorForRole('textFaint', scheme) : muted}
              style={{ paddingTop: 6 }}
            >
              {row.group.label}
            </Text>
          ) : (
            <CatalogueRowView
              key={row.key}
              row={row}
              scheme={scheme}
              machines={machines}
              sessions={counts}
              onToggle={(nodeId: NodeId) => held.arrangement.toggleCollapsed(nodeId)}
              actions={
                <NodeMenu
                  store={store}
                  nodeId={row.item.id}
                  name={row.item.displayName}
                  layout={layout}
                  anchor={row.item.anchor}
                  scheme={scheme}
                />
              }
            />
          ),
        )}
      </Stack>

      {/* What the filter is hiding, under the tree it is hiding it from. The
          substance of AGX-135: a tree that silently omits branches lets
          somebody conclude a thing is not there when it is only hidden, so
          the count of what went is on screen beside what stayed. */}
      {hiding === null ? null : (
        <Text fz={11} c={muted}>
          {hiding}
        </Text>
      )}

      {/* Not while the filter is speaking for the empty tree: the catalogue
          does hold things, and two sentences disagreeing about why the rows
          are gone is worse than either. */}
      {rows.length === 0 && pages.answered && hiding === null ? (
        <Text fz={12} c={muted}>
          {isNarrowed(shape)
            ? 'nothing in the catalogue matches this'
            : 'nothing in the catalogue yet'}
        </Text>
      ) : null}

      {pages.nextCursor === null ? null : (
        <Box>
          <Button
            size="compact-xs"
            variant="default"
            loading={snapshot.loading}
            onClick={() => held.catalogue.loadMore()}
          >
            Load more
          </Button>
        </Box>
      )}

      {/* Where the sessions the tree does not hold moved to. They belong in
          this view rather than beside the cards: the question "why is this not
          in my tree" is a question about the tree.

          Not while the tree is filtered, though. These are by definition not
          in the tree, so the filter neither narrows them nor counts them, and
          a list left standing under "nothing in the tree matches this filter"
          reads as the rows that survived it. Clearing the box brings it
          straight back, and nothing here is a session that has gone anywhere:
          it is a section of this panel, not a row of the tree. */}
      {filtering ? null : (
        <AbsentSessions store={store} state={state} layout={layout} scheme={scheme} />
      )}
    </Stack>
  );
}

/**
 * A control hands back a string, and a string is a claim. Each of these is the
 * parser for one closed set the query frame names: an unreadable value keeps
 * what was there rather than putting a word the hub would refuse on the wire.
 */
function readView(value: string): CatalogueView {
  return value === 'list' ? 'list' : 'tree';
}

function readGroupBy(value: string | null): CatalogueGroupBy {
  if (value === 'server' || value === 'project') return value;
  return 'none';
}

function readSortKey(value: string | null): CatalogueSortKey {
  if (value === 'updatedAt' || value === 'server') return value;
  return 'name';
}

function flip(direction: SortDirection): SortDirection {
  return direction === 'asc' ? 'desc' : 'asc';
}
