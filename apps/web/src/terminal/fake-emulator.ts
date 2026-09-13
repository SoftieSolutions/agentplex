import type { TerminalSize } from '@agentplex/protocol';
import {
  NO_RESULTS,
  type EmulatorFactory,
  type SearchOptions,
  type SearchResults,
  type TerminalEmulator,
  type TerminalSearch,
} from './emulator.js';

/** One search the bar asked for, as the fake recorded it. */
export interface RecordedSearch {
  readonly direction: 'next' | 'previous';
  readonly query: string;
  readonly options: SearchOptions | undefined;
}

/**
 * A `TerminalSearch` with no buffer behind it: it records what was asked and
 * lets the test say what was found. Which is the whole of what a find bar can
 * be held to -- the bar asks a question and renders an answer, and whether
 * the answer is right is the emulator's test, against real bytes.
 */
export interface FakeSearch extends TerminalSearch {
  readonly searches: readonly RecordedSearch[];
  readonly cleared: number;
  /** The emulator answering: fires every listener the bar registered. */
  report(results: SearchResults): void;
  /** Whether anything is currently listening, so a test can see the unsubscribe. */
  readonly listening: number;
}

export function createFakeSearch(): FakeSearch {
  const searches: RecordedSearch[] = [];
  const listeners = new Set<(results: SearchResults) => void>();
  let cleared = 0;
  return {
    findNext(query: string, options?: SearchOptions): boolean {
      searches.push({ direction: 'next', query, options });
      return true;
    },
    findPrevious(query: string, options?: SearchOptions): boolean {
      searches.push({ direction: 'previous', query, options });
      return true;
    },
    clear(): void {
      cleared += 1;
      for (const listener of [...listeners]) listener(NO_RESULTS);
    },
    onResults(listener: (results: SearchResults) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    report(results: SearchResults): void {
      for (const listener of [...listeners]) listener(results);
    },
    get searches(): readonly RecordedSearch[] {
      return [...searches];
    },
    get cleared(): number {
      return cleared;
    },
    get listening(): number {
      return listeners.size;
    },
  };
}

/**
 * A `TerminalEmulator` a test can read: it records every chunk written and
 * lets the test play the user typing. No xterm, no DOM measurement — which is
 * the point of the seam.
 */
export interface FakeEmulator extends TerminalEmulator {
  readonly search: FakeSearch;
  readonly written: readonly Uint8Array[];
  /** The user typing: fires whatever onData listener the view wired up. */
  type(data: string): void;
  /** The user having dragged across output, which `selection` then answers. */
  select(text: string): void;
  /**
   * Every text the pane handed to `paste`, in order.
   *
   * Recorded verbatim, and fired at the onData listener verbatim: this fake
   * normalises nothing and wraps nothing. What a paste turns into is xterm's
   * answer and depends on a mode only a real parser can be in, so the fake
   * inventing a bracketed form would be the test agreeing with itself about
   * the one thing worth capturing bytes for. `xterm-emulator.test.ts` holds
   * the real one to that, against a pty that really set the mode.
   */
  readonly pasted: readonly string[];
  readonly focused: number;
  readonly disposed: boolean;
  /**
   * Every distance the pane asked this emulator to move through the
   * scrollback, in CSS pixels and in order.
   *
   * Pixels and not lines, because pixels are what crosses the seam: what a
   * drag of 40px is in lines depends on a cell height only a real layout has,
   * and a fake that answered with lines would be inventing the one number
   * this seam exists to keep on the emulator's side.
   */
  readonly scrolledPixels: readonly number[];
  /** How many times the pane asked this emulator to re-measure its box. */
  readonly fitted: number;
  /**
   * The fit count as it stood when the first byte arrived, or `null` while
   * nothing has been written.
   *
   * A count frozen at a moment rather than a log of calls, because the only
   * ordering worth holding the attach to is this one: a replay written into
   * an emulator nobody has fitted is reflowed at 80x24 and then again at the
   * size the pane actually has, and a user sees it straighten itself out.
   * Zero here is that bug; anything else is the pane having measured first.
   */
  readonly fitsBeforeFirstWrite: number | null;
  /**
   * The emulator having taken a new size: fires whatever onResize listener
   * the view wired up.
   *
   * Driven by the test rather than by `fit`, because that is how the real one
   * behaves -- a fit that finds the same grid reports nothing, and a program
   * asking for a size through an escape sequence reports one nobody fitted.
   */
  resizeTo(size: TerminalSize): void;
}

export interface FakeEmulatorFactory extends EmulatorFactory {
  readonly created: readonly FakeEmulator[];
}

export function createFakeEmulatorFactory(): FakeEmulatorFactory {
  const created: FakeEmulator[] = [];
  return {
    create(): FakeEmulator {
      const written: Uint8Array[] = [];
      const listeners: ((data: string) => void)[] = [];
      const resized: ((size: TerminalSize) => void)[] = [];
      const pasted: string[] = [];
      let focused = 0;
      let fitted = 0;
      let fitsBeforeFirstWrite: number | null = null;
      let disposed = false;
      let selected = '';
      const scrolledPixels: number[] = [];
      const search = createFakeSearch();
      const emulator: FakeEmulator = {
        search,
        write(chunk: Uint8Array): void {
          fitsBeforeFirstWrite ??= fitted;
          written.push(chunk);
        },
        onData(listener: (data: string) => void): void {
          listeners.push(listener);
        },
        selection(): string {
          return selected;
        },
        paste(text: string): void {
          pasted.push(text);
          // Out through onData, because that is where the real one sends it:
          // a paste is input, and it leaves by the path typing leaves by.
          for (const listener of [...listeners]) listener(text);
        },
        focus(): void {
          focused += 1;
        },
        scrollPixels(pixels: number): void {
          scrolledPixels.push(pixels);
        },
        dispose(): void {
          disposed = true;
        },
        fit(): void {
          fitted += 1;
        },
        onResize(listener: (size: TerminalSize) => void): void {
          resized.push(listener);
        },
        type(data: string): void {
          for (const listener of [...listeners]) listener(data);
        },
        select(text: string): void {
          selected = text;
        },
        resizeTo(size: TerminalSize): void {
          for (const listener of [...resized]) listener(size);
        },
        get written(): readonly Uint8Array[] {
          return [...written];
        },
        get pasted(): readonly string[] {
          return [...pasted];
        },
        get focused(): number {
          return focused;
        },
        get scrolledPixels(): readonly number[] {
          return [...scrolledPixels];
        },
        get fitted(): number {
          return fitted;
        },
        get fitsBeforeFirstWrite(): number | null {
          return fitsBeforeFirstWrite;
        },
        get disposed(): boolean {
          return disposed;
        },
      };
      created.push(emulator);
      return emulator;
    },
    get created(): readonly FakeEmulator[] {
      return [...created];
    },
  };
}
