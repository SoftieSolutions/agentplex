import {
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { opensElsewhere } from '../sessions/notification-list.js';
import type { SessionListItem } from '../sessions/session-list-model.js';
import type { ShellForm } from '../shell/shell-form.js';
import { Box, Group, Modal, Text, TextInput, UnstyledButton } from '../ui/components.js';
import { ShortcutHint } from '../ui/shortcut-hint.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import {
  firstResult,
  lastResult,
  nextResult,
  paletteListing,
  PALETTE_RESULT_LIMIT,
  previousResult,
  sessionResults,
  type PaletteListing,
  type PaletteResult,
} from './palette-model.js';

/**
 * The search-shaped control in the chrome, and the dialog it opens.
 *
 * One component for both, because the two are one control: what opens the
 * dialog is the button, what closes it hands the focus back to the button, and
 * nothing outside this file can open it. That is the shape `attention-bell.tsx`
 * already has, and for the same reason.
 *
 * One node, two forms. The trigger is a bar beside the brand mark at desk
 * widths and a full-width row under the phone header (mockups 7a and 6c), and
 * the dialog is the same dialog in both: a phone that searched a different
 * fleet, or ranked it differently, would be a second app. `form` decides the
 * size and whether the chord is drawn, and nothing else.
 *
 * The chord is drawn and not claimed. ⌘K is a plain chord, and
 * `terminal/shortcuts.ts` refuses plain chords deliberately -- they belong to
 * the terminal -- so there is nothing in the app that could bind this one:
 * AGX-260 is where the chrome-level registry and the real chords are decided.
 * The hint is therefore the same placeholder the New menu's rows draw, through
 * the same component, hidden from the accessibility tree and carrying no
 * `aria-keyshortcuts`. The button is what works, and a person who cannot see
 * the hint loses nothing that ever answered.
 *
 * This is the palette and not the session list's filter, which the same screen
 * draws at the same time: `palette-model.ts` argues why they are two controls,
 * and the argument is why this is handed the whole fleet rather than
 * `visibleSessions`. What it ends in is an address -- Enter on a row, or a
 * click on one -- which is the other half of that: a filter's answer is a
 * shorter list, this one's answer is somewhere to be.
 *
 * The keyboard pattern is a combobox over a listbox, declared as one because
 * the arrows really do move through the rows. The rows are anchors, so a click
 * is a real navigation and a middle click opens a tab, and they are taken out
 * of the tab order the way a listbox's options are: the field keeps the focus,
 * and the arrows are how the list is walked.
 *
 * No effects. The query and the selection are this component's own state, the
 * results are computed from them during render, and the two imperative moves --
 * the caret into the field, the focus back to the trigger -- are a ref callback
 * on mount and a line in the handler that closes.
 */

/** What the control is for, said once: on the trigger and over the field. */
const SEARCH_WORDS = 'Search sessions';

/**
 * What the field looks in, which is `matchesSearch` spelled out.
 *
 * The mockup's placeholder is "Search sessions, projects, graphs…" and this is
 * deliberately not that: only sessions are searched today. AGX-140 adds the
 * kinds the hub answers, and the mockup's words become true in the same change
 * that makes them true.
 */
const FIELD_HINT = 'A name, a store, a machine or a provider';

/** The chord the mockup draws on the trigger, bound to nothing. See the header. */
const CHORD = '⌘K';

/**
 * The dialog's own ids, for the combobox to point at its list and its active
 * row. Constants rather than generated, because the shell draws one palette:
 * the wide chrome and the phone chrome are two forms of one shell and only one
 * of them is mounted.
 */
const LIST_ID = 'palette-results';

function rowId(index: number): string {
  return `palette-result-${String(index)}`;
}

/**
 * The caret, put where a person who just opened a palette is already typing.
 *
 * A stable function rather than an inline arrow, so React attaches it once on
 * mount instead of re-running it after every keystroke. Mantine's own focus
 * trap would land somewhere reasonable on its own; this says which element,
 * in the one file that knows there is a field to land in.
 */
function focusOnMount(node: HTMLInputElement | null): void {
  node?.focus();
}

/** The browser's own way to a hash address, which a test replaces. */
function assignHash(hash: string): void {
  window.location.hash = hash;
}

/**
 * How many rows were left out, in words, or `null` when none were.
 *
 * The count of what matched is carried out of `paletteListing` rather than
 * inferred from the rows, because a shortened list that says nothing claims it
 * found two things when it found forty.
 */
function remainderWords(listing: PaletteListing): string | null {
  if (listing.total <= listing.results.length) return null;
  return `${String(listing.results.length)} of ${String(listing.total)} matches. Keep typing to narrow.`;
}

