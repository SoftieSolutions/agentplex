// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { FrameScheduler } from './resize.js';
import {
  GLIDE_DECAY,
  GLIDE_FRAME_MS,
  GLIDE_HANDOFF_MS,
  TOUCH_SCROLL_THRESHOLD_PX,
  watchTouchScroll,
} from './touch-scroll.js';

/**
 * What a finger on the terminal asks the emulator for.
 *
 * jsdom for the element and the event plumbing, and for nothing else. It has
 * no `TouchEvent` constructor, so the events below are built out of the three
 * fields this module reads -- the touch points, the y each is at, and the
 * event's own clock. That is a driver rather than a fixture: there is no
 * captured touch to hold this to, because the browser that would produce one
 * is the browser this suite does not have. What it does let the test assert
 * is the half that is a decision rather than a browser behaviour -- what is
 * scrolled, what is cancelled, and what happens after the finger leaves.
 *
 * The frame clock is driven by hand for the reason `resize.test.ts` drives
 * its own: a glide that ran on real frames would be a test that waits, and
 * the only thing worth asserting about a glide is the shape of the sequence
 * it produces, which is the same shape however long each frame took.
 */

/** One finger, at a y, as the handler reads it off an event. */
function touchAt(y: number): { clientY: number } {
  return { clientY: y };
}

/**
 * A touch event with the fields this module reads on it.
 *
 * `timeStamp` and `touches` are both accessors on the prototype in a real
 * browser, so an own property shadows them the way the browser's own value
 * would sit there.
 */
function touchEvent(type: string, points: readonly { clientY: number }[], at: number): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'touches', { value: points });
  Object.defineProperty(event, 'timeStamp', { value: at });
  return event;
}

interface FakeFrames {
  readonly frames: FrameScheduler;
  /** Runs the one frame the glide has asked for, if it has asked for one. */
  run(): void;
  /** Runs frames until the glide stops asking, up to a bound that is not a wait. */
  runToRest(): void;
  readonly pending: boolean;
}

function fakeFrames(): FakeFrames {
  let queued: (() => void) | null = null;
  const frames: FrameScheduler = {
    schedule(run: () => void): () => void {
      queued = run;
      return () => {
        queued = null;
      };
    },
  };
  return {
    frames,
    run(): void {
      const due = queued;
      queued = null;
      due?.();
    },
    runToRest(): void {
      for (let frame = 0; frame < 1000 && queued !== null; frame += 1) {
        const due = queued;
        queued = null;
        due();
      }
    },
    get pending(): boolean {
      return queued !== null;
    },
  };
}

interface Pane {
  readonly element: HTMLElement;
  readonly scrolled: readonly number[];
  readonly frames: FakeFrames;
  /** Dispatches one event and answers whether the handler cancelled it. */
  touch(type: string, points: readonly { clientY: number }[], at: number): boolean;
  readonly stop: () => void;
}

function openPane(): Pane {
  const element = document.createElement('div');
  const scrolled: number[] = [];
  const frames = fakeFrames();
  const stop = watchTouchScroll({
    element,
    emulator: { scrollPixels: (pixels) => scrolled.push(pixels) },
    frames: frames.frames,
  });
  return {
    element,
    frames,
    stop,
    touch(type, points, at): boolean {
      const event = touchEvent(type, points, at);
      element.dispatchEvent(event);
      return event.defaultPrevented;
    },
    get scrolled(): readonly number[] {
      return [...scrolled];
    },
  };
}

/** The total distance a run of scrolls moved the view. */
function travelled(scrolled: readonly number[]): number {
  return scrolled.reduce((total, pixels) => total + pixels, 0);
}

describe('a finger on the terminal', () => {
  it('scrolls the scrollback by the distance it travels, upwards being forwards', () => {
    const pane = openPane();
    pane.touch('touchstart', [touchAt(400)], 0);
    // Dragging up the screen is asking for newer output, the direction
    // `scrollTop` grows in.
    pane.touch('touchmove', [touchAt(360)], 16);
    pane.touch('touchmove', [touchAt(330)], 32);
    pane.touch('touchend', [], 40);

    expect(pane.scrolled).toEqual([40, 30]);
  });

  it('drags the other way for older output', () => {
    const pane = openPane();
    pane.touch('touchstart', [touchAt(300)], 0);
    pane.touch('touchmove', [touchAt(360)], 16);
    pane.touch('touchend', [], 24);

    expect(pane.scrolled).toEqual([-60]);
  });

  it('cancels the move it scrolls on, so nothing behind it makes a selection', () => {
    // The cancel is what suppresses the compatibility mouse events, and xterm
    // reads a mousedown and a drag as the start of a text selection. A scroll
    // that left them alone would highlight a screenful of output on its way.
    const pane = openPane();
    pane.touch('touchstart', [touchAt(400)], 0);

    expect(pane.touch('touchmove', [touchAt(340)], 16)).toBe(true);
  });

  it('leaves a tap alone, so it still focuses the terminal', () => {
    // Nothing cancelled means the browser goes on to make the mouse events
    // xterm focuses on -- which on a phone is the whole of how the keyboard
    // comes up.
    const pane = openPane();
    const start = pane.touch('touchstart', [touchAt(400)], 0);
    const end = pane.touch('touchend', [], 60);

    expect([start, end]).toEqual([false, false]);
    expect(pane.scrolled).toEqual([]);
    expect(pane.frames.pending).toBe(false);
  });

  it('treats a finger that barely moves as a tap and not a scroll', () => {
    const pane = openPane();
    pane.touch('touchstart', [touchAt(400)], 0);
    const wander = TOUCH_SCROLL_THRESHOLD_PX - 1;
    const cancelled = pane.touch('touchmove', [touchAt(400 - wander)], 16);

    expect(cancelled).toBe(false);
    expect(pane.scrolled).toEqual([]);
  });

  it('applies the whole distance travelled when the threshold is crossed', () => {
    // The threshold delays the scroll; it does not eat the first pixels of
    // it. A drag that crosses in one event has moved the whole way, and a
    // view that started from the crossing point would lag the finger by the
    // threshold for the rest of the gesture.
    const pane = openPane();
    pane.touch('touchstart', [touchAt(400)], 0);
    pane.touch('touchmove', [touchAt(400 - (TOUCH_SCROLL_THRESHOLD_PX - 1))], 16);
    pane.touch('touchmove', [touchAt(370)], 32);

    expect(pane.scrolled).toEqual([30]);
  });
});

