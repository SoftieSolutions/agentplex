import type { FrameScheduler } from './resize.js';

/**
 * Scrolling the scrollback with a finger, which is a thing this app has to do
 * itself.
 *
 * The obvious assumption -- that xterm's viewport is a scroll container, so a
 * pan reaches it for free and the only question is `touch-action` -- is false
 * for xterm 6. Measured in the built app: `.xterm-viewport` is an element with
 * no children whose scroll height equals its client height, and the screen
 * lives in a VS Code `SmoothScrollableElement` that is `overflow: visible` and
 * keeps its scroll position as a number the renderer repaints from. There is
 * no `scrollTop` anywhere that moving would move anything.
 *
 * Nor is there a handler. A terminal built fresh in the running app registers
 * 34 listeners, of which two are `wheel` and four are `pointerdown` on its own
 * scrollbar and slider; `touchstart`, `touchmove` and `touchend` appear
 * nowhere. Read at the origin afterwards: the one `Gesture` reference in the
 * shipped bundle is `Gesture.ignoreTarget`, and `Gesture.addTarget` -- the
 * call that would give a VS Code scrollable element its touch behaviour -- is
 * never made. So on a phone the only way to move the scrollback was to drag a
 * 14px scrollbar slider that stays invisible until something scrolls.
 *
 * That is why this module exists rather than a line of CSS. `touch-action:
 * pan-y` on the terminal would have been the wrong fix twice over: there is no
 * scroll container for the pan to drive, and offering the pan to the page
 * instead is how a PWA ends up dragging its whole shell when somebody meant to
 * look at what an agent printed a minute ago.
 *
 * `touch-action: none` on the terminal element is the half that is CSS, and it
 * is not decoration: it is what makes every `touchmove` cancelable. Under
 * `pan-y` the browser may begin a pan of its own and stop letting the page
 * cancel the gesture, and this handler has to be able to cancel it -- both to
 * keep the page still and to suppress the compatibility mouse events a
 * non-cancelled touch produces, which xterm would otherwise read as the start
 * of a text selection drag. The divider keeps its own `none` for its own
 * reason; `touch-action` is not inherited, so neither element is speaking for
 * the other.
 *
 * Nothing here touches React. The element's lifetime is the gesture's, which
 * is what `attachEmulator` already says about everything else it wires up.
 */

/**
 * How far a finger travels before the gesture is a scroll rather than a tap.
 *
 * A tap has to survive, because a tap is how the terminal gets focus and the
 * on-screen keyboard with it. So nothing is cancelled and nothing is scrolled
 * until the finger has gone further than a finger resting on glass wanders,
 * and the whole distance travelled is applied at once when it does -- the
 * threshold delays the scroll, it does not eat the first few pixels of it.
 */
export const TOUCH_SCROLL_THRESHOLD_PX = 6;

/**
 * The frame the glide below moves a frame's worth of distance for.
 *
 * A nominal 60Hz rather than a measured interval, deliberately. The
 * alternative is to multiply the velocity by the time since the last frame,
 * which sounds more correct and is worse here: on a device dropping frames it
 * turns each late frame into a longer jump, so a stuttering glide travels the
 * same distance in fewer, larger steps -- which is exactly what a stutter
 * already looks like, made worse. A fixed step degrades the other way, into a
 * glide that is shorter than it should be and still smooth.
 */
export const GLIDE_FRAME_MS = 16;

/**
 * What is left of the speed after each frame of the glide.
 *
 * 0.94 halves the speed in about eleven frames, a fifth of a second, and a
 * hard flick comes to rest in something under a second and a half. Slower
 * decay reads as a screen that will not stop where it was put; faster reads as
 * a flick that was ignored.
 */
export const GLIDE_DECAY = 0.94;

/** Below this, in pixels per millisecond, the glide is over rather than slow. */
export const GLIDE_STOP_PX_PER_MS = 0.02;

/**
 * How stale the last movement may be and still be a flick.
 *
 * A finger that drags, stops, holds and lifts has asked for the scrollback to
 * stay where it was put. Without this the speed it was moving at before it
 * stopped would still be there at lift, and the view would sail off from under
 * a hand that had been holding it still.
 */
export const GLIDE_HANDOFF_MS = 100;

/**
 * How much of the newest sample the speed is made of.
 *
 * A single sample is the difference between two coordinates over a gap that
 * can be one frame or five, so the last one before a lift is the noisiest
 * number in the gesture and it is also the one a naive implementation flings
 * on. Most of the newest and a little of what came before follows a real
 * change of speed within a couple of events and refuses to fling on one
 * outlier.
 *
 * The first sample of a gesture is taken whole rather than blended, because
 * there is nothing behind it to blend with: starting from zero would make a
 * short flick -- two events and a lift, which is most of them -- glide at
 * nine tenths of the speed the finger was actually moving, which is a smooth
 * average of the finger and a fact about no gesture at all.
 */
export const GLIDE_SMOOTHING = 0.7;

