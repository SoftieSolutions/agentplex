// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { TERMINAL_MAX_COLS, TERMINAL_MAX_ROWS } from '@agentplex/protocol';
import { clampTerminalSize, watchFit, type BoxObservers, type FrameScheduler } from './resize.js';

/**
 * The two rules between a box changing and a pty being resized: one fit per
 * frame however many observations arrive in it, and nothing measured after
 * the element is gone.
 *
 * jsdom, for the element and for nothing else. There is no `ResizeObserver`
 * here and there is no point in a fake one — the observer is the browser's
 * and whether it fires is not this module's claim. What is this module's
 * claim is what happens between an observation and a fit, so the observer and
 * the frame clock are seams the test drives by hand, and the assertions are
 * counts.
 */

/** An observer the test fires, so "the box moved" is a call and not a wait. */
function fakeBoxes(): { boxes: BoxObservers; move(): void; readonly watching: boolean } {
  let changed: (() => void) | null = null;
  return {
    boxes: {
      observe(_element, fire) {
        changed = fire;
        return () => {
          changed = null;
        };
      },
    },
    move: () => changed?.(),
    get watching(): boolean {
      return changed !== null;
    },
  };
}

/** Frames that only happen when the test says so. */
function fakeFrames(): { frames: FrameScheduler; run(): void; readonly pending: number } {
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

function harness() {
  const element = document.createElement('div');
  const boxes = fakeBoxes();
  const frames = fakeFrames();
  let fits = 0;
  const stop = watchFit({
    element,
    emulator: {
      fit: () => {
        fits += 1;
      },
    },
    boxes: boxes.boxes,
    frames: frames.frames,
  });
  return { boxes, frames, stop, fits: () => fits };
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
});

describe('watchFit', () => {
  it('fits once for a burst of observations in one frame', () => {
    const h = harness();

    h.boxes.move();
    h.boxes.move();
    h.boxes.move();
    expect(h.fits()).toBe(0);
    expect(h.frames.pending).toBe(1);

    h.frames.run();

    // A window being dragged produces observations faster than a layout is
    // worth re-measuring, and the ones in between were all superseded by the
    // last. One fit is the one that would have won anyway.
    expect(h.fits()).toBe(1);
  });

  it('fits again for the next frame, so a drag is not a single fit', () => {
    const h = harness();

    h.boxes.move();
    h.frames.run();
    h.boxes.move();
    h.frames.run();

    expect(h.fits()).toBe(2);
  });

  it('stops watching and cancels the frame it had in hand', () => {
    const h = harness();
    h.boxes.move();

    h.stop();

    expect(h.boxes.watching).toBe(false);
    expect(h.frames.pending).toBe(0);
    h.frames.run();
    // Nothing measures an element after the emulator drawn into it is gone.
    expect(h.fits()).toBe(0);
  });
});
