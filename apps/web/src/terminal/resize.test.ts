// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { TERMINAL_MAX_COLS, TERMINAL_MAX_ROWS, type TerminalSize } from '@agentplex/protocol';
import { createFakeTimers, type FakeTimers } from '../store/timers.js';
import {
  clampTerminalSize,
  createSizePacer,
  RESIZE_SETTLE_MS,
  watchFit,
  type BoxObservers,
  type FrameScheduler,
} from './resize.js';

/**
 * Everything between a box changing and a pty being told: one fit per frame
 * however many observations arrive in it, one frame on the wire per settle
 * window however many grids a drag passes through, and nothing measured after
 * the element is gone.
 *
 * jsdom, for the elements and for nothing else. There is no `ResizeObserver`
 * here and a real one would be the thing under test rather than a tool for
 * testing something else — whether the browser fires is the browser's claim,
 * not this module's. So the observer, the frame clock and the settle clock
 * are all seams the test drives by hand, and the assertions are counts and
 * the sizes that left.
 */

/** An observer the test fires, per element, so "the box moved" is a call. */
interface FakeBoxes {
  readonly boxes: BoxObservers;
  /** One observation on one element, as the browser would deliver it. */
  move(element: HTMLElement): void;
  /** How many elements are currently watched. */
  readonly watching: number;
}

function fakeBoxes(): FakeBoxes {
  const watched = new Map<HTMLElement, () => void>();
  return {
    boxes: {
      observe(element, fire) {
        watched.set(element, fire);
        return () => watched.delete(element);
      },
    },
    move(element: HTMLElement): void {
      watched.get(element)?.();
    },
    get watching(): number {
      return watched.size;
    },
  };
}

/** Frames that only happen when the test says so. */
interface FakeFrames {
  readonly frames: FrameScheduler;
  run(): void;
  readonly pending: number;
}

function fakeFrames(): FakeFrames {
  let queued: (() => void)[] = [];
  return {
    frames: {
      schedule(run: () => void): () => void {
        queued.push(run);
        return () => {
          queued = queued.filter((waiting) => waiting !== run);
        };
      },
    },
    run(): void {
      for (const waiting of queued.splice(0)) waiting();
    },
    get pending(): number {
      return queued.length;
    },
  };
}

describe('clampTerminalSize', () => {
  it('leaves an ordinary terminal alone', () => {
    expect(clampTerminalSize({ cols: 120, rows: 40 })).toEqual({ cols: 120, rows: 40 });
  });

  it('brings a silly one inside what a frame may carry, rather than sending it', () => {
    expect(clampTerminalSize({ cols: 40_000, rows: 40_000 })).toEqual({
      cols: TERMINAL_MAX_COLS,
      rows: TERMINAL_MAX_ROWS,
    });
  });

  it('never proposes a grid smaller than one cell, which is not a terminal', () => {
    expect(clampTerminalSize({ cols: 0, rows: -3 })).toEqual({ cols: 1, rows: 1 });
  });

  it('takes whole cells: half a column is not a column', () => {
    expect(clampTerminalSize({ cols: 99.9, rows: 24.5 })).toEqual({ cols: 99, rows: 24 });
  });

  it('answers nothing at all for a measurement that is not a number', () => {
    // A box with no height divides through to NaN, and NaN survives every
    // min and max written over it -- then `JSON.stringify` writes it as
    // `null` and the hub refuses the frame. There is nothing to say here, so
    // nothing is said.
    expect(clampTerminalSize({ cols: Number.NaN, rows: 24 })).toBeNull();
    expect(clampTerminalSize({ cols: 80, rows: Number.NaN })).toBeNull();
    expect(clampTerminalSize({ cols: Number.POSITIVE_INFINITY, rows: 24 })).toBeNull();
  });
});

