/**
 * The emulator seam: what the terminal pane needs from xterm, and no more.
 *
 * An interface rather than the xterm Terminal class, for the same reason the
 * server's pty is an interface: constructing the real thing needs a DOM
 * element and a renderer, neither of which a unit test can supply, and every
 * rule worth testing here — replay order, whole-chunk trimming, the attach
 * lifecycle — is about what flows through the seam, not about how xterm
 * paints. `xterm-emulator.ts` is the implementation; `fake-emulator.ts` is
 * the one tests drive.
 *
 * Bytes are `Uint8Array` on the way in and never React state on the way
 * anywhere: output goes socket to feed to emulator through `write`, and the
 * only thing React ever holds is the ref-callback that wired them together.
 */

/** Anything terminal output can be written into. */
export interface EmulatorSink {
  write(chunk: Uint8Array): void;
}

/**
 * How many lines of output the emulator keeps behind the screen, and
 * therefore the whole of what a search can reach.
 *
 * Here rather than in the xterm module because two things need it and only
 * one of them is xterm: the terminal's `scrollback` option, and the sentence
 * the find bar shows when the beginning of a session is gone. A find that
 * says "no matches" over a buffer whose first hour was dropped is answering a
 * question nobody asked, so the number that bounds the answer is stated where
 * both the bound and the sentence can read it.
 */
export const EMULATOR_SCROLLBACK_LINES = 5_000;

/** How a search differs from the plain one, which is the one users want. */
export interface SearchOptions {
  /** Default false: a find is case-insensitive unless the user says otherwise. */
  readonly caseSensitive?: boolean;
  /**
   * Whether this search is the user still typing. An incremental search keeps
   * the match it is already standing on while the term still matches it, so
   * the view does not run one match further down the buffer per keystroke.
   * Honoured on `findNext` only, which is why the bar types forwards.
   */
  readonly incremental?: boolean;
}

/** What a search found, as the bar reports it: "3 of 12". */
export interface SearchResults {
  /** Which match is selected, counting from zero, or -1 when none is. */
  readonly index: number;
  readonly count: number;
}

/** Nothing found, and nothing standing on: what `clear` publishes. */
export const NO_RESULTS: SearchResults = { index: -1, count: 0 };

/**
 * Finding text in what the emulator holds, which is the screen and the
 * scrollback above it and nothing else. The hub holds no index and the
 * protocol carries no search frame: this searches the bytes that already
 * reached this pane.
 */
export interface TerminalSearch {
  /** Selects the next match below the current one. Whether one was found. */
  findNext(query: string, options?: SearchOptions): boolean;
  /** The same, upwards. */
  findPrevious(query: string, options?: SearchOptions): boolean;
  /** Drops the highlights and the selection: the pane as it was before the find. */
  clear(): void;
  /**
   * Every change in what the current query matches. The returned function
   * stops the listening -- unlike `onData`, whose listener is the pane's for
   * the pane's whole life, this one belongs to a find bar that opens and
   * closes many times over one emulator.
   */
  onResults(listener: (results: SearchResults) => void): () => void;
}

/** The live emulator, as the pane drives it. */
export interface TerminalEmulator extends EmulatorSink {
  /** Keystrokes, as xterm encoded them. Arrow keys and Enter are sequences. */
  onData(listener: (data: string) => void): void;
  focus(): void;
  dispose(): void;
  /** Finding text in the scrollback this emulator holds. */
  readonly search: TerminalSearch;
}

/**
 * Builds one emulator into one container. Injected into the terminal view so
 * a test can hand it a fake; the default is the xterm factory.
 */
export interface EmulatorFactory {
  create(container: HTMLElement): TerminalEmulator;
}
