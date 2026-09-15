import {
  useCallback,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type RefObject,
} from 'react';

import { Box, Group, Text, TextInput, UnstyledButton } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import type { SearchResults, TerminalSearch } from './emulator.js';
import { matchSummary, searchScopeNotice } from './presentation.js';

/**
 * Finding a word in what a pane already holds: a row under the pane header,
 * opened by Ctrl/Cmd+Shift+F and closed by Escape.
 *
 * It searches the emulator's buffer and nothing else. There is no index on
 * the hub and no search frame in the protocol, so what this can answer is
 * bounded by what reached this pane -- which is why the bar says the bound
 * out loud when the beginning has been dropped rather than letting "no
 * matches" stand for "never happened".
 *
 * The seam is handed in as a getter rather than a value because the emulator
 * lives in a ref, not in state: bytes arrive at pty speed and a pane that
 * held its emulator in state would re-render the app to hold it. By the time
 * this bar can be opened the emulator is long since attached, so the getter
 * answers; if it somehow does not, every control is inert rather than
 * throwing.
 */

/** The case-sensitivity toggle and the three buttons, which share a shape. */
function controlStyle(scheme: Scheme, pressed: boolean): CSSProperties {
  return {
    padding: '2px 8px',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 500,
    whiteSpace: 'nowrap',
    border: `1px solid ${colorForRole('border', scheme)}`,
    background: pressed ? colorForRole('raised', scheme) : 'transparent',
    color: pressed ? colorForRole('accent', scheme) : colorForRole('textSecondary', scheme),
  };
}

export interface FindBarProps {
  /** The live search, or null while no emulator is attached. */
  search(): TerminalSearch | null;
  /** Whether the feed has dropped output, asked at render; see below. */
  truncated(): boolean;
  readonly scheme: Scheme;
  /** Closing is the pane's: it clears the search and gives focus back. */
  onClose(): void;
  /**
   * The pane's handle on the input, so the chord that opens the bar can also
   * refocus one that is already open.
   */
  readonly inputRef?: RefObject<HTMLInputElement | null>;
}

export function FindBar({
  search,
  truncated,
  scheme,
  onClose,
  inputRef,
}: FindBarProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState<SearchResults | null>(null);

  /**
   * The input's own lifetime, which is exactly the subscription's: focus it
   * on the way in, listen for results while it exists, stop listening on the
   * way out. A ref callback and not an effect -- the emulator outlives this
   * bar, so a listener left behind would accumulate one per open.
   */
  const mountInput = useCallback(
    (input: HTMLInputElement) => {
      if (inputRef) inputRef.current = input;
      input.focus();
      const stop = search()?.onResults(setResults);
      return () => {
        stop?.();
        if (inputRef) inputRef.current = null;
      };
    },
    [search, inputRef],
  );

  // The handlers below close over the query, the case flag and the search
  // getter, so they live in the body; the wording and the styling above do
  // not, and do not.
  function run(
    term: string,
    matchCase: boolean,
    direction: 'next' | 'previous',
    typing: boolean,
  ): void {
    const live = search();
    if (live === null) return;
    if (term.length === 0) {
      // An empty query is not a search that found nothing; it is the absence
      // of a question, and the pane goes back to being unmarked.
      live.clear();
      return;
    }
    const options = { caseSensitive: matchCase, incremental: typing };
    if (direction === 'next') live.findNext(term, options);
    else live.findPrevious(term, options);
  }

  function changeQuery(event: ChangeEvent<HTMLInputElement>): void {
    const next = event.currentTarget.value;
    setQuery(next);
    // Incremental, because this is the user still typing: without it every
    // keystroke would step to the match after the one on screen, and a word
    // typed in full would leave the view wherever its letters led.
    run(next, caseSensitive, 'next', true);
  }

  function toggleCase(): void {
    const next = !caseSensitive;
    setCaseSensitive(next);
    run(query, next, 'next', false);
  }

  function inputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    run(query, caseSensitive, event.shiftKey ? 'previous' : 'next', false);
  }

  function barKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    onClose();
  }

  const summary = matchSummary(query, results);
  /**
   * Read at render rather than subscribed to: the feed publishes no changes,
   * and this bar re-renders on every keystroke and every result, so the worst
   * case is a notice that appears one keystroke after the drop that caused
   * it. A subscription for that would be machinery in the pane's hot path.
   */
  const notice = searchScopeNotice(truncated());

  return (
    <Box
      onKeyDown={barKeyDown}
      style={{ borderBottom: `1px solid ${colorForRole('border', scheme)}` }}
    >
      <Group gap={8} px={18} py={8} wrap="nowrap">
        <Text fz={11} fw={500} style={{ color: colorForRole('accent', scheme) }}>
          find
        </Text>
        <TextInput
          ref={mountInput}
          size="xs"
          style={{ flex: 1 }}
          value={query}
          onChange={changeQuery}
          onKeyDown={inputKeyDown}
          placeholder="Find in this pane"
          aria-label="find in this pane"
        />
        <UnstyledButton
          onClick={toggleCase}
          aria-label="match case"
          aria-pressed={caseSensitive}
          style={controlStyle(scheme, caseSensitive)}
        >
          Aa
        </UnstyledButton>
        <UnstyledButton
          onClick={() => run(query, caseSensitive, 'previous', false)}
          aria-label="previous match"
          style={controlStyle(scheme, false)}
        >
          Prev
        </UnstyledButton>
        <UnstyledButton
          onClick={() => run(query, caseSensitive, 'next', false)}
          aria-label="next match"
          style={controlStyle(scheme, false)}
        >
          Next
        </UnstyledButton>
        <Text
          fz={11}
          fw={500}
          role="status"
          style={{
            color: colorForRole('textMuted', scheme),
            whiteSpace: 'nowrap',
            minWidth: 64,
            textAlign: 'right',
          }}
        >
          {summary}
        </Text>
        <UnstyledButton
          onClick={onClose}
          aria-label="close the find bar"
          style={controlStyle(scheme, false)}
        >
          Close
        </UnstyledButton>
      </Group>
      {notice !== null && (
        <Text fz={10} px={18} pb={6} style={{ color: colorForRole('textFaint', scheme) }}>
          {notice}
        </Text>
      )}
    </Box>
  );
}
