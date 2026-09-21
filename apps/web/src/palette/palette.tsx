import {
  useRef,
  useState,
  useSyncExternalStore,
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
  mergeResults,
  nextResult,
  paletteListing,
  PALETTE_RESULT_LIMIT,
  previousResult,
  sessionResults,
  type PaletteGroup,
  type PaletteListing,
  type PaletteResult,
} from './palette-model.js';
import type { PaletteSearch, PaletteSearchSnapshot } from './palette-search.js';

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

/**
 * What the control is for, said once: on the trigger and over the field.
 *
 * Three kinds, because three kinds can answer. The mockup's field reads
 * "Search sessions, projects, graphs…" and this is the honest form of it: a
 * project is findable now that a flat search can carry a container (AGX-261),
 * and a graph is a kind no migration has seeded, so naming one would be a
 * promise the hub cannot keep. The list this sentence describes is
 * `PALETTE_KINDS`, and the day a graph joins it this sentence joins it too.
 */
const SEARCH_WORDS = 'Search sessions, documents and projects';

/**
 * What the field looks in, which is both matchers spelled out.
 *
 * Both, because one field asks two questions: `matchesSearch` over the
 * sessions this browser holds -- a name, a session id, a provider, a machine, a
 * store, a summary -- and the hub's own `matchOf` over everything else, which
 * is a name, a session id, a working directory and a server label. The sentence
 * is the union of those, and it is the sentence the empty state repeats: a
 * person who typed a miss cannot see what was looked in, so a hint that named
 * fewer fields than are matched would have them stop typing the one that would
 * have worked.
 *
 * Which kinds can answer is `SEARCH_WORDS` above and not this line: this one
 * names the fields, and a person who typed a miss needs both -- what was
 * searched, and what was searched in.
 */
const FIELD_HINT = 'A name, an id, a directory, a store, a machine, a provider or a summary';

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

/** The heading a group is named by, pointed at rather than repeated. */
function headingId(index: number): string {
  return `palette-group-${String(index)}`;
}

/** The sentence the empty state and the announcement both say. */
const NO_MATCH_WORDS = `Nothing matches that. ${FIELD_HINT} is what this looks in.`;

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
 * Two ways to be short of the whole answer, and they are said in one line
 * because they are one fact to a person reading it: the dialog drew fewer rows
 * than matched, or the hub had a further page it was not asked for. The count
 * of what matched is carried out of `paletteListing` rather than inferred from
 * the rows, because a shortened list that says nothing claims it found two
 * things when it found forty; the hub's half is a flag and not a count, for the
 * reason `PaletteSearchSnapshot.more` gives.
 */
function remainderWords(listing: PaletteListing, hubHadMore: boolean): string | null {
  const shortened = listing.total > listing.results.length;
  if (!shortened && !hubHadMore) return null;
  const counted = shortened
    ? `${String(listing.results.length)} of ${String(listing.total)} matches`
    : `${String(listing.results.length)} matches`;
  const andTheHub = hubHadMore ? ', and the hub had more' : '';
  return `${counted}${andTheHub}. Keep typing to narrow.`;
}

/**
 * A refusal, said as what it costs rather than as an error.
 *
 * The client-held sessions are computed in this browser and owe the hub
 * nothing, so a hub that cannot answer takes its own half and leaves them
 * drawn. Saying so is the whole point of the line: rows that are still there
 * under a silent failure read as the complete answer to what was typed.
 */
function problemWords(problem: string): string {
  return `Only the sessions this browser already holds are listed: ${problem}`;
}

/**
 * What the off-screen region says, which is what is announced.
 *
 * The rows and the count are a visual answer -- the list grows and shrinks
 * under the field -- and a person who cannot see it is told the same thing in
 * the one sentence that carries it. Nothing is announced while the hub is
 * still answering an empty-looking list: "nothing matches" said over a question
 * that has not been answered yet is a claim this does not have.
 *
 * A refusal is in this sentence for exactly that reason, and it is the whole
 * of the sentence when no row is drawn. The rows, the count and the refusal
 * line are three pieces of one answer on screen and a screen reader is handed
 * one: the refusal line under the rows is text in a dialog rather than a live
 * region, so an announcement that left it out would say "Nothing matches that"
 * about a question half of which was never asked. With rows drawn the refusal
 * rides beside the count, because the count is then a count of one half.
 */
