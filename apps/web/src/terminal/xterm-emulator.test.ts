// @vitest-environment jsdom
import { SearchAddon } from '@xterm/addon-search';
import { Terminal, type ILink } from '@xterm/xterm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bracketedPasteChunks } from './bracketed-paste.fixture.js';
import type { SearchResults, TerminalEmulator, TerminalSearch } from './emulator.js';
import { ptyChunks } from './pty-chunks.fixture.js';
import { unicodeChunks } from './unicode-widths.fixture.js';
import {
  createPaneEmulator,
  createPaneFit,
  createPaneSearch,
  createPaneTerminal,
  createWebLinkHandler,
  paneSearchDecorations,
  type WindowOpener,
} from './xterm-emulator.js';

/**
 * What the pane makes of real bytes that are wider than one column each.
 *
 * The fixture is a bordered panel a shell drew through a real pty
 * (apps/server/src/capture-unicode-width-fixtures.test.ts), padded by the
 * program that drew it on the assumption every modern terminal makes: an
 * emoji is two columns. So the question these tests ask the emulator is a
 * question about columns — does the right border land in the same column on
 * every row — and the answer is the addon's or it is a tear.
 *
 * jsdom, and no `open`. xterm cannot open here: it reaches for
 * `window.matchMedia`, which jsdom does not implement, and for a canvas
 * context, which it implements by warning. None of that is what a width is.
 * Widths are decided by the parser as bytes arrive, and the buffer it fills
 * is readable without a renderer — which is why `createPaneTerminal` is
 * separate from the factory that opens one.
 */

type PaneTerminal = ReturnType<typeof createPaneTerminal>;

/** The rows the fixture's panel occupies, and the ZWJ line beneath it. */
const PANEL_TOP = 0;
const PANEL_BODY = 1;
const PANEL_BOTTOM = 2;
const ZWJ_LINE = 3;

/** The column the panel's right border is drawn in, as the shell padded it. */
const RIGHT_BORDER = 11;

const open: PaneTerminal[] = [];
const mounted: HTMLElement[] = [];

