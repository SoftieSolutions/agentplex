import { TERMINAL_MAX_COLS, TERMINAL_MAX_ROWS, type TerminalSize } from '@agentplex/protocol';
import type { Timers } from '../store/timers.js';

/**
 * How a pane's own box becomes a size the process on another machine is told
 * about.
 *
 * Resize is the one thing on the copy/paste/select/scroll list that genuinely
 * crosses the wire, and it crosses in one direction only: the viewer measures
 * itself and says so. What makes it worth a module is that the measuring is
 * driven by the browser at whatever rate a divider is being dragged, and the
 * telling costs a frame on the wire, a `TIOCSWINSZ` on a machine somewhere
 * else, and -- the part that actually costs something -- a full repaint from
 * whatever TUI the agent is drawing, back down both legs.
 *
 * So there are three filters between a pointer moving and a frame leaving,
 * each at the only point that can see what it filters:
 *
 * 1. `watchFit` coalesces observations to one fit per animation frame. A drag
 *    produces an observation per frame at best and a burst of them at worst,
 *    and each fit is a re-measure of a real font in a real layout.
 * 2. The emulator reports a size only when the grid actually changed, so the
 *    many fits a drag produces become the few sizes it passes through.
 * 3. `createSizePacer` bounds what is left to one frame per settle window,
 *    plus the size it came to rest at. Without it a slow drag across a wide
 *    screen is one SIGWINCH per column crossed, each of which asks the agent
 *    to redraw its whole screen at a size the user is already past.
 *
 * Nothing in here touches React. The pane's element lifetime is the watch's
 * lifetime, which is what a ref callback with a cleanup already says; an
 * effect would tie it to a render instead.
 */

/**
 * A measured size, brought inside what a frame may carry -- or `null` when
 * what arrived is not a measurement at all.
 *
 * The protocol's bounds are larger than any real terminal, so the clamping
 * half changes nothing anyone will ever see, which is the point of doing it
 * anyway. A size is a number this client measured off a box a stylesheet
 * decided the size of, and a parser on the far end says no to a silly one.
 * Refusing to be the peer that sends one costs two comparisons; being it
 * costs the pane a refusal the user cannot act on.
 *
 * The `null` half is the case clamping cannot answer. A box with nothing in
 * it -- a pane in a collapsed cell, a terminal whose parent has no laid-out
 * height -- divides through to `NaN`, and `NaN` survives every `min` and
 * `max` written over it: `Math.min(1000, Math.max(1, NaN))` is `NaN`.
 * `JSON.stringify` then writes it as `null`, so the frame that leaves is one
 * the hub's parser refuses, for a reason the pane can do nothing about. A
 * measurement that is not a number is not a smaller measurement; there is
 * nothing to say, so nothing is said.
 *
 * Otherwise clamped rather than dropped, and never rounded up from zero: a
 * grid smaller than one cell is not a terminal.
 */