/** The trigger's box, per form: the mockup's bar, and a fingertip's floor. */
function triggerStyle(form: ShellForm, scheme: Scheme): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: form === 'phone' ? '100%' : 380,
    maxWidth: '100%',
    minWidth: 0,
    minHeight: form === 'phone' ? 44 : undefined,
    padding: form === 'phone' ? '0 12px' : '6px 10px',
    borderRadius: form === 'phone' ? 9 : 7,
    background: colorForRole('surfaceAlt', scheme),
    border: `1px solid ${colorForRole('border', scheme)}`,
    color: colorForRole('textMuted', scheme),
    fontSize: 13,
    lineHeight: 1.2,
    textAlign: 'left',
  };
}

export interface CommandPaletteProps {
  /**
   * The whole fleet, never a narrowed list: see `palette-model.ts` for why the
   * palette is handed what the session list's filter is not.
   */
  readonly items: readonly SessionListItem[];
  /** Which form the trigger takes, from `useShellForm` and never measured here. */
  readonly form: ShellForm;
  /**
   * How many rows the dialog draws, defaulted to the model's own bound and
   * injectable for the reason `paletteListing` takes one: a test can pin what
   * a shortened list says without a fixture long enough to trip the default.
   */
  readonly limit?: number;
  readonly scheme: Scheme;
  /** How a followed row enters its address, injected so a test never touches location. */
  readonly navigate?: (hash: string) => void;
}

export function CommandPalette({
  items,
  form,
  limit = PALETTE_RESULT_LIMIT,
  scheme,
  navigate = assignHash,
}: CommandPaletteProps): JSX.Element {
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState('');
  /**
   * The row the keyboard is on, or `null` before anything moved.
   *
   * Held as a result id rather than an index, because the list is rebuilt under
   * it on every keystroke; `active` below is what the id resolves to in the
   * list actually on screen, so a selection the query has narrowed away falls
   * back to the top row without anything having to notice that it went.
   */
  const [selected, setSelected] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const listing = paletteListing(sessionResults(items, query), limit);
  const results = listing.results;
  const active =
    selected !== null && results.some((result) => result.id === selected)
      ? selected
      : firstResult(results);

  function open(): void {
    setQuery('');
    setSelected(null);
    setOpened(true);
  }

  /**
   * Shuts it and puts the focus back where the press came from.
   *
   * Every way out arrives here -- the escape key, a click outside, a followed
   * row -- so the focus lands on the trigger however the dialog ended, rather
   * than on the body with nothing to arrow back to. Mantine's own focus return
   * is turned off against this: two opinions about where the focus goes is one
   * opinion too many, and only this one knows which button opened the dialog.
   */
  function close(): void {
    setOpened(false);
    trigger.current?.focus();
  }

  function follow(result: PaletteResult): void {
    close();
    navigate(result.href);
  }

  /**
   * The palette's keystrokes, in the field they are typed in.
   *
   * The arrows and the ends are prevented from their default, which in a text
   * field is moving the caret: a person arrowing through results is not
   * editing the text, and a caret that jumped to the end of the query on every
   * press would make backspacing mid-word impossible.
   *
   * Escape is not here. The dialog closes on it through Mantine's own handler,
   * which is the same path a click outside takes, and a second listener for one
   * key would be a second opinion about what closing means.
   */
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelected(nextResult(results, active ?? ''));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelected(previousResult(results, active ?? ''));
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setSelected(firstResult(results));
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setSelected(lastResult(results));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = results.find((result) => result.id === active);
      // Nothing matched, so there is nowhere to go and the query stays where
      // it is: an Enter that closed the dialog on an empty list would throw
      // away what was typed for having typed too much of it.
      if (chosen !== undefined) follow(chosen);
    }
  }

  const remainder = remainderWords(listing);

  return (
    <>
      <UnstyledButton
        ref={trigger}
        data-palette-trigger
        aria-haspopup="dialog"
        aria-expanded={opened}
        onClick={open}
        style={triggerStyle(form, scheme)}
      >
        <SearchGlyph />
        <Text component="span" fz={13} style={{ flex: 1, minWidth: 0 }}>
          {SEARCH_WORDS}
        </Text>
        {/* The mockup draws the chord at desk widths only, and a phone has no
            keyboard to press it with even once something listens. */}
        {form === 'wide' ? <ShortcutHint text={CHORD} bound={false} scheme={scheme} /> : null}
      </UnstyledButton>

      <Modal.Root
        opened={opened}
        onClose={close}
        // See `close`: the focus return is this component's, because it is the
        // one that knows the dialog was opened from that button.
        returnFocus={false}
        centered
        padding={0}
        size={form === 'phone' ? '100%' : 560}
      >
        <Modal.Overlay />
        <Modal.Content
          data-palette-dialog
          aria-label={SEARCH_WORDS}
          style={{
            background: colorForRole('surface', scheme),
            border: `1px solid ${colorForRole('borderStrong', scheme)}`,
            borderRadius: 12,
            overflow: 'hidden',
          }}
        >
          <Box
            style={{
              padding: '10px 12px',
              borderBottom: `1px solid ${colorForRole('border', scheme)}`,
            }}
          >
            <TextInput
              ref={focusOnMount}
              data-autofocus
              data-palette-field
              role="combobox"
              aria-label={SEARCH_WORDS}
              aria-expanded
              aria-controls={LIST_ID}
              aria-activedescendant={activeDescendant(results, active)}
              aria-autocomplete="list"
              autoComplete="off"
              variant="unstyled"
              placeholder={FIELD_HINT}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={onKeyDown}
            />
          </Box>

          <Box id={LIST_ID} role="listbox" aria-label={SEARCH_WORDS} style={{ padding: 6 }}>
            {results.map((result, index) => (
              <ResultRow
                key={result.id}
                result={result}
                id={rowId(index)}
                active={result.id === active}
                onFollow={close}
                scheme={scheme}
              />
            ))}
          </Box>

          {results.length === 0 ? (
            // The empty state carries the next action: what this looks in is
            // the one thing a person who typed a miss cannot see.
            <Text
              data-palette-empty
              fz={12.5}
              c={colorForRole('textMuted', scheme)}
              style={{ padding: '2px 14px 14px' }}
            >
              Nothing matches that. {FIELD_HINT} is what this looks in.
            </Text>
          ) : null}

          {remainder === null ? null : (
            <Text
              data-palette-more
              fz={11}
              c={colorForRole('textMuted', scheme)}
              style={{
                padding: '8px 14px',
                borderTop: `1px solid ${colorForRole('border', scheme)}`,
              }}
            >
              {remainder}
            </Text>
          )}
        </Modal.Content>
      </Modal.Root>
    </>
  );
}

