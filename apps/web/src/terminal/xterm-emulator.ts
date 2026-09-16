import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import type { TerminalSize } from '@agentplex/protocol';

import { colorForRole, type Scheme } from '../ui/tokens.js';
import {
  EMULATOR_SCROLLBACK_LINES,
  NO_RESULTS,
  type EmulatorFactory,
  type SearchOptions,
  type SearchResults,
  type TerminalEmulator,
  type TerminalSearch,
} from './emulator.js';

/**
 * `window.open`, as the one thing a click on a link in terminal output
 * reaches for.
 *
 * A seam because the decision this ticket makes is entirely in the arguments:
 * which URL, in a new tab, with the opener severed. A test that could only
 * watch a real window would be watching jsdom's, which implements `open` by
 * returning null and warning — so the assertion worth making would be the one
 * assertion impossible to make. The pane injects nothing; the default below
 * is what the app runs.
 */
export interface WindowOpener {
  open(url: string, target: string, features: string): void;
}

/** The real one: the browser this bundle is running in. */
export const browserWindowOpener: WindowOpener = {
  open(url: string, target: string, features: string): void {
    window.open(url, target, features);
  },
};

/**
 * The protocols a link in terminal output may open, and the whole of them.
 *
 * Terminal output is another program's bytes, and an agent prints whatever it
 * was given to print — a URL out of a web page it fetched, a path out of a
 * repository it cloned. `javascript:` in that position is script this origin
 * runs on a click; `file:` and `data:` are a local read and an inline document
 * wearing the app's own trust. None of them is a link to somewhere, which is
 * the only thing this pane offers to follow.
 */
const OPENABLE_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * What a click on a link the addon found does, which is this module's decision
 * and not the addon's.
 *
 * Handed no handler the addon has one of its own: it opens a blank window,
 * nulls that window's `opener` and assigns `location.href`. Its regex today
 * matches nothing but `http:` and `https:`, so the protocol check below reads
 * at first like a guard against a case that cannot arise. It is a guard
 * against the case arising later: the regex is upstream's, replaceable through
 * the addon's own `urlRegex` option, and a pattern is not a protocol check
 * however carefully it is written. The module that opens the window is the one
 * that has to be able to say what it will open, so it parses the claim and
 * answers it. `noreferrer` is the second reason to replace the default: it
 * suppresses the referrer the addon's assignment to `location.href` would
 * still send, and a page opened out of somebody's session output has no
 * business being told which page opened it.
 *
 * What it opens is the parsed URL's `href` rather than the matched text: the
 * string handed to the browser is then the one the parser accepted, with no
 * room between the check and the use.
 *
 * OSC 8 hyperlinks — the escape sequence a program uses to make its own text
 * a link — are xterm's own path and not this one. It restricts them to the
 * same two protocols unless a `linkHandler` opts out, and this app sets none.
 */
export function createWebLinkHandler(
  opener: WindowOpener,
): (event: MouseEvent, uri: string) => void {
  return (_event: MouseEvent, uri: string): void => {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      // Not a URL at all. Leave it as the text it already was.
      return;
    }
    if (!OPENABLE_PROTOCOLS.has(url.protocol)) return;
    opener.open(url.href, '_blank', 'noopener,noreferrer');
  };
}

/**
 * The terminal the pane draws into, configured and not yet opened.
 *
 * Separate from the factory below because opening is the DOM half — xterm
 * measures a cell against a real font in a real window — and the Unicode
 * widths this configures are the parser's half, which is the half a test can
 * drive. `xterm-emulator.test.ts` builds one of these and reads its buffer;
 * nothing else in the app calls it.
 */