export function clampTerminalSize(size: TerminalSize): TerminalSize | null {
  if (!Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return null;
  return {
    cols: Math.min(TERMINAL_MAX_COLS, Math.max(1, Math.trunc(size.cols))),
    rows: Math.min(TERMINAL_MAX_ROWS, Math.max(1, Math.trunc(size.rows))),
  };
}

/** Whether two grids are the same grid. */
function sameSize(one: TerminalSize | null, other: TerminalSize): boolean {
  return one !== null && one.cols === other.cols && one.rows === other.rows;
}

/**
 * How long a size has to stand still before the one after it may be sent.
 *
 * Short enough that letting go of a divider and looking at the pane is not a
 * wait -- a person notices a delay somewhere north of this -- and long enough
 * that a drag across a screen is a handful of frames rather than one per
 * column. It bounds the wire rather than the screen: the local grid follows
 * the box every frame regardless, because that is a fit and not a frame.
 */
export const RESIZE_SETTLE_MS = 100;

/** Sizes on their way out, at a rate a pty on another machine can be told at. */
export interface SizePacer {
  /** A size the emulator settled on. Sent now, or when the window closes. */
  report(size: TerminalSize): void;
  /** Drops anything still waiting: a pane that is gone has nothing to say. */
  stop(): void;
}

export interface SizePacerDependencies {
  readonly timers: Timers;
  send(size: TerminalSize): void;
}

/**
 * Leading edge immediately, then at most one per window, and always the size
 * it came to rest at.
 *
 * The leading edge is why this is not a plain trailing debounce. The first
 * size a pane produces is the one the far end most needs -- it is the size
 * the pane opened at, and until it arrives the agent is drawing against 80x24
 * -- and a pane that opened a tenth of a second ago has not "settled" in any
 * sense a debounce could tell from a drag. So the first one goes at once and
 * the window exists to bound what follows it.
 *
 * The trailing edge is why this is not a plain throttle. A drag that ends
 * inside a window would otherwise leave the far end at the second-to-last
 * size for good, which is the one state a user can see is wrong and cannot
 * fix without moving the divider again.
 *
 * A size equal to the one already sent is not sent, and cancels a trailing
 * send that would have restated it: a drag that comes back to where it
 * started ends with the far end already there.
 */
export function createSizePacer({ timers, send }: SizePacerDependencies): SizePacer {
  let sent: TerminalSize | null = null;
  let waiting: TerminalSize | null = null;
  let closeWindow: (() => void) | null = null;

  function put(size: TerminalSize): void {
    sent = size;
    send(size);
    closeWindow = timers.schedule(RESIZE_SETTLE_MS, () => {
      closeWindow = null;
      const held = waiting;
      waiting = null;
      if (held !== null) put(held);
    });
  }

  return {
    report(size: TerminalSize): void {
      if (sameSize(sent, size)) {
        waiting = null;
        return;
      }
      if (closeWindow === null) {
        put(size);
        return;
      }
      waiting = size;
    },
    stop(): void {
      closeWindow?.();
      closeWindow = null;
      waiting = null;
    },
  };
}

/**
 * Watching one element's box. `ResizeObserver` in the browser; a test drives
 * the callback itself, because jsdom has no observer and a fake one would be
 * the thing under test.
 */
export interface BoxObservers {
  /** Starts watching, and returns the stop. The first observation is the box as it is. */
  observe(element: HTMLElement, changed: () => void): () => void;
}

/** The real one. */
export const browserBoxObservers: BoxObservers = {
  observe(element: HTMLElement, changed: () => void): () => void {
    const observer = new ResizeObserver(() => changed());
    observer.observe(element);
    return () => observer.disconnect();
  },
};

/**
 * Work put off until the next frame. `requestAnimationFrame` in the browser,
 * which is the right clock for this: the box is a layout fact, and a fit that
 * ran between two layouts would measure the one that is on its way out.
 */
export interface FrameScheduler {
  /** Runs once, a frame from now. The returned function cancels it. */
  schedule(run: () => void): () => void;
}

/** The real one. */
export const browserFrames: FrameScheduler = {
  schedule(run: () => void): () => void {
    const handle = requestAnimationFrame(() => run());
    return () => cancelAnimationFrame(handle);
  },
};

export interface FitWatchDependencies {
  /** The element the emulator was built into, whose box is the grid. */
  readonly element: HTMLElement;
  /** Only the fit: this has no business writing bytes or disposing anything. */
  readonly emulator: { fit(): void };
  readonly boxes: BoxObservers;
  readonly frames: FrameScheduler;
}

/**
 * Keeps one emulator fitted to one element, and returns the stop.
 *
 * The first fit happens here, synchronously, before this function returns.
 * That is the load-bearing half and it is worth saying why, because the
 * obvious alternative is to let the observer's first delivery be the first
 * fit and it is wrong. A `ResizeObserver` delivers asynchronously -- at the
 * end of a frame, after layout -- and this watch then puts the fit off by
 * another frame on top of that. Meanwhile the caller attaches the feed, and
 * the feed writes whatever the subscription replayed the moment it has an
 * emulator. An emulator that has not been fitted is 80x24, so the replay
 * would be reflowed twice: once against a grid the pane never had, and again
 * when the real one arrives a frame or two later. A user sees a screenful of
 * wrapped output straighten itself out. Measuring inside a ref callback
 * forces one layout, which is the price, and the element is in the document
 * with its cell already laid out by the time the callback runs.
 *
 * After that, one fit per frame however many observations arrive in it. A
 * divider being dragged produces an observation per frame at best and a burst
 * of them at worst, and each fit is a re-measure of a real font in a real
 * layout; the dropped ones in a burst were all superseded by the last, which
 * is the one this runs.
 *
 * Nothing here reports a size. The emulator does, when a fit actually changed
 * the grid -- which is why an extra fit costs a measurement and never a
 * frame, and why the observer's own first delivery landing on a grid this
 * already fitted is not worth preventing.
 */
export function watchFit({ element, emulator, boxes, frames }: FitWatchDependencies): () => void {
  let cancelFrame: (() => void) | null = null;

  const stopObserving = boxes.observe(element, () => {
    if (cancelFrame !== null) return;
    cancelFrame = frames.schedule(() => {
      cancelFrame = null;
      emulator.fit();
    });
  });

  emulator.fit();

  return () => {
    stopObserving();
    cancelFrame?.();
    cancelFrame = null;
  };
}