/**
 * The element id the field points its active row at, or `undefined` when there
 * is no row to point at. Outside the component: it is the rows and the
 * selection and nothing else.
 */
function activeDescendant(
  results: readonly PaletteResult[],
  active: string | null,
): string | undefined {
  const index = results.findIndex((result) => result.id === active);
  return index < 0 ? undefined : rowId(index);
}

interface ResultRowProps {
  readonly result: PaletteResult;
  /** The element id the field points at when this row is the active one. */
  readonly id: string;
  readonly active: boolean;
  /** That the dialog is in the way of the address this row just entered. */
  readonly onFollow: () => void;
  readonly scheme: Scheme;
}

/**
 * One row: what the thing is called, where it is, and the address it goes to.
 *
 * An anchor, like the notification rows and the session cards, so the address
 * is visible, middle-clickable and followed by the browser rather than by a
 * handler. `tabIndex={-1}` is the listbox half of that: the field keeps the
 * focus and the arrows walk the rows, so a Tab through the dialog does not
 * walk them a second way.
 *
 * A click asking for the address somewhere else is neither closed on nor
 * prevented: `opensElsewhere` is the rule the notification rows already carry
 * rather than a second wording of it.
 */
function ResultRow({ result, id, active, onFollow, scheme }: ResultRowProps): JSX.Element {
  return (
    <Box
      component="a"
      id={id}
      role="option"
      aria-selected={active}
      tabIndex={-1}
      data-palette-result={result.id}
      href={result.href}
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (!opensElsewhere(event)) onFollow();
      }}
      style={{
        display: 'block',
        padding: '7px 10px',
        borderRadius: 7,
        textDecoration: 'none',
        background: active ? colorForRole('raised', scheme) : 'transparent',
      }}
    >
      <Group gap={8} align="baseline" wrap="nowrap">
        <Text
          data-palette-label
          component="span"
          fz={13}
          fw={600}
          c={colorForRole('text', scheme)}
          style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {result.label}
        </Text>
        <Text
          component="span"
          fz={11.5}
          c={colorForRole('textMuted', scheme)}
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {result.detail}
        </Text>
      </Group>
    </Box>
  );
}

/**
 * The magnifier on the trigger, drawn rather than imported.
 *
 * The app ships no icon set and `attention-bell.tsx` argues the exception this
 * is the other half of: two strokes inline is cheaper than a dependency that
 * would then have to be used for every other shape. The strokes are the
 * mockup's own, and it inherits the colour of the control it sits in.
 */
function SearchGlyph(): JSX.Element {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      width={15}
      height={15}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}