function announcementWords(
  listing: PaletteListing,
  searching: boolean,
  problem: string | null,
): string {
  const drawn = listing.results.length;
  if (drawn === 0 && searching) return '';
  if (drawn === 0) return problem === null ? NO_MATCH_WORDS : unansweredWords(problem);
  const counted =
    listing.total > drawn
      ? `${String(drawn)} of ${String(listing.total)} matches`
      : drawn === 1
        ? '1 match'
        : `${String(drawn)} matches`;
  return problem === null ? counted : `${counted}. ${problemWords(problem)}`;
}

/**
 * The miss that is not a miss: nothing here matched and the hub never said.
 *
 * Said as what was and was not asked, rather than as an error, because that is
 * the difference a person acts on: retyping finds nothing more while the hub
 * is unreachable, and the sessions this browser holds are still searched.
 */
function unansweredWords(problem: string): string {
  return `Nothing this browser holds matches that, and the hub could not be asked: ${problem}`;
}

/**
 * The off-screen box the announcement is read out of.
 *
 * `attention-bell.tsx`'s, deliberately the same: a live region has to be in the
 * document before it has words, because what a screen reader announces is a
 * change to one that was already there. Mounted beside the trigger rather than
 * inside the dialog for exactly that reason -- a region that arrives with the
 * dialog arrives with its text.
 */
const OFF_SCREEN: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

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
  /**
   * The half of the answer the hub holds, as a store this subscribes to.
   *
   * Built by the shell and handed in, for the reason the fleet is: what asks
   * the hub is a store with a debounce, a generation counter and a socket
   * behind it, and none of that is a dialog's business. `palette-search.ts`
   * argues the split; this file's job is to draw both halves as one list.
   */
  readonly search: PaletteSearch;
  readonly scheme: Scheme;
  /** How a followed row enters its address, injected so a test never touches location. */
  readonly navigate?: (hash: string) => void;
}