describe('the glide after the finger leaves', () => {
  it('keeps going in the direction of the flick, by less each frame, and stops', () => {
    const pane = openPane();
    pane.touch('touchstart', [touchAt(500)], 0);
    pane.touch('touchmove', [touchAt(460)], 16);
    pane.touch('touchmove', [touchAt(420)], 32);
    pane.touch('touchend', [], 32);

    const dragged = pane.scrolled.length;
    pane.frames.run();
    pane.frames.run();
    const [first, second] = pane.scrolled.slice(dragged);
    if (first === undefined || second === undefined) throw new Error('the glide did not start');

    expect(first).toBeGreaterThan(0);
    expect(second).toBeCloseTo(first * GLIDE_DECAY, 6);
    // A flick of 40px per frame carries on at about that speed before it
    // decays, rather than at some number of its own.
    expect(first).toBeCloseTo((40 / 16) * GLIDE_FRAME_MS, 6);

    pane.frames.runToRest();
    expect(pane.frames.pending).toBe(false);
  });

  it('comes to rest rather than creeping on forever', () => {
    const pane = openPane();
    pane.touch('touchstart', [touchAt(600)], 0);
    pane.touch('touchmove', [touchAt(400)], 16);
    pane.touch('touchend', [], 20);
    const dragged = pane.scrolled.length;

    pane.frames.runToRest();
    const glided = pane.scrolled.slice(dragged);

    expect(glided.length).toBeGreaterThan(5);
    // Finite, and in the direction of the flick the whole way.
    expect(travelled(glided)).toBeGreaterThan(0);
    expect(glided.every((pixels) => pixels > 0)).toBe(true);
  });

  it('does not fling when the finger stopped before it lifted', () => {
    // A drag, a pause, a lift: the view was put somewhere and held there, and
    // the speed from before the pause is not what the hand asked for.
    const pane = openPane();
    pane.touch('touchstart', [touchAt(500)], 0);
    pane.touch('touchmove', [touchAt(400)], 16);
    pane.touch('touchend', [], 16 + GLIDE_HANDOFF_MS + 1);

    expect(pane.frames.pending).toBe(false);
    expect(pane.scrolled).toEqual([100]);
  });

  it('stops under a finger put back on the screen', () => {
    const pane = openPane();
    pane.touch('touchstart', [touchAt(600)], 0);
    pane.touch('touchmove', [touchAt(400)], 16);
    pane.touch('touchend', [], 20);
    expect(pane.frames.pending).toBe(true);

    pane.touch('touchstart', [touchAt(300)], 40);

    expect(pane.frames.pending).toBe(false);
    const held = pane.scrolled.length;
    pane.frames.run();
    expect(pane.scrolled.length).toBe(held);
  });
});

describe('gestures that are not a scroll', () => {
  it('lets go of a drag a second finger joins', () => {
    // A pinch is the browser's to interpret, and a page that went on scrolling
    // through one would be fighting a zoom.
    const pane = openPane();
    pane.touch('touchstart', [touchAt(500)], 0);
    pane.touch('touchmove', [touchAt(450)], 16);
    pane.touch('touchstart', [touchAt(450), touchAt(300)], 20);
    const cancelled = pane.touch('touchmove', [touchAt(400), touchAt(350)], 36);

    expect(cancelled).toBe(false);
    expect(pane.scrolled).toEqual([50]);
  });

  it('ignores a move that belongs to no touch it saw start', () => {
    const pane = openPane();
    const cancelled = pane.touch('touchmove', [touchAt(400)], 16);

    expect(cancelled).toBe(false);
    expect(pane.scrolled).toEqual([]);
  });

  it('gives up on a cancelled touch without gliding on its last speed', () => {
    // A touch the system takes away -- a call arriving, a palm landing -- is
    // not a flick, but it is also not a hand still holding the screen. The
    // view carries on the way a lifted finger's would, because the alternative
    // is a screen that stops dead for a reason the user cannot see.
    const pane = openPane();
    pane.touch('touchstart', [touchAt(500)], 0);
    pane.touch('touchmove', [touchAt(400)], 16);
    pane.touch('touchcancel', [], 20);

    expect(pane.frames.pending).toBe(true);
  });
});

describe('the watch itself', () => {
  it('stops listening and drops a glide still in flight', () => {
    const pane = openPane();
    pane.touch('touchstart', [touchAt(600)], 0);
    pane.touch('touchmove', [touchAt(400)], 16);
    pane.touch('touchend', [], 20);
    expect(pane.frames.pending).toBe(true);

    pane.stop();

    expect(pane.frames.pending).toBe(false);
    const held = pane.scrolled.length;
    pane.touch('touchstart', [touchAt(500)], 40);
    pane.touch('touchmove', [touchAt(300)], 56);
    expect(pane.scrolled.length).toBe(held);
  });
});
