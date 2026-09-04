import type { TerminalFeed } from './chunk-feed.js';
import type { EmulatorFactory, TerminalEmulator } from './emulator.js';

/**
 * The attach lifecycle, as one function whose return value undoes it.
 *
 * This is everything that happens when the terminal element exists: build the
 * emulator into it, point keystrokes at the store, replay-and-stream the feed
 * into the emulator, and announce the emulator to whoever holds the focus
 * shortcut. The cleanup runs the same story backwards — announce null first,
 * so nothing focuses an emulator mid-teardown, then stop the byte flow, then
 * dispose.
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
  readonly emulatorReady?: ((emulator: TerminalEmulator | null) => void) | undefined;
}

export function attachEmulator({
  emulators,
  container,
  feed,
  onData,
  emulatorReady,
}: AttachDependencies): () => void {
  const emulator = emulators.create(container);
  emulator.onData(onData);
  const detach = feed.attach(emulator);
  emulatorReady?.(emulator);
  return () => {
    emulatorReady?.(null);
    detach();
    emulator.dispose();
  };
}
