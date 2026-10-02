import { useState, type JSX, type ReactNode } from 'react';
import { Box, Group, Popover, Stack, Text, UnstyledButton } from './components.js';
import { colorForRole, type Scheme } from './tokens.js';

/**
 * The popover beside a filter box (mockups 6a, 6b, 7a): a slider button with a
 * badge counting what is on, a dropdown holding the narrowings, and a footer
 * that clears them or dismisses the dropdown.
 *
 * Chrome only. What the sections are and what a control writes are the
 * caller's -- the sessions' narrowings in one place, the catalogue's in the
 * other -- and so is the count, because what counts as a narrowing is a fact
 * about the reading under it and not about the button.
 *
 * `useState` holds one thing: whether the dropdown is open. It is held here
 * rather than by a caller because the footer button that closes it is drawn
 * here, and a second owner would be two answers to whether it is showing.
 */
export interface FilterPopoverProps {
  /** How many narrowings are on, for the badge and the trigger's border. */
  readonly active: number;
  /** What the footer's dismissal says: the mockup's `Show 3`. */
  readonly dismissLabel: string;
  /** Takes every narrowing the popover counts off at once. */
  readonly onClear: () => void;
  readonly scheme: Scheme;
  /** The sections, in the order they are drawn. */
  readonly children: ReactNode;
}

export function FilterPopover({
  active,
  dismissLabel,
  onClear,
  scheme,
  children,
}: FilterPopoverProps): JSX.Element {
  const [opened, setOpened] = useState(false);
  const muted = colorForRole('textMuted', scheme);

  return (
    // `trapFocus` and `returnFocus` are both off by default in Mantine 9.6.0,
    // and with `withinPortal` the dropdown is drawn at the end of the body:
    // opening it would leave the focus on the trigger, so Tab would walk out of
    // the page rather than into the popover and Escape would reach nothing --
    // the dismissal is a capture handler on the dropdown. Since these
    // narrowings have no other surface at this width, an unreachable popover is
    // controls a keyboard cannot operate. Trapping the focus also puts Escape
    // under it, and returning it leaves somebody where they pressed.
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
        {/* Named in words rather than by its glyph: the app has no icon set,
            and a button whose accessible name is a picture is a button nobody
            can ask for. */}
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
            // `aria-hidden` for the reason the tone dots are: the badge is a
            // second rendering of the line below the row, which is drawn
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
          {children}

          <Group
            justify="space-between"
            align="center"
            style={{
              borderTop: `1px solid ${colorForRole('border', scheme)}`,
              paddingTop: 10,
            }}
          >
            <UnstyledButton onClick={onClear}>
              <Text component="span" fz={12} c={muted} td="underline">
                Clear all
              </Text>
            </UnstyledButton>
            {/* The mockup's `Show 3`. The narrowings took effect as they were
                chosen, so this is the dismissal rather than an apply step:
                what it adds is the count it is leaving behind. */}
            <UnstyledButton
              onClick={() => setOpened(false)}
              style={{
                padding: '5px 10px',
                borderRadius: 6,
                background: colorForRole('accent', scheme),
              }}
            >
              <Text component="span" fz={12} fw={700} c={colorForRole('onAccent', scheme)}>
                {dismissLabel}
              </Text>
            </UnstyledButton>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

export interface FilterSummaryProps {
  /** How many narrowings are on. Nothing is drawn at 0. */
  readonly active: number;
  /**
   * How many rows they are keeping out of sight, where the caller can say.
   * Absent is a reading whose count is already the narrowed answer, so there
   * is no second number to state.
   */
  readonly hidden?: number;
  readonly onClear: () => void;
  readonly scheme: Scheme;
}

/**
 * The line under the row: what the badge counts, said in words, with a Clear
 * beside it.
 *
 * Nothing narrowed, nothing said. A line reading `0 filters · 3 hidden` under
 * an untouched popover would be the row blaming itself for the machine
 * selector's choice, which is why the sessions' `hiddenCount` counts against
 * the fleet that selection leaves.
 */
export function FilterSummary({
  active,
  hidden,
  onClear,
  scheme,
}: FilterSummaryProps): JSX.Element | null {
  if (active === 0) return null;
  return (
    <Group gap={6} wrap="nowrap" align="center" px={2}>
      <Text component="span" fz={11} c={colorForRole('textMuted', scheme)}>
        {summaryWords(active, hidden)}
      </Text>
      <UnstyledButton onClick={onClear} style={{ marginLeft: 'auto' }}>
        <Text component="span" fz={11} c={colorForRole('textSecondary', scheme)} td="underline">
          Clear
        </Text>
      </UnstyledButton>
    </Group>
  );
}

/**
 * The line under the row: how many narrowings are on, and -- where the caller
 * can say -- how many rows they are keeping out of sight.
 *
 * Pluralised, against the mockup's own `3 filters · 5 hidden`, because the
 * count reaches 1 on the way to 3 and `1 filters` reads as a string somebody
 * assembled rather than a sentence. `hidden` keeps its word either way: it
 * counts rows, and the noun is not in the line.
 */
export function summaryWords(active: number, hidden?: number): string {
  const words = `${String(active)} ${active === 1 ? 'filter' : 'filters'}`;
  return hidden === undefined ? words : `${words} · ${String(hidden)} hidden`;
}

export interface FilterSectionProps {
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
export function FilterSection({ title, scheme, children }: FilterSectionProps): JSX.Element {
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

export interface FilterToggleProps {
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
export function FilterToggle({
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
