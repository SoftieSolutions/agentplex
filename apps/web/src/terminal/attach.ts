import type { TerminalSize } from '@agentplex/protocol';
import type { TerminalFeed } from './chunk-feed.js';
import type { EmulatorFactory, TerminalEmulator } from './emulator.js';
import { clampTerminalSize, watchFit, type BoxObservers, type FrameScheduler } from './resize.js';

/**
 * The attach lifecycle, as one function whose return value undoes it.
 *
 * This is everything that happens when the terminal element exists: build the
 * emulator into it, point keystrokes at the store, point the size it settles
 * on at the store too, keep it fitted to the element, replay-and-stream the
 * feed into the emulator, and announce the emulator to whoever holds the focus
 * shortcut. The cleanup runs the same story backwards — announce null first,
 * so nothing focuses an emulator mid-teardown, then stop the byte flow, then
 * stop fitting, then dispose.
 *
 * The size listener is wired before the fit watch starts, deliberately: the
 * observer's first observation is the element as it already is, so the first
 * fit happens immediately, and a listener attached after it would miss the
 * one size the far end most needs — the one the pane opened at.
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
  emulatorReady,
}: AttachDependencies): () => void {
  const emulator = emulators.create(container);
  emulator.onData(onData);
  emulator.onResize((size) => onResize(clampTerminalSize(size)));
  const unfit = watchFit({ element: container, emulator, boxes, frames });
  const detach = feed.attach(emulator);
  emulatorReady?.(emulator);
  return () => {
    emulatorReady?.(null);
    detach();
    unfit();
    emulator.dispose();
  };
}