describe('createSizePacer', () => {
  function pacer(): { sent: TerminalSize[]; timers: FakeTimers; report(size: TerminalSize): void } {
    const sent: TerminalSize[] = [];
    const timers = createFakeTimers();
    const paced = createSizePacer({ timers, send: (size) => sent.push(size) });
    return { sent, timers, report: (size) => paced.report(size) };
  }

  it('sends the first size at once: a pane that just opened has not settled, it has opened', () => {
    const h = pacer();

    h.report({ cols: 100, rows: 30 });

    expect(h.sent).toEqual([{ cols: 100, rows: 30 }]);
    // And the window that bounds what follows it is the one this module
    // names, rather than whatever a test happened to inject.
    expect(h.timers.delays).toEqual([RESIZE_SETTLE_MS]);
  });

  it('sends one frame for a drag through many grids, and the one it came to rest at', () => {
    const h = pacer();

    // A divider dragged across a screen: every column crossed is a grid the
    // emulator really reached, and every one of them would be a SIGWINCH and
    // a full repaint from whatever the agent is drawing.
    for (let cols = 100; cols <= 140; cols += 1) h.report({ cols, rows: 30 });

    expect(h.sent).toEqual([{ cols: 100, rows: 30 }]);

    // The hand lets go; the window closes.
    h.timers.fireAll();

    expect(h.sent).toEqual([
      { cols: 100, rows: 30 },
      { cols: 140, rows: 30 },
    ]);
  });

  it('keeps sending while a drag goes on, so the far end is never a whole drag behind', () => {
    const h = pacer();

    h.report({ cols: 100, rows: 30 });
    h.report({ cols: 110, rows: 30 });
    h.timers.fireAll();
    h.report({ cols: 120, rows: 30 });
    h.timers.fireAll();

    expect(h.sent).toEqual([
      { cols: 100, rows: 30 },
      { cols: 110, rows: 30 },
      { cols: 120, rows: 30 },
    ]);
  });

  it('says nothing about a grid the far end is already drawing against', () => {
    const h = pacer();

    h.report({ cols: 100, rows: 30 });
    // A drag out and back: the pane passed through other grids and ended on
    // the one it started at, so there is nothing left to tell anybody.
    h.report({ cols: 140, rows: 30 });
    h.report({ cols: 100, rows: 30 });
    h.timers.fireAll();

    expect(h.sent).toEqual([{ cols: 100, rows: 30 }]);
    expect(h.timers.pending).toBe(0);
  });

  it('drops what was still on its way out when the pane goes', () => {
    const sent: TerminalSize[] = [];
    const timers = createFakeTimers();
    const paced = createSizePacer({ timers, send: (size) => sent.push(size) });

    paced.report({ cols: 100, rows: 30 });
    paced.report({ cols: 140, rows: 30 });
    paced.stop();
    timers.fireAll();

    // The trailing send is about a pane that no longer exists.
    expect(sent).toEqual([{ cols: 100, rows: 30 }]);
    expect(timers.pending).toBe(0);
  });
});

/**
 * One pane's whole chain, with the two things only a real browser has faked
 * at the two places they are: the box, and the clocks.
 *
 * The emulator here does what xterm does and no more -- a fit measures the
 * box, a box of nothing is not measured at all, and a size is reported only
 * when the grid actually changed. Those are the two filters the modules under
 * test are written around, so a harness that left them out would be asserting
 * against a straw emulator.
 */
interface Pane {
  readonly element: HTMLElement;
  /** What this pane's box now measures to, or `null` for a box of nothing. */
  show(grid: TerminalSize | null): void;
  readonly fits: number;
  readonly sent: readonly TerminalSize[];
  /** The element is gone: the watch and anything still on its way out stop. */
  close(): void;
}

