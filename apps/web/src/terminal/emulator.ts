import type { TerminalSize } from '@agentplex/protocol';

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
  /**
   * The text the user has selected in this pane, or `''` when none is.
   *
   * Selecting is the browser's and the emulator's between them: dragging over
   * output is DOM-level and works with nothing here involved. Reading back
   * what was selected is not, because a terminal's screen is a grid and the
   * string a user means by a selection -- rows rejoined, the padding to the
   * right of each line dropped -- is the emulator's answer and not the DOM's.
   * Nothing crosses the wire either way; the protocol has no notion of a
   * selection, and this is the reason it needs none.
   */
  selection(): string;
  /**
   * Text the user pasted, put in as a paste rather than as keystrokes.
   *
   * It leaves through the `onData` listener, like typing, and nothing about it
   * reaches the screen directly: what appears there is whatever the program at
   * the far end echoes back. Two things happen to it on the way out, and both
   * are the emulator's to decide rather than the pane's.
   *
   * Line endings are normalised to carriage returns, because a carriage return
   * is what a terminal sends for the Enter key; a pasted line feed delivered
   * as a line feed is a line a shell never sees the end of.
   *
   * And when the program has asked for bracketed paste, the text is wrapped in
   * the markers that let it tell a paste from typing -- so that an editor
   * indents nothing and a shell runs nothing until the whole thing has
   * arrived. Whether it asked is a mode the emulator holds because it parsed
   * the bytes that set it. The pane has no way to know it and no business
   * guessing at it, which is why the wrapping lives behind this seam rather
   * than in the caller.
   */
  paste(text: string): void;
  focus(): void;
  dispose(): void;
  /**
   * Moves the view through the scrollback by a distance in CSS pixels, the
   * way a finger asks for it. Positive is towards the newest output, the
   * direction `scrollTop` grows in.
   *
   * Pixels rather than lines, because the caller is a gesture and a gesture
   * measures in pixels. Turning that into lines needs the height of a cell,
   * which is a fact about a font measured in a real layout -- the emulator's
   * to know, and nothing a pane or a pointer handler could ask for without
   * measuring the emulator's own DOM on its behalf. What is left over after
   * the whole lines are taken is the emulator's to keep as well, so that a
   * slow drag moves at a finger's speed instead of losing a fraction of a
   * line on every event.
   *
   * It exists because xterm has no touch scrolling of its own. Its viewport
   * is not a scroll container -- `.xterm-viewport` is an empty element whose
   * scroll height is its client height, and the screen sits in a VS Code
   * `SmoothScrollableElement` whose scroll position is a number the renderer
   * repaints from. Measured in the built app: a freshly opened terminal
   * registers no `touchstart`, `touchmove` or `touchend` listener anywhere,
   * and the only pointer listeners are the four on its own scrollbar slider.
   * So a finger has nothing to drag but a 14px slider that is invisible until
   * it moves, and `touch-action: pan-y` would hand the pan to the page, which
   * has nothing to scroll either.
   */
  scrollPixels(pixels: number): void;
  /** Finding text in the scrollback this emulator holds. */
  readonly search: TerminalSearch;
  /**
   * Re-measures the container and takes the largest whole grid that fits it.
   *
   * A no-op while nothing can be measured -- a pane in a collapsed cell, a
   * terminal not yet laid out -- rather than a guess, because the size this
   * produces is the size the process on another machine lays its screen out
   * against, and a guessed 2x1 is worse for that process than being left
   * where it was.
   */
  fit(): void;
  /**
   * The grid this emulator now has, whenever it changes.
   *
   * The listener is the pane's for the pane's whole life, like `onData`: what
   * it does with a size is send it, and there is no version of the pane that
   * stops wanting to. The size is reported rather than returned by `fit`
   * because a resize can also come from the emulator itself -- a program
   * asking for one through an escape sequence -- and a pane that only watched
   * its own fits would miss those.
   */
  onResize(listener: (size: TerminalSize) => void): void;
}

/**
 * Builds one emulator into one container. Injected into the terminal view so
 * a test can hand it a fake; the default is the xterm factory.
 */
export interface EmulatorFactory {
  create(container: HTMLElement): TerminalEmulator;
}
