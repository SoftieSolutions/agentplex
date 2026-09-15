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
  readonly focused: number;
  readonly disposed: boolean;
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
      let focused = 0;
      let disposed = false;
      const search = createFakeSearch();
      const emulator: FakeEmulator = {
        search,
        write(chunk: Uint8Array): void {
          written.push(chunk);
        },
        onData(listener: (data: string) => void): void {
          listeners.push(listener);
        },
        focus(): void {
          focused += 1;
        },
        dispose(): void {
          disposed = true;
        },
        type(data: string): void {
          for (const listener of [...listeners]) listener(data);
        },
        get written(): readonly Uint8Array[] {
          return [...written];
        },
        get focused(): number {
          return focused;
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