export interface TouchScrollDependencies {
  /** The element the emulator was built into: the box a finger lands on. */
  readonly element: HTMLElement;
  /** Only the scrolling: this has no business writing bytes or fitting anything. */
  readonly emulator: { scrollPixels(pixels: number): void };
  /** The clock the glide runs on, injected for the reason `watchFit`'s is. */
  readonly frames: FrameScheduler;
}

/**
 * Gives one element's emulator a finger, and returns the stop.
 *
 * The gesture is read off touch events rather than pointer events for one
 * reason: `preventDefault` on a `touchmove` is what suppresses the
 * compatibility mouse events a touch would otherwise produce, and a
 * `pointermove` cannot say that. Those mouse events are not cosmetic here --
 * xterm turns a mousedown-and-drag into a text selection, so without the
 * cancel a scroll would select a screenful of output on its way past.
 *
 * Time comes off the events themselves rather than a clock seam. An event's
 * `timeStamp` is when the input happened; a clock read inside the handler is
 * when the handler got to run, which on a busy main thread is a different and
 * worse number to compute a speed from.
 */
export function watchTouchScroll({
  element,
  emulator,
  frames,
}: TouchScrollDependencies): () => void {
  /** One finger is down and the gesture has not been abandoned. */
  let tracking = false;
  /** The finger has gone far enough that this is a scroll and not a tap. */
  let scrolling = false;
  /** Where the finger was last read, which is where it started until it moves. */
  let lastY = 0;
  /** When that reading was taken, by the event's own clock. */
  let lastAt = 0;
  /** Pixels per millisecond, smoothed, and the speed the glide starts from. */
  let velocity = 0;
  /** Whether `velocity` is a reading yet, or still the zero it starts at. */
  let sampled = false;
  let cancelGlide: (() => void) | null = null;

  function stopGlide(): void {
    cancelGlide?.();
    cancelGlide = null;
  }

  function glide(): void {
    if (Math.abs(velocity) < GLIDE_STOP_PX_PER_MS) {
      velocity = 0;
      return;
    }
    cancelGlide = frames.schedule(() => {
      cancelGlide = null;
      emulator.scrollPixels(velocity * GLIDE_FRAME_MS);
      velocity *= GLIDE_DECAY;
      glide();
    });
  }

  function onStart(event: TouchEvent): void {
    // A finger on a moving screen stops it, the way it does everywhere else.
    // Before the count is checked, because a second finger landing mid-glide
    // is still a hand on the screen.
    stopGlide();
    velocity = 0;
    sampled = false;
    const touch = event.touches[0];
    if (event.touches.length !== 1 || touch === undefined) {
      // Two fingers is a pinch or a system gesture, and neither is this.
      tracking = false;
      scrolling = false;
      return;
    }
    tracking = true;
    scrolling = false;
    lastY = touch.clientY;
    lastAt = event.timeStamp;
  }

  function onMove(event: TouchEvent): void {
    if (!tracking) return;
    const touch = event.touches[0];
    if (event.touches.length !== 1 || touch === undefined) {
      tracking = false;
      scrolling = false;
      return;
    }
    // Up the screen is forward through the scrollback, which is the direction
    // `scrollTop` grows in and the direction every other surface moves in.
    const delta = lastY - touch.clientY;
    if (!scrolling) {
      // `lastY` is still where the finger landed, so this is the whole
      // distance travelled rather than the distance since the last event.
      if (Math.abs(delta) < TOUCH_SCROLL_THRESHOLD_PX) return;
      scrolling = true;
    }
    event.preventDefault();
    emulator.scrollPixels(delta);
    const elapsed = event.timeStamp - lastAt;
    if (elapsed > 0) {
      const sample = delta / elapsed;
      velocity = sampled ? velocity * (1 - GLIDE_SMOOTHING) + sample * GLIDE_SMOOTHING : sample;
      sampled = true;
    }
    lastY = touch.clientY;
    lastAt = event.timeStamp;
  }

  function onEnd(event: TouchEvent): void {
    if (!tracking) return;
    tracking = false;
    if (!scrolling) {
      // A tap. Nothing was cancelled, so the browser goes on to make the mouse
      // events that focus the terminal, and nothing here has an opinion.
      velocity = 0;
      return;
    }
    scrolling = false;
    if (event.timeStamp - lastAt > GLIDE_HANDOFF_MS) velocity = 0;
    glide();
  }

  // `passive: false` on the move, because a listener the browser believes is
  // passive is one whose `preventDefault` it ignores -- and the cancel is the
  // point of this listener rather than a detail of it.
  element.addEventListener('touchstart', onStart);
  element.addEventListener('touchmove', onMove, { passive: false });
  element.addEventListener('touchend', onEnd);
  element.addEventListener('touchcancel', onEnd);

  return () => {
    element.removeEventListener('touchstart', onStart);
    element.removeEventListener('touchmove', onMove);
    element.removeEventListener('touchend', onEnd);
    element.removeEventListener('touchcancel', onEnd);
    stopGlide();
    tracking = false;
    scrolling = false;
    velocity = 0;
    sampled = false;
  };
}
