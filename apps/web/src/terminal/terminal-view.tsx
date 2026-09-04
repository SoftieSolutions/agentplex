import { useCallback, useMemo, type JSX } from 'react';

import { Box } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { attachEmulator } from './attach.js';
import type { TerminalFeed } from './chunk-feed.js';
import type { EmulatorFactory, TerminalEmulator } from './emulator.js';
import { createXtermEmulatorFactory } from './xterm-emulator.js';

export interface TerminalViewProps {
  readonly feed: TerminalFeed;
  readonly scheme: Scheme;
  /** Keystrokes, as the emulator encoded them. Goes to the store, never to state. */
  onData(data: string): void;
  /** The live emulator, for the focus shortcut. Called with null on teardown. */
  emulatorReady?(emulator: TerminalEmulator | null): void;
  /** Injected by tests; the real default is the xterm factory. */
  readonly emulators?: EmulatorFactory;
}

/**
 * Where the emulator meets React, which is deliberately the whole of what
 * React does here: a ref callback builds the emulator when the element
 * exists, wires bytes feed-to-emulator and keystrokes emulator-to-store, and
 * its cleanup tears all of it down. No terminal byte ever enters React state
 * or a prop — output at pty speed through a re-render would be the app
 * repainting itself per read — and no effect is involved: the element's own
 * lifecycle is exactly the emulator's, which is what a ref callback with a
 * cleanup says.
 *
 * Every prop the callback closes over is in its dependency list, so a change
 * of feed, scheme or factory rebuilds the emulator — correct, since all
 * three are constructor-time facts for xterm. Callers keep `onData` and
 * `emulatorReady` referentially stable so keystrokes do not rebuild it.
 */
export function TerminalView({
  feed,
  scheme,
  onData,
  emulatorReady,
  emulators,
}: TerminalViewProps): JSX.Element {
  const factory = useMemo(
    () => emulators ?? createXtermEmulatorFactory(scheme),
    [emulators, scheme],
  );

  const mount = useCallback(
    (container: HTMLDivElement) =>
      attachEmulator({ emulators: factory, container, feed, onData, emulatorReady }),
    [factory, feed, onData, emulatorReady],
  );

  return (
    <Box
      ref={mount}
      style={{
        flex: 1,
        minHeight: 0,
        padding: '14px 18px',
        background: colorForRole('terminalBackground', scheme),
      }}
    />
  );
}
