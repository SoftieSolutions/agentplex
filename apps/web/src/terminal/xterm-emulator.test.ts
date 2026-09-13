// @vitest-environment jsdom
import { Terminal, type ILink } from '@xterm/xterm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unicodeChunks } from './unicode-widths.fixture.js';
import { createPaneTerminal, createWebLinkHandler, type WindowOpener } from './xterm-emulator.js';

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

afterEach(() => {
  while (open.length > 0) open.pop()?.dispose();
  vi.restoreAllMocks();
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
