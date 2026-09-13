import { Unicode11Addon } from '@xterm/addon-unicode11';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { colorForRole, type Scheme } from '../ui/tokens.js';
import type { EmulatorFactory, TerminalEmulator } from './emulator.js';

/**
 * The terminal the pane draws into, configured and not yet opened.
 *
 * Separate from the factory below because opening is the DOM half — xterm
 * measures a cell against a real font in a real window — and the Unicode
 * widths this configures are the parser's half, which is the half a test can
 * drive. `xterm-emulator.test.ts` builds one of these and reads its buffer;
 * nothing else in the app calls it.
 */
export function createPaneTerminal(scheme: Scheme): Terminal {
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
    /**
     * `terminal.unicode` is proposed API in xterm 6, and xterm throws rather
     * than answering unless this is set — the Unicode 11 addon below trips
     * that on load. Opting in is therefore not a style choice; it is the
     * price of choosing a width table at all.
     */
    allowProposedApi: true,
  });
  /**
   * Column widths from Unicode 11 rather than xterm's built-in table, which
   * is Unicode 6 and answers 1 for every emoji assigned since. A width is not
   * decoration: the program on the other end padded its own output against
   * the width it assumed, so an emulator that measures one glyph short moves
   * everything after it one column left, and a TUI agent's panel borders tear
   * down the screen. The addon registers a second version; activating it is
   * what makes the parser use it.
   */
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  return terminal;
}

/**
 * The real emulator behind the seam: xterm, themed from the tokens file and
 * touched by nothing else in the app. This is the one module that imports
 * @xterm/xterm, the way browser.ts is the one that touches WebSocket — tests
 * reach the rules through `fake-emulator` and never construct this.
 */
export function createXtermEmulatorFactory(scheme: Scheme): EmulatorFactory {
  return {
    create(container: HTMLElement): TerminalEmulator {
      const terminal = createPaneTerminal(scheme);
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
