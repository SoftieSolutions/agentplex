import { useCallback, useMemo, type JSX } from 'react';
import type { TerminalSize } from '@agentplex/protocol';

import { browserTimers } from '../store/timers.js';
import { Box } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { attachEmulator } from './attach.js';
import type { TerminalFeed } from './chunk-feed.js';
import type { EmulatorFactory, TerminalEmulator } from './emulator.js';
import { browserBoxObservers, browserFrames } from './resize.js';
import { createXtermEmulatorFactory } from './xterm-emulator.js';

export interface TerminalViewProps {
  readonly feed: TerminalFeed;
  readonly scheme: Scheme;
  /** Keystrokes, as the emulator encoded them. Goes to the store, never to state. */
  onData(data: string): void;
  /**
   * The grid the emulator settled on. Goes to the store, never to state
   * either: a size in state would re-render the pane to tell it what it just
   * measured about itself.
   */
  onResize(size: TerminalSize): void;
  /** The live emulator, for the focus shortcut. Called with null on teardown. */
  emulatorReady?(emulator: TerminalEmulator | null): void;
  /**
   * Injected by tests; the real default is the xterm factory. Spelt with the
   * `undefined` as well as the `?` because the pane forwards its own optional
   * prop into it, and exactOptionalPropertyTypes keeps those apart.
   */
  readonly emulators?: EmulatorFactory | undefined;
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
 * The same callback is where the box gets watched. A `ResizeObserver` on the
 * element, one fit per animation frame, and the size the emulator settles on
 * going out as a frame at a rate a pty on another machine can be told at —
 * all of it attached and detached with the element, which is the one lifetime
 * it can correctly have. An effect would tie it to a render instead, and a
 * pane is resized by a divider drag that no render is involved in.
 *
 * Every prop the callback closes over is in its dependency list, so a change
 * of feed, scheme or factory rebuilds the emulator — correct, since all
 * three are constructor-time facts for xterm. Callers keep `onData`,
 * `onResize` and `emulatorReady` referentially stable so keystrokes do not
 * rebuild it.
 */
export function TerminalView({
  feed,
  scheme,
  onData,
  onResize,
  emulatorReady,
  emulators,
}: TerminalViewProps): JSX.Element {
  const factory = useMemo(
    () => emulators ?? createXtermEmulatorFactory(scheme),
    [emulators, scheme],
  );

  const mount = useCallback(
    (container: HTMLDivElement) =>
      attachEmulator({
        emulators: factory,
        container,
        feed,
        onData,
        onResize,
        boxes: browserBoxObservers,
        frames: browserFrames,
        timers: browserTimers,
        emulatorReady,
      }),
    [factory, feed, onData, onResize, emulatorReady],
  );

  return (
    <Box
      ref={mount}
      style={{
        flex: 1,
        minHeight: 0,
        padding: '14px 18px',
        background: colorForRole('terminalBackground', scheme),
        /**
         * The browser has no gesture to make on this box, because this box has
         * none to give it. xterm 6 keeps no scroll container -- its
         * `.xterm-viewport` is an empty element and the screen sits in a
         * scrollable element whose position is a number the renderer repaints
         * from -- so a pan handed to the browser here reaches nothing and is
         * offered to the page instead, which on a phone is the shell moving
         * when somebody meant to read what an agent printed.
         *
         * `none` rather than `pan-y`, and that is the difference between a
         * gesture that works and one that does not. Under `pan-y` the browser
         * may start a pan of its own and stop letting the page cancel the
         * touch, and the touch watch `attachEmulator` puts on this element has
         * to cancel it -- to keep the page still, and to suppress the
         * compatibility mouse events xterm would otherwise read as the start
         * of a text selection drag.
         *
         * It says nothing about the divider, whose own `none` is its own
         * decision. `touch-action` is not inherited, which was checked against
         * the built app rather than assumed: the divider computed `none` while
         * this element, inside it, computed `auto`.
         */
        touchAction: 'none',
      }}
    />
  );
}
