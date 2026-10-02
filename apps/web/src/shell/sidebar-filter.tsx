import { useSyncExternalStore, type JSX } from 'react';
import { assertNever, type MachineState, type ServerRegistrationId } from '@agentplex/protocol';
import { CatalogueFilters } from '../catalogue/catalogue-filters.js';
import type { CatalogueStore } from '../catalogue/catalogue-store.js';
import type { SessionFiltersStore } from '../sessions/session-filters-store.js';
import {
  activeFilterCount,
  chipOptions,
  effectiveFilters,
  hiddenCount,
  listSessions,
  machineOptions,
  projectOptions,
  providerOptions,
  storeOptions,
  UPDATED_WITHIN_ORDER,
  visibleSessions,
} from '../sessions/session-list-model.js';
import { Group, Select, Stack, TextInput } from '../ui/components.js';
import { FilterPopover, FilterSection, FilterSummary, FilterToggle } from '../ui/filter-popover.js';
import type { Scheme } from '../ui/tokens.js';

/**
 * The row both sidebar tabs are drawn with (mockups 6a, 6b, 7a): a box that
 * narrows whatever is below it, and beside it the popover holding every other
 * narrowing of that same reading, a badge counting them and a line saying what
 * they did.
 *
 * It knows nothing about which tab it sits over, or whether it is over a tab
 * at all: it is the row in the sidebar's two forms, the row the phone form of
 * the session list draws for itself, and through `CatalogueFilters` the row
 * the phone's Projects destination draws. The box is the caller's -- its name
 * and what its text narrows arrive as props, because in one place the letters
 * narrow the tree and in the others the session list.
 *
 * The popover carries whichever reading's narrowings are under the row, and
 * the caller says which (`popover`). Over the sessions it is the sessions'
 * narrowings; over the catalogue tree it is the catalogue query's sort and
 * narrowings. Mockup 6a draws the Projects tab with the box alone, and this
 * departs from it on purpose: the catalogue's sort and its provider and status
 * narrowings had nowhere to live but a stack of selects above the tree, and a
 * popover beside the box is the place the Sessions tab already taught. What
 * the mockup was right about is that the sessions' popover does not belong
 * there -- every narrowing in it narrows sessions, and with a session or a
 * document open in the content region they would be counted on a badge over
 * rows nobody on that tab can see. So each reading counts its own and never
 * the other's.
 *
 * A switch and no hooks: each arm is a component with hooks of its own, so a
 * tab switch mounts one and unmounts the other rather than one body calling a
 * different set of hooks on the next render.
 */
interface SidebarFilterBase {
  /** What the box is called, which is also what it says it narrows. */
  readonly label: string;
  /** What is typed in the box, held by whoever owns the thing it narrows. */
  readonly text: string;
  readonly onText: (text: string) => void;
  readonly scheme: Scheme;
}

/** The sessions' narrowings, over the session list or the sidebar's rows. */
interface SessionsPopover {
  readonly popover: 'sessions';
  /** The fleet the options, the counts and the hidden line are read off. */
  readonly state: MachineState;
  /** The page's narrowings, which the session list reads at the same moment. */
  readonly filters: SessionFiltersStore;
  /**
   * The machine the shell is narrowed to, or `null` for all of them. Read and
   * never written: the selector above this row is that fact's one writer, and
   * composing it in here is what keeps the hidden count honest -- sessions on
   * a machine somebody is not looking at are not rows this row is hiding.
   */
  readonly machine: ServerRegistrationId | null;
  /** The clock the age narrowing is read against, injected so a test can fix it. */
  readonly now?: () => number;
}

/** The catalogue query's sort and narrowings, over the tree. */
interface CataloguePopover {
  readonly popover: 'catalogue';
  /** The fleet, for the narrowings it offers; `null` before the hub answers. */
  readonly state: MachineState | null;
  /** The catalogue question, which the panel under the row reads as well. */
  readonly catalogue: CatalogueStore;
}

export type SidebarFilterProps = SidebarFilterBase & (SessionsPopover | CataloguePopover);

export function SidebarFilter(props: SidebarFilterProps): JSX.Element {
  switch (props.popover) {
    case 'sessions':
      return <SessionsFilterRow {...props} />;
    case 'catalogue':
      return (
        <CatalogueFilters
          catalogue={props.catalogue}
          state={props.state}
          scheme={props.scheme}
          box={<FilterBox label={props.label} text={props.text} onText={props.onText} />}
        />
      );
    default:
      return assertNever(props, 'sidebar filter popover');
  }
}

interface FilterBoxProps {
  readonly label: string;
  readonly text: string;
  readonly onText: (text: string) => void;
}

function FilterBox({ label, text, onText }: FilterBoxProps): JSX.Element {
  return (
    <TextInput
      size="xs"
      aria-label={label}
      placeholder={label}
      value={text}
      onChange={(event) => onText(event.currentTarget.value)}
      style={{ flex: 1, minWidth: 0 }}
    />
  );
}