afterEach(() => {
  while (open.length > 0) open.pop()?.dispose();
  while (mounted.length > 0) mounted.pop()?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * Replays the capture into a terminal built the way the pane builds one.
 *
 * `write` is asynchronous — xterm parses on its own schedule — so each chunk
 * is awaited through the callback it offers rather than slept on. Chunks go
 * in one at a time and whole, because that is how the socket delivers them
 * and because an escape sequence that spans two of them is the interesting
 * case.
 */
async function replay(version?: string): Promise<PaneTerminal> {
  const terminal = createPaneTerminal('dark');
  open.push(terminal);
  if (version !== undefined) terminal.unicode.activeVersion = version;
  for (const chunk of unicodeChunks) {
    await new Promise<void>((resolve) => {
      terminal.write(chunk, resolve);
    });
  }
  return terminal;
}

interface Cell {
  readonly chars: string;
  readonly width: number;
}

function cellAt(terminal: PaneTerminal, row: number, column: number): Cell {
  const line = terminal.buffer.active.getLine(row);
  if (!line) throw new Error(`the replay left no row ${String(row)}`);
  const cell = line.getCell(column);
  if (!cell) throw new Error(`row ${String(row)} has no column ${String(column)}`);
  return { chars: cell.getChars(), width: cell.getWidth() };
}

/** The column of the rightmost cell on a row that holds anything but space. */
function lastDrawnColumn(terminal: PaneTerminal, row: number): number {
  for (let column = terminal.cols - 1; column >= 0; column -= 1) {
    const { chars } = cellAt(terminal, row, column);
    if (chars !== '' && chars !== ' ') return column;
  }
  throw new Error(`row ${String(row)} is blank`);
}

describe('the pane terminal', () => {
  it('measures with the Unicode 11 table the addon registers', async () => {
    const terminal = await replay();

    expect(terminal.unicode.activeVersion).toBe('11');
    // The built-in table is still there to fall back to, which is what the
    // tearing test below flips to. Registering is not activating.
    expect([...terminal.unicode.versions]).toContain('6');
  });

  it('measures the panel: an emoji two columns, box drawing one, CJK two', async () => {
    const terminal = await replay();

    expect(cellAt(terminal, PANEL_BODY, 2)).toEqual({ chars: '\u{1F9D1}', width: 2 });
    // A wide glyph owns the cell after it, which holds nothing and is zero
    // wide. That is how a buffer says two columns.
    expect(cellAt(terminal, PANEL_BODY, 3)).toEqual({ chars: '', width: 0 });
    expect(cellAt(terminal, PANEL_TOP, 3)).toEqual({ chars: '日', width: 2 });
    expect(cellAt(terminal, PANEL_TOP, 0)).toEqual({ chars: '┌', width: 1 });
  });

  it('keeps the panel border in one column on every row', async () => {
    const terminal = await replay();

    expect(lastDrawnColumn(terminal, PANEL_TOP)).toBe(RIGHT_BORDER);
    expect(lastDrawnColumn(terminal, PANEL_BODY)).toBe(RIGHT_BORDER);
    expect(lastDrawnColumn(terminal, PANEL_BOTTOM)).toBe(RIGHT_BORDER);
    expect(cellAt(terminal, PANEL_BODY, RIGHT_BORDER).chars).toBe('│');
  });

  it('tears that border on the Unicode 6 table the addon replaces', async () => {
    // The same bytes, measured the way an unconfigured xterm measures them.
    // This is the bug in one line: the row with the emoji on it ends one
    // column short of the rows above and below, so the panel's right edge
    // steps left and back again down the screen.
    const terminal = await replay('6');

    expect(cellAt(terminal, PANEL_BODY, 2)).toEqual({ chars: '\u{1F9D1}', width: 1 });
    expect(lastDrawnColumn(terminal, PANEL_TOP)).toBe(RIGHT_BORDER);
    expect(lastDrawnColumn(terminal, PANEL_BODY)).toBe(RIGHT_BORDER - 1);
  });

  it('measures an emoji ZWJ sequence as its two wide halves', async () => {
    const terminal = await replay();

    // Unicode 11 supplies widths, not grapheme segmentation: xterm keeps the
    // joiner with the codepoint before it and lays the two emoji out as two
    // wide cells, so the sequence takes four columns where a terminal that
    // clusters graphemes paints it in two. Four is what this build does; the
    // cluster is @xterm/addon-unicode-graphemes' job, and it is not loaded.
    // Pinned rather than argued with, so that loading it is a visible change.
    expect(cellAt(terminal, ZWJ_LINE, 0).width).toBe(2);
    expect(cellAt(terminal, ZWJ_LINE, 2)).toEqual({ chars: '\u{1F4BB}', width: 2 });
    expect(cellAt(terminal, ZWJ_LINE, 4).chars).toBe('│');
  });
});

/** One call to `window.open`, as the emulator made it. */
interface OpenedWindow {
  readonly url: string;
  readonly target: string;
  readonly features: string;
}

interface RecordingOpener extends WindowOpener {
  readonly opened: readonly OpenedWindow[];
}

function createRecordingOpener(): RecordingOpener {
  const opened: OpenedWindow[] = [];
  return {
    open(url: string, target: string, features: string): void {
      opened.push({ url, target, features });
    },
    get opened(): readonly OpenedWindow[] {
      return [...opened];
    },
  };
}

/** What a click on a link the pane drew should produce, every time. */
function inNewTab(url: string): OpenedWindow {
  return { url, target: '_blank', features: 'noopener,noreferrer' };
}

async function writeLine(terminal: PaneTerminal, text: string): Promise<void> {
  await new Promise<void>((resolve) => {
    terminal.write(`${text}\r\n`, resolve);
  });
}

describe('fitting the pane to its box', () => {
  it('measures nothing it cannot measure, and leaves the grid where it was', () => {
    const terminal = createPaneTerminal('dark');
    open.push(terminal);
    const fit = createPaneFit(terminal);
    const before = { cols: terminal.cols, rows: terminal.rows };

    // A terminal with no element is what a pane in a collapsed layout cell,
    // or one whose emulator has not been drawn yet, looks like to the addon.
    expect(() => fit()).not.toThrow();

    // Unchanged, rather than clamped to the two-column minimum the addon's
    // arithmetic would produce from a box of nothing. The size this produces
    // is the size a process on another machine lays its screen out against,
    // and a guess is worse for that process than being left alone.
    expect({ cols: terminal.cols, rows: terminal.rows }).toEqual(before);
  });

  it('reports the grid it settles on, which is what crosses the wire', () => {
    const terminal = createPaneTerminal('dark');
    open.push(terminal);
    createPaneFit(terminal);
    const reported: { cols: number; rows: number }[] = [];
    terminal.onResize(({ cols, rows }) => reported.push({ cols, rows }));

    terminal.resize(100, 30);
    // The same size again: a resize to the grid it already has is not a
    // change, and a pane that sent one would be telling a pty about a window
    // that did not move.
    terminal.resize(100, 30);

    expect(reported).toEqual([{ cols: 100, rows: 30 }]);
  });
});

describe('a link in terminal output', () => {
  it('opens http and https in a new tab the opened page cannot reach back through', () => {
    const opener = createRecordingOpener();
    const click = createWebLinkHandler(opener);

    click(new MouseEvent('click'), 'https://example.com/repo/pull/1?tab=files');
    click(new MouseEvent('click'), 'http://127.0.0.1:8080/health');
    // A scheme is case-insensitive, and the parser is what says so: the pane
    // does not lowercase anything itself.
    click(new MouseEvent('click'), 'HTTPS://example.com');

    expect(opener.opened).toEqual([
      inNewTab('https://example.com/repo/pull/1?tab=files'),
      inNewTab('http://127.0.0.1:8080/health'),
      // The parsed URL, not the matched text: normalising is the parser's,
      // and what reaches the browser is what the parser accepted.
      inNewTab('https://example.com/'),
    ]);
  });

  it('opens nothing else, whatever an agent printed', () => {
    const opener = createRecordingOpener();
    const click = createWebLinkHandler(opener);

    // Terminal output is another program's bytes. These are what a click
    // would have to refuse if one of them ever reached the handler: script in
    // this origin, a local read, an inline document, a mail client, and text
    // that is not a URL at all.
    for (const uri of [
      'javascript:alert(document.cookie)',
      'JavaScript:alert(1)',
      'file:///etc/passwd',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'mailto:someone@example.com',
      'vscode://file/Users/someone/secrets',
      'example.com/not-a-url',
      '',
    ]) {
      click(new MouseEvent('click'), uri);
    }

    expect(opener.opened).toEqual([]);
  });

  it('is found in the buffer by the provider the pane registers, and opened by that click', async () => {
    const opener = createRecordingOpener();
    // The registration is the half this module owns that no buffer shows:
    // what the addon does on load is call this, and a pane that loaded no
    // addon would leave a URL as the inert text this ticket came from. xterm
    // offers no way to ask a terminal which providers it holds, so the call
    // is watched where it is made. The count matters as much as the argument:
    // one provider, the addon's.
    const registrations = vi.spyOn(Terminal.prototype, 'registerLinkProvider');
    const terminal = createPaneTerminal('dark', opener);
    open.push(terminal);

    await writeLine(terminal, 'cloning https://example.com/some/repo and then building');

    expect(registrations).toHaveBeenCalledTimes(1);
    const provider = registrations.mock.calls[0]?.[0];
    if (!provider) throw new Error('the pane registered no link provider');
    // Rows are 1-based here, unlike the buffer's own indexing above.
    const links = await new Promise<ILink[] | undefined>((resolve) => {
      provider.provideLinks(1, resolve);
    });

    expect(links?.map((link) => link.text)).toEqual(['https://example.com/some/repo']);
    const link = links?.[0];
    if (!link) throw new Error('the provider found no link in the line it was given');
    link.activate(new MouseEvent('click'), link.text);

    expect(opener.opened).toEqual([inNewTab('https://example.com/some/repo')]);
  });
});

/**
 * What a find in a pane turns up, driven against the same captured pty output
 * the chunk feed's tests replay.
 *
 * These open a terminal, which the tests above deliberately do not: a search
 * selects what it finds, and selection is a thing only an opened terminal
 * has -- unopened, `findNext` reaches for a selection service that is not
 * there. Opening in jsdom costs a `matchMedia` stub and a warning about
 * canvas from the renderer, and gives a real buffer with real scrollback
 * above it, which is the half being searched.
 *
 * The fixture is replayed five times over, the way a command re-run leaves
 * five of its output in a session. Five copies of a six-line capture in a
 * twenty-four-row terminal is the point: the early matches are above the
 * screen, so a search that only looked at what is visible would report fewer
 * than it finds here.
 */

const REPLAYS = 5;
/** How many times the fixture says `refresh`, once per replay. */
const REFRESH_MATCHES = REPLAYS;

/** Mantine and xterm both consult the media query; jsdom implements none. */
function installMatchMedia(): void {
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

interface SearchablePane {
  readonly terminal: PaneTerminal;
  readonly search: TerminalSearch;
  /** Every result the search published, in order. */
  readonly results: readonly SearchResults[];
  readonly latest: () => SearchResults | undefined;
}

async function replayIntoOpenPane(): Promise<SearchablePane> {
  installMatchMedia();
  const container = document.createElement('div');
  document.body.append(container);
  mounted.push(container);
  const terminal = createPaneTerminal('dark');
  open.push(terminal);
  terminal.open(container);
  const search = createPaneSearch(terminal, 'dark');
  const results: SearchResults[] = [];
  search.onResults((next) => results.push(next));
  for (let replay = 0; replay < REPLAYS; replay += 1) {
    for (const chunk of ptyChunks) {
      await new Promise<void>((resolve) => {
        terminal.write(chunk, resolve);
      });
    }
  }
  return { terminal, search, results, latest: () => results.at(-1) };
}

describe('a find in the pane', () => {
  it('reaches the scrollback, not just the screen', async () => {
    const pane = await replayIntoOpenPane();

    expect(pane.search.findNext('refresh')).toBe(true);
    expect(pane.latest()).toEqual({ index: 0, count: REFRESH_MATCHES });
    expect(pane.terminal.getSelection()).toBe('refresh');
    // The first match is above the viewport: `baseY` is where the screen
    // starts in the buffer, and the selected row is before it. This is the
    // whole claim of the ticket in one assertion.
    const position = pane.terminal.getSelectionPosition();
    expect(position?.start.y).toBeLessThan(pane.terminal.buffer.active.baseY);
  });

  it('steps forward and back through the matches it found', async () => {
    const pane = await replayIntoOpenPane();

    pane.search.findNext('refresh');
    expect(pane.search.findNext('refresh')).toBe(true);
    expect(pane.latest()).toEqual({ index: 1, count: REFRESH_MATCHES });
    expect(pane.search.findPrevious('refresh')).toBe(true);
    expect(pane.latest()).toEqual({ index: 0, count: REFRESH_MATCHES });
  });

  it('ignores case unless asked, and then means it', async () => {
    const pane = await replayIntoOpenPane();

    expect(pane.search.findNext('REFRESH')).toBe(true);
    expect(pane.latest()).toEqual({ index: 0, count: REFRESH_MATCHES });

    // The same term, case-sensitive: the capture is lowercase, so there is
    // nothing to find and nothing to count. Without the clear the seam does
    // before an options change this reports five matches while finding none
    // -- the addon stores the new options as the last options before asking
    // whether they changed, so its own answer is always no.
    expect(pane.search.findNext('REFRESH', { caseSensitive: true })).toBe(false);
    expect(pane.latest()).toEqual({ index: -1, count: 0 });

    expect(pane.search.findNext('REFRESH')).toBe(true);
    expect(pane.latest()).toEqual({ index: 0, count: REFRESH_MATCHES });
  });

  it('says nothing was found rather than nothing at all', async () => {
    const pane = await replayIntoOpenPane();

    expect(pane.search.findNext('a word this session never printed')).toBe(false);
    expect(pane.latest()).toEqual({ index: -1, count: 0 });
  });

  it('clearing takes back the highlights, the selection and the count', async () => {
    const pane = await replayIntoOpenPane();
    pane.search.findNext('refresh');

    pane.search.clear();

    expect(pane.latest()).toEqual({ index: -1, count: 0 });
    // Clearing the addon's decorations leaves the match selected; the seam
    // clears the selection too, so a closed find bar leaves no trace.
    expect(pane.terminal.getSelection()).toBe('');
  });

  it('stops publishing to a listener that unsubscribed, as a closed bar does', async () => {
    const pane = await replayIntoOpenPane();
    const heard: SearchResults[] = [];
    const stop = pane.search.onResults((results) => heard.push(results));

    pane.search.findNext('refresh');
    stop();
    pane.search.findNext('refresh');

    expect(heard).toEqual([{ index: 0, count: REFRESH_MATCHES }]);
  });

  it('counts nothing without decorations, which is why the seam always sends them', async () => {
    // Upstream behaviour, pinned rather than argued with: the result event
    // fires only for a search that carried decoration options, and the index
    // it reports is read off the decoration created for the selected match.
    // A find bar showing "3 of 12" is therefore a find bar that highlights;
    // there is no third option, and this test fails the day there is one.
    const pane = await replayIntoOpenPane();
    const bare = new SearchAddon();
    pane.terminal.loadAddon(bare);
    const heardBare: unknown[] = [];
    bare.onDidChangeResults((event) => heardBare.push(event));

    expect(bare.findNext('refresh')).toBe(true);
    expect(heardBare).toEqual([]);

    // A second addon rather than a second call on that one: the addon caches
    // the term it highlighted and will not recompute for the same term, so
    // the same instance asked again with decorations answers zero. The seam
    // works around that by clearing; this test is about the decorations, so
    // it asks something that has never been asked. The selection goes first
    // because a search starts from it, and the search above left one behind.
    pane.terminal.clearSelection();
    const decorated = new SearchAddon();
    pane.terminal.loadAddon(decorated);
    const heard: unknown[] = [];
    decorated.onDidChangeResults((event) => heard.push(event));

    expect(decorated.findNext('refresh', { decorations: paneSearchDecorations('dark') })).toBe(
      true,
    );
    expect(heard).toEqual([{ resultIndex: 0, resultCount: REFRESH_MATCHES }]);
  });
});

/**
 * What a paste puts on the wire, against bytes from a shell that really asked
 * for bracketed paste.
 *
 * The wrapping is the whole reason this is tested against a capture rather
 * than by asserting that the seam calls xterm's `paste`. Whether a paste is
 * wrapped depends on a mode set by the program at the far end, and this pane
 * learns about that mode only by parsing bytes somebody else sent. So the
 * question worth asking is the round trip: replay what a real line editor
 * printed, paste, and read what would go into a `terminal-input` frame. A
 * hand-written `ESC[?2004h` would be this repository asking itself a question
 * it had already answered -- and the fixture guard below is what keeps the
 * capture honest if anybody ever re-runs it against a shell without a line
 * editor.
 *
 * These open a terminal for the reason the find tests do, plus one of their
 * own: a paste is delivered through the hidden textarea, which `open` creates.
 */

/** `ESC[200~` and `ESC[201~`: what brackets a paste for a program that asked. */
const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

/** Writes chunks and waits for the parser, rather than for a timer. */
async function feed(terminal: PaneTerminal, chunks: readonly Uint8Array[]): Promise<void> {
  for (const chunk of chunks) {
    await new Promise<void>((resolve) => {
      terminal.write(chunk, resolve);
    });
  }
}

interface PastePane {
  readonly terminal: PaneTerminal;
  readonly emulator: TerminalEmulator;
  /** Everything the emulator has sent out through onData, in order. */
  readonly sent: readonly string[];
}

async function openPaneEmulator(replay: readonly Uint8Array[]): Promise<PastePane> {
  installMatchMedia();
  const container = document.createElement('div');
  document.body.append(container);
  mounted.push(container);
  const terminal = createPaneTerminal('dark');
  open.push(terminal);
  terminal.open(container);
  // Replayed before the seam is wrapped around it, so the mode is already set
  // by the time anything is pasted -- which is the order it happens in a pane,
  // where output has been arriving for as long as the session has been open.
  await feed(terminal, replay);
  const emulator = createPaneEmulator(terminal, 'dark');
  const sent: string[] = [];
  emulator.onData((data) => sent.push(data));
  return { terminal, emulator, sent };
}

describe('a paste into the pane', () => {
  it('is what the capture is of: a real shell asking for bracketed paste', async () => {
    // Guards the fixture, not the seam. A re-capture against a shell whose
    // line editor never came up would write bytes that quietly test nothing,
    // and every assertion below would go on passing by agreeing with itself.
    const terminal = createPaneTerminal('dark');
    open.push(terminal);

    expect(terminal.modes.bracketedPasteMode).toBe(false);
    await feed(terminal, bracketedPasteChunks);

    expect(terminal.modes.bracketedPasteMode).toBe(true);
  });

  it('wraps the text the way the program that asked for it expects', async () => {
    const pane = await openPaneEmulator(bracketedPasteChunks);

    pane.emulator.paste('git commit --amend');

    expect(pane.sent).toEqual([`${PASTE_START}git commit --amend${PASTE_END}`]);
  });

  it('sends the text bare when nothing asked for the markers', async () => {
    // The same paste into a terminal nothing has configured: a program that
    // never asked for bracketed paste must not be handed escape sequences it
    // would print as text.
    const pane = await openPaneEmulator([]);

    pane.emulator.paste('git commit --amend');

    expect(pane.sent).toEqual(['git commit --amend']);
  });

  it('normalises line endings to the carriage return a terminal sends', async () => {
    // What comes off a clipboard is whatever produced it: a browser on Windows
    // gives CRLF, an editor gives LF, and neither is what a terminal delivers
    // for the Enter key. Inside the markers, so a shell still runs none of it
    // until the whole paste has arrived.
    const pane = await openPaneEmulator(bracketedPasteChunks);

    pane.emulator.paste('first\nsecond\r\nthird');

    expect(pane.sent).toEqual([`${PASTE_START}first\rsecond\rthird${PASTE_END}`]);
  });

  it('reads back the selection the user dragged out, and not the grid it was drawn on', async () => {
    // The selection the copy chord copies. Made with the terminal's own select
    // rather than a mouse drag, which is the browser's half; what this pins is
    // that the seam answers text -- rows rejoined, without the spaces each one
    // is padded out to the width of the screen with.
    const pane = await openPaneEmulator(ptyChunks);

    pane.terminal.selectAll();

    expect(pane.emulator.selection()).toContain('refresh token rotates');
    expect(pane.emulator.selection()).not.toContain('   \n');
  });

  it('has nothing selected to begin with, which is a copy with nothing to copy', async () => {
    const pane = await openPaneEmulator(ptyChunks);

    expect(pane.emulator.selection()).toBe('');
  });
});