function openPane(boxes: FakeBoxes, frames: FakeFrames, timers: FakeTimers): Pane {
  const element = document.createElement('div');
  const sent: TerminalSize[] = [];
  let box: TerminalSize | null = { cols: 80, rows: 24 };
  let grid: TerminalSize | null = null;
  let fits = 0;

  const paced = createSizePacer({ timers, send: (size) => sent.push(size) });
  const emulator = {
    fit(): void {
      fits += 1;
      // xterm's own rule, and the reason a pane in a collapsed cell costs a
      // measurement and never a frame.
      if (box === null) return;
      if (grid !== null && grid.cols === box.cols && grid.rows === box.rows) return;
      grid = box;
      const settled = clampTerminalSize(box);
      if (settled !== null) paced.report(settled);
    },
  };
  const unfit = watchFit({ element, emulator, boxes: boxes.boxes, frames: frames.frames });

  return {
    element,
    show(next: TerminalSize | null): void {
      box = next;
    },
    get fits(): number {
      return fits;
    },
    get sent(): readonly TerminalSize[] {
      return [...sent];
    },
    close(): void {
      unfit();
      paced.stop();
    },
  };
}

describe('watchFit', () => {
  it('fits before it returns, so a replay is not written into an unmeasured grid', () => {
    const boxes = fakeBoxes();
    const frames = fakeFrames();
    const pane = openPane(boxes, frames, createFakeTimers());

    // No observation and no frame has run. A browser's ResizeObserver
    // delivers at the end of a frame and this watch defers a frame further,
    // which is one or two frames after the feed has already replayed the
    // session's scrollback into the emulator.
    expect(pane.fits).toBe(1);
    expect(pane.sent).toEqual([{ cols: 80, rows: 24 }]);
  });

  it('fits once for a burst of observations in one frame', () => {
    const boxes = fakeBoxes();
    const frames = fakeFrames();
    const pane = openPane(boxes, frames, createFakeTimers());
    const opened = pane.fits;

    boxes.move(pane.element);
    boxes.move(pane.element);
    boxes.move(pane.element);
    expect(pane.fits).toBe(opened);
    expect(frames.pending).toBe(1);

    frames.run();

    // A divider being dragged produces observations faster than a layout is
    // worth re-measuring, and the ones in between were all superseded by the
    // last. One fit is the one that would have won anyway.
    expect(pane.fits).toBe(opened + 1);
  });

  it('fits again for the next frame, so a drag is not a single fit', () => {
    const boxes = fakeBoxes();
    const frames = fakeFrames();
    const pane = openPane(boxes, frames, createFakeTimers());
    const opened = pane.fits;

    boxes.move(pane.element);
    frames.run();
    boxes.move(pane.element);
    frames.run();

    expect(pane.fits).toBe(opened + 2);
  });

  it('stops watching and cancels the frame it had in hand', () => {
    const boxes = fakeBoxes();
    const frames = fakeFrames();
    const pane = openPane(boxes, frames, createFakeTimers());
    boxes.move(pane.element);
    const opened = pane.fits;

    pane.close();

    expect(boxes.watching).toBe(0);
    expect(frames.pending).toBe(0);
    frames.run();
    // Nothing measures an element after the emulator drawn into it is gone.
    expect(pane.fits).toBe(opened);
  });
});

/**
 * The cases the split layout produces. Each is an arrangement of the same
 * three seams, and each has been a bug in somebody's terminal: a split that
 * resizes one half, a drag that floods the wire, a closed pane that goes on
 * measuring, a hidden one that tells the agent it is two columns wide.
 */