/**
 * The sessions' row: the box, and the popover over the session narrowings.
 *
 * Everything the popover decides comes from `session-list-model.ts`, read
 * through `effectiveFilters` so that a choice whose option has left the fleet
 * narrows nothing and is not counted on the badge beside a section that is no
 * longer drawn. A section is drawn only where the snapshot offers a choice:
 * the option lists come back empty below two options, which is the same
 * instruction `chipCounts` has always given the chip row. `Blocked` and `Done`
 * are in the mockup and are not here -- nothing reports a blocked agent and
 * nothing retains a finished session, so either pill would be a control that
 * narrows to nothing at every moment.
 *
 * The Machine section is a narrowing of this list and not the machine
 * selector above it. The selector chooses which server the app is looking at,
 * the catalogue included; this one narrows these sessions, is counted on the
 * badge, and is reset by Clear. `SessionListFilters` has the argument.
 *
 * The narrowings arrive through `useSyncExternalStore`; whether the popover is
 * open is `FilterPopover`'s. No effects.
 */
function SessionsFilterRow({
  state,
  filters,
  machine,
  label,
  text,
  onText,
  scheme,
  now = Date.now,
}: SidebarFilterBase & SessionsPopover): JSX.Element {
  const held = useSyncExternalStore(filters.subscribe, filters.getSnapshot);

  const moment = now();
  const items = listSessions(state);
  const effective = effectiveFilters(state, { ...held, server: machine }, moment);
  const active = activeFilterCount(effective);
  const hidden = hiddenCount(state, effective, moment);
  const showing = visibleSessions(state, effective, moment).length;

  const chips = chipOptions(state, effective, moment);
  const machines = machineOptions(state, items);
  const projects = projectOptions(items);
  const stores = storeOptions(state);
  const providers = providerOptions(items);

  return (
    <Stack gap={6}>
      <Group gap={6} wrap="nowrap" align="center">
        <FilterBox label={label} text={text} onText={onText} />
        <FilterPopover
          active={active}
          dismissLabel={`Show ${String(showing)}`}
          onClear={() => filters.clear()}
          scheme={scheme}
        >
          {chips.length === 0 ? null : (
            <FilterSection title="Status" scheme={scheme}>
              <Group gap={4}>
                {chips.map((entry) => (
                  <FilterToggle
                    key={entry.chip}
                    label={entry.label}
                    selected={effective.chip === entry.chip}
                    // Pressing the pill that is already on takes it off: one
                    // status narrows at a time, and the only other way out of
                    // a chosen pill would be Clear all, which takes the other
                    // five narrowings with it.
                    onPick={() =>
                      filters.set({ chip: effective.chip === entry.chip ? null : entry.chip })
                    }
                    radius={12}
                    scheme={scheme}
                  />
                ))}
              </Group>
            </FilterSection>
          )}

          {machines.length === 0 ? null : (
            <FilterSection title="Machine" scheme={scheme}>
              <Select
                size="xs"
                aria-label="Machine"
                placeholder="Any"
                data={machines.map((option) => ({ value: option.id, label: option.label }))}
                value={effective.machine}
                onChange={(value) => filters.set({ machine: value })}
                clearable
              />
            </FilterSection>
          )}

          {projects.length === 0 ? null : (
            <FilterSection title="Project" scheme={scheme}>
              <Select
                size="xs"
                aria-label="Project"
                placeholder="Any"
                data={[...projects]}
                value={effective.project}
                onChange={(value) => filters.set({ project: value })}
                clearable
              />
            </FilterSection>
          )}

          {stores.length === 0 ? null : (
            <FilterSection title="Store" scheme={scheme}>
              <Select
                size="xs"
                aria-label="Store"
                placeholder="Any"
                data={[...stores]}
                value={effective.storeId}
                onChange={(value) => filters.set({ storeId: value })}
                clearable
              />
            </FilterSection>
          )}

          {providers.length === 0 ? null : (
            <FilterSection title="Provider" scheme={scheme}>
              <Select
                size="xs"
                aria-label="Provider"
                placeholder="Any"
                data={[...providers]}
                value={effective.provider}
                onChange={(value) => filters.set({ provider: value })}
                clearable
              />
            </FilterSection>
          )}

          {/* Always drawn: the four buttons are fixed and no fleet takes one
              away, which is the rule `effectiveFilters` states by leaving this
              field out of its vanishing check. */}
          <FilterSection title="Last updated" scheme={scheme}>
            <Group gap={3} wrap="nowrap">
              {UPDATED_WITHIN_ORDER.map((within) => (
                <FilterToggle
                  key={within}
                  label={within}
                  selected={effective.updatedWithin === within}
                  onPick={() => filters.set({ updatedWithin: within })}
                  radius={5}
                  grow
                  scheme={scheme}
                />
              ))}
              <FilterToggle
                label="Any"
                selected={effective.updatedWithin === null}
                onPick={() => filters.set({ updatedWithin: null })}
                radius={5}
                grow
                scheme={scheme}
              />
            </Group>
          </FilterSection>
        </FilterPopover>
      </Group>

      <FilterSummary
        active={active}
        hidden={hidden}
        onClear={() => filters.clear()}
        scheme={scheme}
      />
    </Stack>
  );
}
