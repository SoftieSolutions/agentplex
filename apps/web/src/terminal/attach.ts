import type { TerminalSize } from '@agentplex/protocol';
import type { Timers } from '../store/timers.js';
import type { TerminalFeed } from './chunk-feed.js';
import type { EmulatorFactory, TerminalEmulator } from './emulator.js';
import {
  clampTerminalSize,
  createSizePacer,
  watchFit,
  type BoxObservers,
  type FrameScheduler,
} from './resize.js';
import { watchTouchScroll } from './touch-scroll.js';

/**
 * The attach lifecycle, as one function whose return value undoes it.
 *
 * This is everything that happens when the terminal element exists: build the
 * emulator into it, point keystrokes at the store, point the size it settles
 * on at the store too, fit it to the element, replay-and-stream the feed into
 * the emulator, and announce the emulator to whoever holds the focus
 * shortcut. The cleanup runs the same story backwards — announce null first,
 * so nothing focuses an emulator mid-teardown, then stop the byte flow, then
 * stop fitting, then drop any size still on its way out, then dispose.
 *
 * Two orderings here are load-bearing rather than incidental.
 *
 * The size listener is wired before the watch starts, because the watch's
 * first fit is synchronous and a listener attached after it would miss the
 * one size the far end most needs — the one the pane opened at.
 *
 * The touch watch is not one of those orderings. It is attached beside the
 * fit because it has the same lifetime -- the element's -- and for no other
 * reason: a finger cannot arrive before the element it lands on exists, and
 * what it scrolls is the emulator's own view rather than anything on the wire.
 *
 * The watch starts before the feed is attached, because the feed writes
 * whatever the subscription replayed the moment it has an emulator, and an
 * emulator nobody has fitted is 80x24. A replay written into that grid is
 * reflowed twice — once against a grid this pane never had, and again when
 * the real size arrives — which a user sees as a screenful of wrapped output
 * straightening itself out. `watchFit` fits before it returns, which is what
 * makes these two lines an ordering rather than a coincidence.
 *
 * A module of its own so the lifecycle is testable with a fake emulator and
 * no DOM; `terminal-view.tsx` is only the ref callback that calls it.
 */
export interface AttachDependencies {
  readonly emulators: EmulatorFactory;
  readonly container: HTMLElement;
  readonly feed: TerminalFeed;
  /** Keystrokes out. Wired before the replay, so an echo-y fake cannot loop. */
  onData(data: string): void;
  /** The grid the emulator settled on, already inside what a frame may carry. */
  onResize(size: TerminalSize): void;
  /** How the element's box is watched, and how a burst of changes is coalesced. */
  readonly boxes: BoxObservers;
  readonly frames: FrameScheduler;
  /** The clock the outgoing sizes are paced against. */
  readonly timers: Timers;
  readonly emulatorReady?: ((emulator: TerminalEmulator | null) => void) | undefined;
}

export function attachEmulator({
  emulators,
  container,
  feed,
  onData,
  onResize,
  boxes,
  frames,
  timers,
  emulatorReady,
}: AttachDependencies): () => void {
  const emulator = emulators.create(container);
  emulator.onData(onData);
  const sizes = createSizePacer({ timers, send: onResize });
  emulator.onResize((size) => {
    const settled = clampTerminalSize(size);
    // Nothing to say rather than something wrong: a box with no height
    // divides through to `NaN`, and the frame that would carry it is one the
    // hub can only refuse.
    if (settled !== null) sizes.report(settled);
  });
  const unfit = watchFit({ element: container, emulator, boxes, frames });
  const untouch = watchTouchScroll({ element: container, emulator, frames });
  const detach = feed.attach(emulator);
  emulatorReady?.(emulator);
  return () => {
    emulatorReady?.(null);
    detach();
    untouch();
    unfit();
    sizes.stop();
    emulator.dispose();
  };
}
