import { TERMINAL_MAX_COLS, TERMINAL_MAX_ROWS, type TerminalSize } from '@agentplex/protocol';

/**
 * How a pane's own box becomes a size the process on another machine is told
 * about.
 *
 * Resize is the one thing on the copy/paste/select/scroll list that genuinely
 * crosses the wire, and it crosses in one direction only: the viewer measures
 * itself and says so. What makes it worth a module is that the measuring is
 * driven by the browser at whatever rate a window is being dragged, and the
 * telling costs a frame on the wire and a `TIOCSWINSZ` on a machine somewhere
 * else. So the observations are coalesced to one fit per frame here, and the
 * emulator reports a size only when one actually changed -- two filters, at
 * the two points that can see the difference between "the box moved" and "the
 * grid is now a different grid".
 *
 * Nothing in here touches React. The pane's element lifetime is the watch's
 * lifetime, which is what a ref callback with a cleanup already says; an
 * effect would tie it to a render instead.
 */

/**
 * A measured size, brought inside what a frame may carry.
 *
 * The protocol's bounds are larger than any real terminal, so this clamps
 * nothing anyone will ever see -- which is the point of doing it anyway. A
 * size is a number this client measured off a box a stylesheet decided the
 * size of, and a parser on the far end says no to a silly one. Refusing to be
 * the peer that sends one costs two comparisons; being it costs the pane its
 * subscription, with a refusal the user cannot act on.
 *
 * Clamped rather than dropped, and never rounded up from zero: a grid smaller
 * than one cell is not a terminal, and the emulator will not report one.
 */
export function clampTerminalSize(size: TerminalSize): TerminalSize {
  return {
    cols: Math.min(TERMINAL_MAX_COLS, Math.max(1, Math.trunc(size.cols))),
    rows: Math.min(TERMINAL_MAX_ROWS, Math.max(1, Math.trunc(size.rows))),
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
 * One fit per frame, however many observations arrive in it. A window being
 * dragged produces an observation per frame at best and a burst of them at
 * worst, and each fit is a re-measure of a real font in a real layout; the
 * dropped ones in a burst were all superseded by the last, which is the one
 * this runs.
 *
 * No initial fit of its own: an observer delivers the element's current box
 * as its first observation, so the first fit is the one that happens anyway.
 * A call here as well would be the same measurement twice, once before the
 * pane had been laid out.
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

  return () => {
    stopObserving();
    cancelFrame?.();
    cancelFrame = null;
  };
}
