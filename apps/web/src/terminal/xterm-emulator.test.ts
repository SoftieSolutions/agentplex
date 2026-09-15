// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { unicodeChunks } from './unicode-widths.fixture.js';
import { createPaneTerminal } from './xterm-emulator.js';

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
