import { useState, useSyncExternalStore, type JSX, type ReactNode } from 'react';
import type { MachineState, ServerRegistrationId } from '@agentplex/protocol';
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
import {
  Box,
  Group,
  Popover,
  Select,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';

/**
 * The row both sidebar tabs are drawn with (mockups 6a, 6b, 7a): a box that
 * narrows whatever is below it, and beside it the popover holding every other
 * narrowing, a badge counting them and a line saying what they hid.
 *
 * It knows nothing about which tab it sits over, or whether it is over a tab
 * at all: it is the row in the sidebar's two forms and the row the phone form
 * of the session list draws for itself. The box is the caller's -- its name
 * and what its text narrows arrive as props, because in one place the letters
 * narrow the tree and in the others the session list.
 *
 * The popover is always the sessions', and is drawn only where the caller says
 * sessions are on screen (`popover`). Every narrowing in it narrows sessions,
 * so over the catalogue tree it would be a badge counting rows nobody on that
 * tab can see -- the tab is independent of the route, and with a session or a
 * document open the content region is not the list -- and its hidden count
 * would sit directly above the tree's own count of what the tree is hiding.
 * One prop rather than a second component, because everything else about the
 * row is the same row: mockup 6a draws the Projects tab with the box alone and
 * 6b draws the Sessions tab with the slider beside it.
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
 * `useState` holds one thing: whether the popover is open, which is nobody
 * else's business. The narrowings arrive through `useSyncExternalStore`. No
 * effects.
 */
export interface SidebarFilterProps {
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
  /** What the box is called, which is also what it says it narrows. */
  readonly label: string;
  /** What is typed in the box, held by whoever owns the thing it narrows. */
  readonly text: string;
  readonly onText: (text: string) => void;
  /**
   * Whether the sessions' narrowings are drawn beside the box: the popover,
   * the badge counting them and the line saying what they hid. False where the
   * sessions are not what is under the row, which is the Projects tab.
   */
  readonly popover: boolean;
  readonly scheme: Scheme;
  /** The clock the age narrowing is read against, injected so a test can fix it. */
  readonly now?: () => number;
}

export function SidebarFilter({
  state,
  filters,
  machine,
  label,
  text,
  onText,
  popover,
  scheme,
  now = Date.now,
}: SidebarFilterProps): JSX.Element {
  const held = useSyncExternalStore(filters.subscribe, filters.getSnapshot);
  const [opened, setOpened] = useState(false);

  const box = (
    <TextInput
      size="xs"
      aria-label={label}
      placeholder={label}
      value={text}
      onChange={(event) => onText(event.currentTarget.value)}
      style={{ flex: 1, minWidth: 0 }}
    />
  );

  // Every hook is above this line, so the row with nothing beside the box is
  // an early return rather than a tree of conditions: none of what follows --
  // the option lists, the counts, the windows -- is worth computing over a
  // reading the popover does not narrow.
  if (!popover) {
    return (
      <Group gap={6} wrap="nowrap" align="center">
        {box}
      </Group>
    );
  }

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

  const muted = colorForRole('textMuted', scheme);

  return (
    <Stack gap={6}>
      <Group gap={6} wrap="nowrap" align="center">
        {box}
        {/* `trapFocus` and `returnFocus` are both off by default in Mantine
            9.6.0, and with `withinPortal` the dropdown is drawn at the end of
            the body: opening it would leave the focus on the trigger, so Tab
            would walk out of the page rather than into the popover and Escape
            would reach nothing -- the dismissal is a capture handler on the
            dropdown. Since these five narrowings have no other surface at this
            width, an unreachable popover is five controls a keyboard cannot
            operate. Trapping the focus also puts Escape under it, and
            returning it leaves somebody where they pressed. */}
        <Popover
          opened={opened}
          onChange={setOpened}
          position="bottom-end"
          withinPortal
          trapFocus
          returnFocus
          shadow="md"
          width={250}
        >
          <Popover.Target>
            {/* Named in words rather than by its glyph: the app has no icon
                set, and a button whose accessible name is a picture is a
                button nobody can ask for. */}
            <UnstyledButton
              aria-label="Filters"
              onClick={() => setOpened(!opened)}
              style={{
                position: 'relative',
                width: 32,
                height: 30,
                display: 'grid',
                placeItems: 'center',
                borderRadius: 7,
                border: `1px solid ${colorForRole(active === 0 ? 'border' : 'accent', scheme)}`,
                background: colorForRole('raised', scheme),
                color: colorForRole('text', scheme),
              }}
            >
              <SlidersGlyph />
              {active === 0 ? null : (
                // `aria-hidden` for the reason the tone dots are: the badge is
                // a second rendering of the line below the row, which is drawn
                // whenever the badge is and says the same number in words.
                <Text
                  component="span"
                  aria-hidden
                  ff="monospace"
                  fz={9}
                  fw={600}
                  style={{
                    position: 'absolute',
                    top: -6,
                    right: -6,
                    padding: '1px 5px',
                    borderRadius: 8,
                    background: colorForRole('accent', scheme),
                    color: colorForRole('onAccent', scheme),
                  }}
                >
                  {String(active)}
                </Text>
              )}
            </UnstyledButton>
          </Popover.Target>

          <Popover.Dropdown
            p={12}
            style={{
              background: colorForRole('surface', scheme),
              border: `1px solid ${colorForRole('borderStrong', scheme)}`,
            }}
          >
            <Stack gap={12}>
              {chips.length === 0 ? null : (
                <FilterSection title="Status" scheme={scheme}>
                  <Group gap={4}>
                    {chips.map((entry) => (
                      <FilterToggle
                        key={entry.chip}
                        label={entry.label}
                        selected={effective.chip === entry.chip}
                        // Pressing the pill that is already on takes it off:
                        // one status narrows at a time, and the only other way
                        // out of a chosen pill would be Clear all, which takes
                        // the other five narrowings with it.
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

              {/* Always drawn: the four buttons are fixed and no fleet takes
                  one away, which is the rule `effectiveFilters` states by
                  leaving this field out of its vanishing check. */}
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

              <Group
                justify="space-between"
                align="center"
                style={{
                  borderTop: `1px solid ${colorForRole('border', scheme)}`,
                  paddingTop: 10,
                }}
              >
                <UnstyledButton onClick={() => filters.clear()}>
                  <Text component="span" fz={12} c={muted} td="underline">
                    Clear all
                  </Text>
                </UnstyledButton>
                {/* The mockup's `Show 3`. The narrowings took effect as they
                    were chosen, so this is the dismissal rather than an apply
                    step: what it adds is the count it is leaving behind. */}
                <UnstyledButton
                  onClick={() => setOpened(false)}
                  style={{
                    padding: '5px 10px',
                    borderRadius: 6,
                    background: colorForRole('accent', scheme),
                  }}
                >
                  <Text component="span" fz={12} fw={700} c={colorForRole('onAccent', scheme)}>
                    {`Show ${String(showing)}`}
                  </Text>
                </UnstyledButton>
              </Group>
            </Stack>
          </Popover.Dropdown>
        </Popover>
      </Group>

      {/* Nothing narrowed, nothing said. A line reading `0 filters · 3 hidden`
          under an untouched popover would be the row blaming itself for the
          machine selector's choice, which is why `hiddenCount` counts against
          the fleet that selection leaves. */}
      {active === 0 ? null : (
        <Group gap={6} wrap="nowrap" align="center" px={2}>
          <Text component="span" fz={11} c={muted}>
            {summaryWords(active, hidden)}
          </Text>
          <UnstyledButton onClick={() => filters.clear()} style={{ marginLeft: 'auto' }}>
            <Text component="span" fz={11} c={colorForRole('textSecondary', scheme)} td="underline">
              Clear
            </Text>
          </UnstyledButton>
        </Group>
      )}
    </Stack>
  );
}

/**
 * The line under the row: how many narrowings are on, and how many sessions
 * they are keeping out of sight.
 *
 * Pluralised, against the mockup's own `3 filters · 5 hidden`, because the
 * count reaches 1 on the way to 3 and `1 filters` reads as a string somebody
 * assembled rather than a sentence. `hidden` keeps its word either way: it
 * counts sessions, and the noun is not in the line.
 */
function summaryWords(active: number, hidden: number): string {
  const filters = active === 1 ? 'filter' : 'filters';
  return `${String(active)} ${filters} · ${String(hidden)} hidden`;
}

interface FilterSectionProps {
  readonly title: string;
  readonly scheme: Scheme;
  readonly children: ReactNode;
}

/**
 * One section of the popover: a heading and whatever narrows under it.
 *
 * The group carries the name and the visible heading is `aria-hidden`, so the
 * word is announced once rather than twice; the controls inside carry their
 * own label, since a group's name is not a name for the combobox in it.
 */
function FilterSection({ title, scheme, children }: FilterSectionProps): JSX.Element {
  return (
    <Box role="group" aria-label={title}>
      <Text
        component="span"
        aria-hidden
        fz={11}
        c={colorForRole('textMuted', scheme)}
        style={{ display: 'block', marginBottom: 6 }}
      >
        {title}
      </Text>
      {children}
    </Box>
  );
}

interface FilterToggleProps {
  readonly label: string;
  readonly selected: boolean;
  readonly onPick: () => void;
  /** A pill in the status row, a softer corner in the button group. */
  readonly radius: number;
  /** Whether the button shares the row's width equally, as the windows do. */
  readonly grow?: boolean;
  readonly scheme: Scheme;
}

/**
 * A narrowing that is on or off, said twice: in weight and surface for
 * somebody reading the popover, and in `aria-pressed` for everybody else.
 */
function FilterToggle({
  label,
  selected,
  onPick,
  radius,
  grow = false,
  scheme,
}: FilterToggleProps): JSX.Element {
  return (
    <UnstyledButton
      onClick={onPick}
      aria-pressed={selected}
      fz={12}
      fw={selected ? 600 : 400}
      c={colorForRole(selected ? 'text' : 'textMuted', scheme)}
      bg={selected ? colorForRole('raised', scheme) : 'transparent'}
      style={{
        flex: grow ? 1 : undefined,
        textAlign: 'center',
        padding: '4px 9px',
        borderRadius: radius,
        border: `1px solid ${colorForRole(selected ? 'borderStrong' : 'border', scheme)}`,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </UnstyledButton>
  );
}

/**
 * The mockup's slider glyph, transcribed from its own paths.
 *
 * Inline and not an icon set: the app has none, and pulling one in for one
 * button would be a dependency for a drawing. `aria-hidden`, because the
 * button beside it is named in words.
 */
function SlidersGlyph(): JSX.Element {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4" />
    </svg>
  );
}
