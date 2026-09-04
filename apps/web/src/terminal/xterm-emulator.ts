import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { colorForRole, type Scheme } from '../ui/tokens.js';
import type { EmulatorFactory, TerminalEmulator } from './emulator.js';

/**
 * The real emulator behind the seam: xterm, themed from the tokens file and
 * touched by nothing else in the app. This is the one module that imports
 * @xterm/xterm, the way browser.ts is the one that touches WebSocket — tests
 * reach the rules through `fake-emulator` and never construct this.
 */
export function createXtermEmulatorFactory(scheme: Scheme): EmulatorFactory {
  return {
    create(container: HTMLElement): TerminalEmulator {
      const terminal = new Terminal({
        theme: {
          background: colorForRole('terminalBackground', scheme),
          foreground: colorForRole('terminalText', scheme),
          cursor: colorForRole('accent', scheme),
        },
        // The same stack as the Mantine theme's monospace: the terminal is
        // part of the app's type system, not a second decision.
        fontFamily:
          '"Fira Code", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        fontSize: 12,
        /**
         * xterm's own scrollback, in lines: what the user can scroll through.
         * Distinct from the chunk feed's byte cap, which bounds the replay
         * buffer that repaints this screen on re-attach.
         */
        scrollback: 5_000,
      });
      terminal.open(container);
      return {
        write: (chunk) => terminal.write(chunk),
        onData: (listener) => {
          terminal.onData(listener);
        },
        focus: () => terminal.focus(),
        dispose: () => terminal.dispose(),
      };
    },
  };
}