export function CommandPalette({
  items,
  form,
  limit = PALETTE_RESULT_LIMIT,
  search,
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

  /**
   * The hub's half, read the way every other external state in this app is
   * read: no effect, and the dialog re-renders when the answer moves.
   */
  const hubHalf: PaletteSearchSnapshot = useSyncExternalStore(search.subscribe, search.getSnapshot);

  const listing = paletteListing(
    mergeResults(sessionResults(items, query), hubHalf.results),
    limit,
  );
  const results = listing.results;
  const active =
    selected !== null && results.some((result) => result.id === selected)
      ? selected
      : firstResult(results);

  function open(): void {
    setQuery('');
    setSelected(null);
    setOpened(true);
    // Nothing was typed yet, so there is nothing to ask and nothing an older
    // opening answered that is an answer to this one.
    search.reset();
  }

  /** What was typed, to both halves: one field, one question, two answerers. */
  function ask(text: string): void {
    setQuery(text);
    search.search(text);
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
    // The question goes with the dialog: a query in flight has nowhere to land
    // and its answer would be waiting the next time this opened, against text
    // the field no longer holds.
    search.reset();
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
   *
   * Nothing at all happens mid-composition. An IME spends Enter on committing
   * the candidate and the arrows on walking the candidate list, and the field
   * sees those presses too: a palette that acted on them would navigate away
   * halfway through a word and make the candidate list unusable. `isComposing`
   * is the flag for it, and `keyCode` 229 is what a browser that has not set
   * the flag yet sends instead -- both, because the ones that disagree are
   * exactly the ones this has to work in.
   */
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
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

  const remainder = remainderWords(listing, hubHalf.more);

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
              onChange={(event) => ask(event.currentTarget.value)}
              onKeyDown={onKeyDown}
            />
          </Box>

          <Box id={LIST_ID} role="listbox" aria-label={SEARCH_WORDS} style={{ padding: 6 }}>
            {listing.groups.map((group, groupIndex) => (
              <ResultGroup
                key={group.kind}
                group={group}
                index={groupIndex}
                // Where this group's rows begin in the drawn list, so a row's
                // element id is its place in the order the arrows move in and
                // not its place inside its group.
                offset={listing.groups
                  .slice(0, groupIndex)
                  .reduce((rows, earlier) => rows + earlier.results.length, 0)}
                active={active}
                onFollow={close}
                scheme={scheme}
              />
            ))}
          </Box>

          {hubHalf.searching ? (
            // The client-held rows stay put under this: they are computed here
            // and complete already, and what is still coming is the other half.
            <Text
              data-palette-searching
              fz={11.5}
              c={colorForRole('textMuted', scheme)}
              style={{ padding: '2px 14px 12px' }}
            >
              Searching the hub for documents and projects…
            </Text>
          ) : null}

          {hubHalf.problem === null || results.length === 0 ? null : (
            <Text
              data-palette-problem
              fz={11.5}
              c={colorForRole('textMuted', scheme)}
              style={{ padding: '2px 14px 12px' }}
            >
              {problemWords(hubHalf.problem)}
            </Text>
          )}

          {results.length === 0 && !hubHalf.searching ? (
            // The empty state carries the next action: what this looks in is
            // the one thing a person who typed a miss cannot see. Not while the
            // hub is still answering, though: a miss is a claim, and half the
            // answer is outstanding until it has answered.
            //
            // And a miss that could not be checked is not a miss, which is why
            // this says exactly what the announcement says rather than the
            // sentence above it: a refused half leaves the typed word unlooked
            // for, and "Nothing matches that" sends a person to retype it. The
            // refusal line is not drawn over an empty list for the same
            // reason -- it is worded for rows that are still listed, and with
            // none it would be this sentence said twice.
            <Text
              data-palette-empty
              fz={12.5}
              c={colorForRole('textMuted', scheme)}
              style={{ padding: '2px 14px 14px' }}
            >
              {hubHalf.problem === null ? NO_MATCH_WORDS : unansweredWords(hubHalf.problem)}
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

      {/* Mounted at every state and empty when the dialog is shut: see
          OFF_SCREEN for why the region cannot arrive with its words. */}
      <Box data-palette-announcement role="status" style={OFF_SCREEN}>
        {opened ? announcementWords(listing, hubHalf.searching, hubHalf.problem) : ''}
      </Box>
    </>
  );
}

interface ResultGroupProps {
  readonly group: PaletteGroup;
  /** Which group this is, for the id the rows under it are named by. */
  readonly index: number;
  /** Where this group's first row falls in the drawn order. */
  readonly offset: number;
  readonly active: string | null;
  readonly onFollow: () => void;
  readonly scheme: Scheme;
}

/**
 * One kind's rows, under a heading that says which kind.
 *
 * The heading exists because a name is not unique across kinds: a session and a
 * document can both be called `spike-wasm`, and two identical rows with
 * different addresses is a coin toss. It is a heading and not an option -- a
 * `group` inside the listbox, labelled by the heading's own text -- so the
 * arrows walk rows only and a screen reader hears which group it entered
 * instead of a row it cannot select.
 */
function ResultGroup({
  group,
  index,
  offset,
  active,
  onFollow,
  scheme,
}: ResultGroupProps): JSX.Element {
  return (
    <Box role="group" aria-labelledby={headingId(index)}>
      <Text
        id={headingId(index)}
        data-palette-heading={group.kind}
        component="div"
        fz={10.5}
        fw={600}
        tt="uppercase"
        c={colorForRole('textMuted', scheme)}
        style={{ padding: '8px 10px 4px', letterSpacing: 0.6 }}
      >
        {group.heading}
      </Text>
      {group.results.map((result, row) => (
        <ResultRow
          key={result.id}
          result={result}
          id={rowId(offset + row)}
          active={result.id === active}
          onFollow={onFollow}
          scheme={scheme}
        />
      ))}
    </Box>
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
