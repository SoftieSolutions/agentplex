import { useEffect, useState, useSyncExternalStore, type JSX } from 'react';
import type { CatalogueView, Layout, MachineState, NodeId } from '@agentplex/protocol';
import { appLayoutStore } from '../layout/app-layout.js';
import type { LayoutStore } from '../layout/layout-store.js';
import type { HubStore } from '../store/hub-store.js';
import { AbsentSessions } from '../tree/absent-sessions.js';
import { PROJECT_KIND } from '../tree/node-kinds.js';
import { NodeMenu } from '../tree/node-menu.js';
import {
  Box,
  Button,
  CloseButton,
  Group,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
} from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { CatalogueFilters } from './catalogue-filters.js';
import {
  closedProjects,
  countLabel,
  filterNote,
  filterTree,
  isNarrowed,
  rowsFor,
  sessionCounts,
  shortMachinesOf,
  withView,
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
 * frame: the view on the panel itself, and the grouping, the sort key and
 * direction and the provider and status narrowings in the popover beside the
 * filter box (`CatalogueFilters`). Nothing is sorted or grouped in this file;
 * the hub answers one order and this draws it, which is the whole point of
 * decision 4.
 *
 * The one thing drawn out of less than the hub answered is the tree filter:
 * the box narrows the page already on screen so that it can say, underneath,
 * how many nodes that took away. `filterTree` in the model argues it. There is
 * no catalogue search box beside it any more -- asking the hub a narrower
 * question over the whole catalogue by name is what the palette does, and two
 * boxes over one tree were two answers to what somebody meant by typing.
 *
 * One effect, and only one. The query goes out because something subscribed --
 * the store's first subscriber is what asks -- and a change to the catalogue
 * comes back through the hub store's own re-issue. The two stores this reads
 * are external stores and are read through `useSyncExternalStore`, which is
 * where a subscription belongs. The effect is the open projects reaching the
 * catalogue question, and its own comment says why it cannot be anything else.
 *
 * The Projects tab draws projects only at the top, each closed until opened.
 * Which are open is the layout store's (`expanded`, saved in the layout blob
 * so it survives a reload), and the hub, not this panel, leaves a closed
 * project's contents out of the answer -- `total` and the cursor are counts
 * over the answer, and rows trimmed here would disagree with both.
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
   * two answers to the question of what is typed. The popover trigger goes
   * with the box, since the sidebar's row draws the catalogue's beside its
   * own. Absent is the other mounting, the phone's Projects destination, where
   * nothing above the panel draws a row and the panel holds the letters and
   * draws the trigger itself.
   */
  readonly filter?: string;
}

/**
 * Every project closed, for as long as the layout has not answered.
 *
 * One array for the module's life, because the effect below compares by
 * reference: a fresh `[]` each render would ask the hub again every render.
 */
const NOTHING_OPEN: readonly NodeId[] = [];

const VIEWS: readonly { readonly value: CatalogueView; readonly label: string }[] = [
  { value: 'tree', label: 'Tree' },
  { value: 'list', label: 'List' },
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

  // Which projects the question draws open. The tree whole while the box holds
  // letters, so a hit inside a project nobody opened is in the answer the box
  // narrows; nothing open until the layout has answered, rather than a guess
  // that the stored arrangement would then overturn with a second ask.
  const wanted = filtering ? null : arrangement.loaded ? arrangement.expanded : NOTHING_OPEN;
  useEffect(() => {
    // An effect because it syncs an external store from props plus another
    // external store: the open set lives in the persisted layout store, and the
    // filter letters in Sidebar's state or in this panel's own when the phone
    // mounts it. Nothing render-time can write one store from another without
    // notifying subscribers during render. `openProjects` asks nothing when the
    // set has not changed, so a re-run over the same ids costs no frame.
    held.catalogue.openProjects(wanted);
  }, [held, wanted]);

  const filtered = filterTree(pages.items, letters);
  // What a filter does to the collapsed folders and to the disclosures is
  // `rowsFor`'s rule and is argued on `RowOptions.filtering`: it lives there
  // rather than here so that a test can reach it without a DOM.
  const rows = rowsFor(filtered.items, {
    view: shape.view,
    collapsed: new Set(arrangement.collapsed),
    expanded: new Set(arrangement.expanded),
    filtering,
  });
  const hiding = filtering ? filterNote(filtered, pages.nextCursor === null) : null;
  const counts = sessionCounts(pages, closedProjects(rows));
  const machines = shortMachinesOf(state);
  const muted = colorForRole('textMuted', scheme);

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
        onChange={(value) => held.catalogue.reshape(withView(shape, readView(value)), 'now')}
        data={[...VIEWS]}
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

      {/* The catalogue's own filter, directly over the rows it narrows, and
          the popover holding the rest of the question beside it. The box
          narrows the page already on screen, by the name drawn on the row, at
          the speed of a keystroke, and it is the one that can say what it
          took away; the popover's controls are fields of the query the hub
          answers.

          Drawn only where nobody above the panel is drawing a row, which is
          the phone's Projects destination: see `filter`. The store handed down
          is the held one, because the phone mounts this panel with no
          `catalogue` prop and builds its own. */}
      {filter === undefined ? (
        <CatalogueFilters
          catalogue={held.catalogue}
          state={state}
          scheme={scheme}
          box={
            <TextInput
              size="xs"
              aria-label="Filter tree"
              placeholder="Filter tree"
              value={ownFilter}
              onChange={(event) => setOwnFilter(event.currentTarget.value)}
              style={{ flex: 1, minWidth: 0 }}
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
              onToggle={(nodeId: NodeId) => toggle(held.arrangement, row.item.kind, nodeId)}
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
 * A disclosure's click, by what the row is: a project is opened, everything
 * else is closed. Two lists because the two defaults are opposite -- see
 * `layout/workspace.ts` -- and a project written into the closed list would be
 * a note nothing reads.
 */
function toggle(arrangement: LayoutStore, kind: string, nodeId: NodeId): void {
  if (kind === PROJECT_KIND) arrangement.toggleExpanded(nodeId);
  else arrangement.toggleCollapsed(nodeId);
}

/**
 * A control hands back a string, and a string is a claim. This is the parser
 * for the closed set the query frame names for a view: an unreadable value
 * keeps the default rather than putting a word the hub would refuse on the
 * wire. The popover's parsers are in `catalogue-filters.tsx`.
 */
function readView(value: string): CatalogueView {
  return value === 'list' ? 'list' : 'tree';
}