export function createPaneTerminal(
  scheme: Scheme,
  opener: WindowOpener = browserWindowOpener,
): Terminal {
  const terminal = new Terminal({
    theme: {
      background: colorForRole('terminalBackground', scheme),
      foreground: colorForRole('terminalText', scheme),
      cursor: colorForRole('accent', scheme),
    },
    // The same stack as the Mantine theme's monospace: the terminal is
    // part of the app's type system, not a second decision.
    fontFamily:
      '"Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: 12,
    /**
     * xterm's own scrollback, in lines: what the user can scroll through, and
     * the whole of what a find in this pane can reach. Distinct from the
     * chunk feed's byte cap, which bounds the replay buffer that repaints
     * this screen on re-attach.
     */
    scrollback: EMULATOR_SCROLLBACK_LINES,
    /**
     * `terminal.unicode` is proposed API in xterm 6, and xterm throws rather
     * than answering unless this is set — the Unicode 11 addon below trips
     * that on load. Opting in is therefore not a style choice; it is the
     * price of choosing a width table at all.
     */
    allowProposedApi: true,
  });
  /**
   * Column widths from Unicode 11 rather than xterm's built-in table, which
   * is Unicode 6 and answers 1 for every emoji assigned since. A width is not
   * decoration: the program on the other end padded its own output against
   * the width it assumed, so an emulator that measures one glyph short moves
   * everything after it one column left, and a TUI agent's panel borders tear
   * down the screen. The addon registers a second version; activating it is
   * what makes the parser use it.
   */
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  /**
   * A URL an agent prints is a thing to follow rather than characters to
   * retype into an address bar. The addon supplies the finding — where a URL
   * starts and ends in a line of output — and `createWebLinkHandler` supplies
   * the following, because the handler the addon falls back to opens what its
   * regex matched without a protocol check of its own.
   */
  terminal.loadAddon(new WebLinksAddon(createWebLinkHandler(opener)));
  return terminal;
}

/**
 * The colours a match is painted in, named in the tokens file like every
 * other hue in the app.
 *
 * These are not decoration in the optional sense. The addon reports
 * `resultIndex` and `resultCount` -- the two numbers "3 of 12" is made of --
 * only when a search was given decoration options: `fireResultsChanged`
 * returns early without them, and the active index it reports is read off the
 * decoration it created for the selected match. So a find bar that shows a
 * count is a find bar with decorations enabled; the choice is between
 * highlighting every match and having no count to show, and highlighting all
 * of them is the better half of that anyway, since a count of twelve with
 * only one of them visible is a number the user cannot check.
 *
 * The overview-ruler colours are required fields on the addon's options and
 * paint nothing here -- this terminal enables no overview ruler -- so they
 * are given the same hues as the decorations they would mark, rather than a
 * second decision that no pixel would show.
 */
export function paneSearchDecorations(scheme: Scheme): NonNullable<ISearchOptions['decorations']> {
  const match = colorForRole('terminalMatch', scheme);
  const active = colorForRole('terminalMatchActive', scheme);
  const accent = colorForRole('accent', scheme);
  return {
    matchBackground: match,
    matchOverviewRuler: match,
    activeMatchBackground: active,
    // The accent outlines the match the bar is standing on: at the size of a
    // terminal cell a background one step lighter than its neighbours is not
    // a difference anybody can see across a screen of them.
    activeMatchBorder: accent,
    activeMatchColorOverviewRuler: accent,
  };
}

/**
 * Finding text in one terminal's buffer: the search addon, loaded, with the
 * two things this app has to decide on top of it.
 *
 * The first is that a search here always carries decorations, for the reason
 * above. The second is the clear before an options change. The addon caches
 * the term it last highlighted and recomputes the highlight set only when it
 * believes something changed; `SearchState.didOptionsChange` is meant to be
 * the "something", but `findNext` stores the new options as the last options
 * BEFORE asking, so the comparison is always the new options against
 * themselves and always answers no. Left alone, turning case sensitivity on
 * mid-search selects nothing and keeps reporting the old count -- verified
 * against 0.16.0: the same term with `caseSensitive` flipped still reported
 * five matches while finding none. Dropping the cached term by clearing first
 * costs one recomputation on a change nobody makes per keystroke, and makes
 * the count the answer to the search that was actually run.
 *
 * Listeners are this module's rather than the addon's so that `clear` is a
 * result like any other: a bar that cleared its query and a bar that found
 * nothing are the same screen, and both go through one path.
 */