describe('a pane in a split layout', () => {
  it('follows its own half of a split, which resizes both', () => {
    const boxes = fakeBoxes();
    const frames = fakeFrames();
    const timers = createFakeTimers();
    const left = openPane(boxes, frames, timers);
    const right = openPane(boxes, frames, timers);

    // One split: both halves are now narrower, and each is watched on its own
    // element. A single observer on a shared ancestor would have to guess
    // which pane changed.
    left.show({ cols: 40, rows: 24 });
    right.show({ cols: 38, rows: 24 });
    boxes.move(left.element);
    boxes.move(right.element);
    frames.run();
    timers.fireAll();

    expect(left.sent.at(-1)).toEqual({ cols: 40, rows: 24 });
    expect(right.sent.at(-1)).toEqual({ cols: 38, rows: 24 });
  });

  it('does not put a divider drag on the wire one pointer move at a time', () => {
    const boxes = fakeBoxes();
    const frames = fakeFrames();
    const timers = createFakeTimers();
    const pane = openPane(boxes, frames, timers);
    const opened = pane.sent.length;

    // Sixty pointer moves, three to a frame, each one a column narrower --
    // which is what dragging a divider across a screen at 60Hz looks like.
    for (let step = 0; step < 60; step += 1) {
      pane.show({ cols: 80 - step, rows: 24 });
      boxes.move(pane.element);
      if (step % 3 === 2) frames.run();
    }

    // Twenty fits, one per frame, and the emulator really reached twenty
    // grids -- and not one of them crossed the wire, because no settle window
    // closed while the hand was moving. A drag this long is about a second in
    // a browser, where ten windows would close and ten sizes would go; what
    // the clock being held still shows is the shape of the bound rather than
    // the number, which is one per window and never one per observation.
    expect(pane.fits).toBe(opened + 20);
    expect(pane.sent.length).toBe(opened);

    // The hand lets go, and the far end hears the grid the pane came to rest
    // at rather than the nineteen it passed through.
    timers.fireAll();

    expect(pane.sent.length).toBe(opened + 1);
    expect(pane.sent.at(-1)).toEqual({ cols: 21, rows: 24 });
  });

  it('says nothing for a box of nothing, and says the real size when it comes back', () => {
    const boxes = fakeBoxes();
    const frames = fakeFrames();
    const timers = createFakeTimers();
    const pane = openPane(boxes, frames, timers);
    const opened = pane.sent.length;

    // Hidden: a pane under `display: none`, or a split dragged shut. The
    // addon's own arithmetic would floor a box of nothing at two columns by
    // one row and resize to it, and the agent would redraw its whole screen
    // for a window nobody has.
    pane.show(null);
    boxes.move(pane.element);
    frames.run();
    timers.fireAll();

    expect(pane.fits).toBe(opened + 1);
    expect(pane.sent.length).toBe(opened);

    // Shown again, and the observer delivers the box it came back at.
    pane.show({ cols: 96, rows: 28 });
    boxes.move(pane.element);
    frames.run();

    expect(pane.sent.at(-1)).toEqual({ cols: 96, rows: 28 });
  });

  it('leaves a closed pane alone while its neighbour goes on following the window', () => {
    const boxes = fakeBoxes();
    const frames = fakeFrames();
    const timers = createFakeTimers();
    const closing = openPane(boxes, frames, timers);
    const staying = openPane(boxes, frames, timers);
    const closed = closing.sent.length;

    closing.show({ cols: 200, rows: 60 });
    closing.close();

    // The window is resized after the pane went: the remaining pane grows
    // into the space, and nothing at all happens for the one that left.
    staying.show({ cols: 160, rows: 50 });
    boxes.move(closing.element);
    boxes.move(staying.element);
    frames.run();
    timers.fireAll();

    expect(closing.sent.length).toBe(closed);
    expect(staying.sent.at(-1)).toEqual({ cols: 160, rows: 50 });
    expect(boxes.watching).toBe(1);
  });

  it('follows a device turning on its side, which is one observation and one grid', () => {
    const boxes = fakeBoxes();
    const frames = fakeFrames();
    const timers = createFakeTimers();
    const pane = openPane(boxes, frames, timers);

    // A phone rotated: the box does not grow or shrink, it transposes, and a
    // pane that only watched one axis would keep the old row count.
    pane.show({ cols: 45, rows: 90 });
    boxes.move(pane.element);
    frames.run();
    timers.fireAll();

    expect(pane.sent).toEqual([
      { cols: 80, rows: 24 },
      { cols: 45, rows: 90 },
    ]);
  });
});
