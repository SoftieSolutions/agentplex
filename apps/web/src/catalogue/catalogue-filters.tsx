import { useSyncExternalStore, type JSX, type ReactNode } from 'react';
import type {
  CatalogueGroupBy,
  CatalogueSortKey,
  MachineState,
  SortDirection,
} from '@agentplex/protocol';
import { Button, Group, Select, Stack } from '../ui/components.js';
import { FilterPopover, FilterSection, FilterSummary } from '../ui/filter-popover.js';
import type { Scheme } from '../ui/tokens.js';
import {
  catalogueNarrowingCount,
  filterOptions,
  withFilter,
  withGroupBy,
  withoutNarrowings,
  withSort,
  type CatalogueShape,
  type FilterOption,
} from './catalogue-model.js';
import type { CatalogueStore } from './catalogue-store.js';

/**
 * The Projects reading's filter row: the box somebody types the tree's letters
 * into, and beside it the popover holding everything else the catalogue query
 * can be turned by -- the sort and its direction, the grouping in the list
 * view, and the provider and status narrowings.
 *
 * The box is the caller's, because who holds the letters differs: the sidebar
 * holds them across a tab switch, and the phone's Projects destination holds
 * its own. Everything in the popover is a field of the query, written through
 * `reshape` and read back off the store's snapshot, so a control here is the
 * question and never a second copy of it.
 *
 * The badge counts the shape's narrowings whether or not the popover draws a
 * section for them (`catalogueNarrowingCount` argues why), and the sections
 * are drawn for as long as the shape holds a value, so nothing counted is out
 * of reach. The line under the row says how many and no more: there is no
 * hidden count, because `pages.total` is already the hub's answer to the
 * narrowed question, and the catalogue cannot say what a narrowing took away
 * without asking the hub the wider one too. The tree-letter box has its own
 * hidden note under the tree, which is the one count a client can state.
 *
 * It subscribes to the catalogue store only while mounted, which is while the
 * Projects reading is on screen: a store's first subscriber is what declares
 * the interest, so the Sessions tab, which does not mount this, carries none.
 *
 * No state and no effects. Whether the popover is open is `FilterPopover`'s.
 */
export interface CatalogueFiltersProps {
  readonly catalogue: CatalogueStore;
  /** The fleet, for the narrowings it offers; `null` before the hub answers. */
  readonly state: MachineState | null;
  readonly scheme: Scheme;
  /** The tree-letter box, drawn at the start of the row. */
  readonly box: ReactNode;
}

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

export function CatalogueFilters({
  catalogue,
  state,
  scheme,
  box,
}: CatalogueFiltersProps): JSX.Element {
  const { shape, pages, loading } = useSyncExternalStore(
    catalogue.subscribe,
    catalogue.getSnapshot,
  );
  const options = filterOptions(state);
  const providers = offeredOrHeld(options.providers, shape.filter.provider);
  const statuses = offeredOrHeld(options.statuses, shape.filter.status);
  const active = catalogueNarrowingCount(shape);
  // A number only once there is one to say: before the first answer, or while
  // the answer to a changed question is in flight, the total on hand belongs
  // to a question nobody is asking any more.
  const dismissLabel = pages.answered && !loading ? `Show ${String(pages.total)}` : 'Show';

  // Inside the body because every control below writes through this store.
  function reshape(next: CatalogueShape): void {
    catalogue.reshape(next, 'now');
  }

  function clear(): void {
    reshape(withoutNarrowings(shape));
  }

  return (
    <Stack gap={6}>
      <Group gap={6} wrap="nowrap" align="center">
        {box}
        <FilterPopover active={active} dismissLabel={dismissLabel} onClear={clear} scheme={scheme}>
          <FilterSection title="Sort by" scheme={scheme}>
            <Group gap={6} wrap="nowrap">
              <Select
                size="xs"
                aria-label="Sort by"
                data={[...SORT_KEYS]}
                value={shape.sort.key}
                onChange={(value) =>
                  reshape(withSort(shape, readSortKey(value), shape.sort.direction))
                }
                allowDeselect={false}
                style={{ flex: 1, minWidth: 0 }}
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
          </FilterSection>

          {/* Grouping is offered in the list view only. In a tree the
              containment is the grouping -- the hub labels the items and
              reorders nothing -- so a heading here would be a second
              arrangement over the one the user made, and the two would
              disagree about where a thing is. */}
          {shape.view === 'list' ? (
            <FilterSection title="Group by" scheme={scheme}>
              <Select
                size="xs"
                aria-label="Group by"
                data={[...GROUPINGS]}
                value={shape.groupBy}
                onChange={(value) => reshape(withGroupBy(shape, readGroupBy(value)))}
                allowDeselect={false}
              />
            </FilterSection>
          ) : null}

          {/* No machine section: the selector above the tabs is the one
              control for that, because the selection is one fact narrowing
              this query and the cards beside it at once. See `filterOptions`. */}
          {providers.length === 0 ? null : (
            <FilterSection title="Provider" scheme={scheme}>
              <Select
                size="xs"
                aria-label="Provider"
                placeholder="Any"
                data={[...providers]}
                value={shape.filter.provider ?? null}
                onChange={(value) => reshape(withFilter(shape, { field: 'provider', value }))}
                clearable
              />
            </FilterSection>
          )}

          {statuses.length === 0 ? null : (
            <FilterSection title="Status" scheme={scheme}>
              <Select
                size="xs"
                aria-label="Status"
                placeholder="Any"
                data={[...statuses]}
                value={shape.filter.status ?? null}
                onChange={(value) => reshape(withFilter(shape, { field: 'status', value }))}
                clearable
              />
            </FilterSection>
          )}
        </FilterPopover>
      </Group>

      <FilterSummary active={active} onClear={clear} scheme={scheme} />
    </Stack>
  );
}

/**
 * What a narrowing's select offers: the fleet's options, and the value the
 * shape holds when the fleet no longer offers it.
 *
 * `filterOptions` offers nothing below two choices, which is right for a
 * fresh pick and wrong for one already made: the shape would go on narrowing
 * and the badge counting while the section that could clear it was gone. So a
 * held value keeps its section drawn, and is offered by its own name.
 */
function offeredOrHeld(
  offered: readonly FilterOption[],
  held: string | undefined,
): readonly FilterOption[] {
  if (held === undefined || offered.some((option) => option.value === held)) return offered;
  return [...offered, { value: held, label: held }];
}

/**
 * A control hands back a string, and a string is a claim. Each of these is the
 * parser for one closed set the query frame names: an unreadable value keeps
 * what was there rather than putting a word the hub would refuse on the wire.
 */
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