export function createPaneSearch(terminal: Terminal, scheme: Scheme): TerminalSearch {
  const addon = new SearchAddon();
  terminal.loadAddon(addon);
  const decorations = paneSearchDecorations(scheme);
  const listeners = new Set<(results: SearchResults) => void>();

  function publish(results: SearchResults): void {
    for (const listener of [...listeners]) listener(results);
  }

  addon.onDidChangeResults((event) => {
    publish({ index: event.resultIndex, count: event.resultCount });
  });

  /** The case sensitivity the addon's current highlight set was built with. */
  let highlightedCaseSensitive: boolean | null = null;

  function optionsFor(options: SearchOptions | undefined): ISearchOptions {
    const caseSensitive = options?.caseSensitive ?? false;
    if (caseSensitive !== highlightedCaseSensitive) {
      addon.clearDecorations();
      highlightedCaseSensitive = caseSensitive;
    }
    return { decorations, caseSensitive, incremental: options?.incremental ?? false };
  }

  return {
    findNext(query: string, options?: SearchOptions): boolean {
      return addon.findNext(query, optionsFor(options));
    },
    findPrevious(query: string, options?: SearchOptions): boolean {
      // `incremental` is a findNext-only notion in the addon, and passing it
      // here would be a request the addon documents itself as ignoring.
      return addon.findPrevious(query, { ...optionsFor(options), incremental: false });
    },
    clear(): void {
      addon.clearDecorations();
      // The addon leaves the last match selected -- clearing decorations is
      // not clearing the selection, and a closed find bar that left a word
      // highlighted would be the pane remembering a question the user
      // withdrew.
      terminal.clearSelection();
      highlightedCaseSensitive = null;
      publish(NO_RESULTS);
    },
    onResults(listener: (results: SearchResults) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Whether an element is a box a grid can be measured against at all.
 *
 * The question is not how big the pane is; it is whether it is anywhere. An
 * element in a collapsed layout cell, one under a `display: none` ancestor,
 * one in a document fragment -- each reports a client box of zero, and zero
 * is not a small terminal.
 *
 * It exists as a predicate rather than an `if` inside the fit because it is
 * the one half of that fit a test can reach. Opening a real terminal needs a
 * renderer, and jsdom has none; a box is two numbers.
 */
export function canMeasureGrid(element: Element | null | undefined): boolean {
  if (element === null || element === undefined) return false;
  return element.clientWidth > 0 && element.clientHeight > 0;
}

/**
 * Fitting one terminal to the box it is drawn in.
 *
 * The addon is loaded here rather than in the factory, beside the search for
 * the same reason: loading is the parser-and-bookkeeping half, which a test
 * can drive, and only `fit` itself needs a terminal that was opened. What the
 * returned function guarantees is that it is safe to call when nothing can be
 * measured -- a pane in a collapsed cell, a terminal never opened -- and
 * leaves the grid where it was.
 *
 * The addon delivers half of that guarantee and not the other half, which is
 * why the check above is here. `proposeDimensions` returns nothing when the
 * terminal has no element or no measured cell, and `fit` then does nothing:
 * that is the never-opened case, and it is the one the addon covers. The
 * collapsed-cell case it does not cover. A terminal that HAS been opened has
 * a measured cell whatever its container is doing, so the addon reads a box
 * of zero, subtracts the padding, divides a negative number by a cell width
 * and floors the result at its own minimum -- two columns by one row, which
 * it then resizes to. Verified by reading 0.11.0: `Math.max(2, ...)` and
 * `Math.max(1, ...)` are the floors, and nothing above them asks whether the
 * box was real.
 *
 * That matters because the size this produces is the size a process on
 * another machine lays its screen out against. A pane that is momentarily
 * collapsed -- a split being dragged shut, a tab hidden -- would tell the
 * agent to redraw at 2x1, and the agent would, and the pane would come back
 * to a screen that had been rewritten for a window nobody ever had. Being
 * left where it was is strictly better than a guess, so a box of nothing is
 * not measured at all.
 *
 * Nothing here reports a size; `onResize` does, and it fires only when one
 * actually changed. That is the second half of why this is a named function:
 * the alternative most people write is a fit followed by reading
 * `cols`/`rows` and sending them, which on an unmeasurable pane sends the
 * size the terminal still had, unprompted, as if it had just changed.
 */
export function createPaneFit(terminal: Terminal): () => void {
  const addon = new FitAddon();
  terminal.loadAddon(addon);
  return () => {
    // The container the pane handed `open`, which is the box the addon
    // measures against and the one this has to be able to vouch for.
    if (!canMeasureGrid(terminal.element?.parentElement)) return;
    addon.fit();
  };
}

/**
 * The pane's own inset, in CSS pixels: a little air between the edge of the
 * pane and the first character, so output does not run into the border.
 *
 * Numbers rather than a CSS string because the fit addon's arithmetic is
 * arithmetic, and a test that asks whether the grid fits the box has to be
 * able to do the same sum.
 */
export const TERMINAL_PADDING = { block: 14, inline: 18 } as const;

/**
 * Putting that inset where the fit addon can see it, which is the terminal
 * element and not the box around it.
 *
 * `proposeDimensions` reads two elements and it is natural to assume it reads
 * one. It measures the PARENT of `terminal.element` -- the box the pane hands
 * `open` -- and subtracts the padding of `terminal.element` itself. So padding
 * on the container is measured and never subtracted: the grid it proposes is
 * the grid the box would hold if the padding were not there, and the columns
 * and rows that do not fit are drawn past the pane's edge and clipped. Measured
 * in Chrome on this app's own pane rather than inferred: a 1728x926 pane with
 * the padding on the container fitted to 237x66, which xterm drew as a 1712x924
 * screen inside a 1692x898 content box; with the padding here it fits to 232x64
 * and draws 1676x896, and nothing is outside the pane at any width.
 *
 * The other half of why it is invisible is a `getComputedStyle` detail worth
 * writing down: the app's boxes are `box-sizing: border-box`, and a computed
 * `height` on such an element resolves to the border box rather than the
 * content box. The addon therefore reads the padded box's full height, which
 * is the number that includes exactly the padding it is about to not subtract.
 * Checked in a browser rather than assumed.
 *
 * Inline style rather than a stylesheet rule because the app ships no
 * stylesheet of its own -- every rule in it is a style object beside the thing
 * it styles -- and this is the one element no component renders. It is written
 * by the module that owns that element, which is this one, and the pane's own
 * box is left with none; `terminal-view.tsx` says so where its padding used to
 * be.
 *
 * An element is `undefined` for a terminal that was never opened, which has no
 * box to inset and is not an error here.
 */
export function padTerminalElement(element: HTMLElement | undefined): void {
  if (element === undefined) return;
  element.style.padding = `${TERMINAL_PADDING.block}px ${TERMINAL_PADDING.inline}px`;
}

/**
 * The height of one row, in CSS pixels, or `null` when there is nothing to
 * measure it against.
 *
 * The number a finger has to be turned into lines with, and xterm publishes no
 * API for it: the renderer's dimensions are internal, and the fit addon reads
 * them through the private core. What is public is the DOM, so it is measured
 * there -- `.xterm-screen` is exactly the grid, `rows` is how many rows are in
 * it, and the quotient is a cell.
 *
 * Reaching for a class name is this module's to do and nobody else's. It is
 * the one module that knows xterm at all, and the class is as much of xterm's
 * published surface as the stylesheet the app imports to lay it out: nothing
 * would draw if `.xterm-screen` changed name.
 *
 * The screen and the element are two answers rather than one because they fail
 * differently. The screen is exact. The element is the box the terminal was
 * fitted into, so dividing it by the rows overstates a cell by up to a row's
 * worth of leftover -- a few percent, which in this use is a glide that
 * travels slightly too far and nothing else. That is a better direction to
 * degrade in than answering `null`, because `null` here is a finger that moves
 * nothing, and a gesture that does nothing is indistinguishable from an app
 * that has stopped answering.
 */
export function paneCellHeight(element: HTMLElement | undefined, rows: number): number | null {
  if (element === undefined || rows <= 0) return null;
  const screen = element.querySelector('.xterm-screen');
  const height = screen instanceof HTMLElement ? screen.clientHeight : element.clientHeight;
  if (height <= 0) return null;
  return height / rows;
}

/** The half of a terminal that scrolling needs, which is three members of it. */
export interface ScrollableTerminal {
  readonly rows: number;
  readonly element: HTMLElement | undefined;
  scrollLines(amount: number): void;
}

/**
 * Moving one terminal's view by a distance in pixels.
 *
 * The remainder is why this is a closure and not a function. xterm scrolls in
 * whole lines, a finger moves in pixels, and a drag delivers its pixels a
 * handful at a time -- so an implementation that truncated each event on its
 * own would drop a fraction of a line per event, and a slow drag would fall
 * steadily behind the finger holding it. What is left over is carried to the
 * next one, so the view arrives where the finger did.
 *
 * The carry is dropped whenever there is nothing to measure. A pane in a
 * collapsed cell has no cell height, and pixels saved up against a grid that
 * is not there are pixels that would be spent later, at another size, on a
 * screen the user has since moved.
 */
export function createPaneScroll(terminal: ScrollableTerminal): (pixels: number) => void {
  let carried = 0;
  return (pixels: number): void => {
    const cell = paneCellHeight(terminal.element, terminal.rows);
    if (cell === null) {
      carried = 0;
      return;
    }
    carried += pixels;
    const lines = Math.trunc(carried / cell);
    if (lines === 0) return;
    carried -= lines * cell;
    terminal.scrollLines(lines);
  };
}

/**
 * The seam over one terminal that has already been opened.
 *
 * Separate from the factory below for the same reason the three helpers above
 * are: the factory's own half is the DOM half -- construct, open -- and this
 * half is the mapping, which is the half worth reading and the half a test can
 * hold to captured bytes. A test that has to go through the factory can only
 * write bytes through `write`, which answers no callback, so it would have to
 * guess at how long xterm takes to parse them. Given the terminal, a test
 * writes with xterm's own completion callback and wraps it afterwards, and the
 * question it then asks the paste is asked of a buffer in a known state.
 *
 * It takes an opened terminal and does not open one. Two of the things below
 * need that and say so: a search selects what it finds, and a selection is
 * something only an opened terminal has; a paste is delivered through the
 * hidden textarea xterm keys input off, which `open` is what creates.
 */
export function createPaneEmulator(terminal: Terminal, scheme: Scheme): TerminalEmulator {
  const search = createPaneSearch(terminal, scheme);
  const fit = createPaneFit(terminal);
  const scrollPixels = createPaneScroll(terminal);
  return {
    search,
    scrollPixels,
    write: (chunk) => terminal.write(chunk),
    onData: (listener) => {
      terminal.onData(listener);
    },
    selection: () => terminal.getSelection(),
    /**
     * xterm's own paste, deliberately, rather than this module deciding what a
     * paste is made of.
     *
     * It normalises line endings, wraps the text in `ESC[200~` and `ESC[201~`
     * when the mode the buffer is in says to, and fires the result at the
     * `onData` listener -- which is to say it produces the bytes the same
     * paste produces in every other terminal, including the one the agent on
     * the far end was written against. Re-deriving that here would be this app
     * holding a second opinion about a mode xterm already tracks, and the two
     * would disagree the first time either changed. It is also why this is on
     * the seam at all rather than the pane calling `write`: `write` is the
     * output direction, and a paste is input.
     */
    paste: (text) => terminal.paste(text),
    focus: () => terminal.focus(),
    dispose: () => terminal.dispose(),
    fit,
    onResize: (listener: (size: TerminalSize) => void) => {
      // Narrowed to the two fields the frame carries. xterm's event is the
      // same pair, but taking it whole would put whatever it gains next on the
      // wire without anybody deciding to.
      terminal.onResize(({ cols, rows }) => listener({ cols, rows }));
    },
  };
}

/**
 * The real emulator behind the seam: xterm, themed from the tokens file and
 * touched by nothing else in the app. This is the one module that imports
 * @xterm/xterm, the way browser.ts is the one that touches WebSocket — tests
 * reach the rules through `fake-emulator` and never construct this.
 */
export function createXtermEmulatorFactory(
  scheme: Scheme,
  opener: WindowOpener = browserWindowOpener,
): EmulatorFactory {
  return {
    create(container: HTMLElement): TerminalEmulator {
      const terminal = createPaneTerminal(scheme, opener);
      terminal.open(container);
      // Both of these are after `open`, deliberately. The emulator's reason is
      // in `createPaneEmulator`; the padding's is that `open` is what creates
      // the element it goes on.
      padTerminalElement(terminal.element);
      return createPaneEmulator(terminal, scheme);
    },
  };
}
