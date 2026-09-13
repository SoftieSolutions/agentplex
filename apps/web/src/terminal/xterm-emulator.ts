import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

import { colorForRole, type Scheme } from '../ui/tokens.js';
import type { EmulatorFactory, TerminalEmulator } from './emulator.js';

/**
 * `window.open`, as the one thing a click on a link in terminal output
 * reaches for.
 *
 * A seam because the decision this ticket makes is entirely in the arguments:
 * which URL, in a new tab, with the opener severed. A test that could only
 * watch a real window would be watching jsdom's, which implements `open` by
 * returning null and warning — so the assertion worth making would be the one
 * assertion impossible to make. The pane injects nothing; the default below
 * is what the app runs.
 */
export interface WindowOpener {
  open(url: string, target: string, features: string): void;
}

/** The real one: the browser this bundle is running in. */
export const browserWindowOpener: WindowOpener = {
  open(url: string, target: string, features: string): void {
    window.open(url, target, features);
  },
};

/**
 * The protocols a link in terminal output may open, and the whole of them.
 *
 * Terminal output is another program's bytes, and an agent prints whatever it
 * was given to print — a URL out of a web page it fetched, a path out of a
 * repository it cloned. `javascript:` in that position is script this origin
 * runs on a click; `file:` and `data:` are a local read and an inline document
 * wearing the app's own trust. None of them is a link to somewhere, which is
 * the only thing this pane offers to follow.
 */
const OPENABLE_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * What a click on a link the addon found does, which is this module's decision
 * and not the addon's.
 *
 * Handed no handler the addon has one of its own: it opens a blank window,
 * nulls that window's `opener` and assigns `location.href`. Its regex today
 * matches nothing but `http:` and `https:`, so the protocol check below reads
 * at first like a guard against a case that cannot arise. It is a guard
 * against the case arising later: the regex is upstream's, replaceable through
 * the addon's own `urlRegex` option, and a pattern is not a protocol check
 * however carefully it is written. The module that opens the window is the one
 * that has to be able to say what it will open, so it parses the claim and
 * answers it. `noreferrer` is the second reason to replace the default: it
 * suppresses the referrer the addon's assignment to `location.href` would
 * still send, and a page opened out of somebody's session output has no
 * business being told which page opened it.
 *
 * What it opens is the parsed URL's `href` rather than the matched text: the
 * string handed to the browser is then the one the parser accepted, with no
 * room between the check and the use.
 *
 * OSC 8 hyperlinks — the escape sequence a program uses to make its own text
 * a link — are xterm's own path and not this one. It restricts them to the
 * same two protocols unless a `linkHandler` opts out, and this app sets none.
 */
export function createWebLinkHandler(
  opener: WindowOpener,
): (event: MouseEvent, uri: string) => void {
  return (_event: MouseEvent, uri: string): void => {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      // Not a URL at all. Leave it as the text it already was.
      return;
    }
    if (!OPENABLE_PROTOCOLS.has(url.protocol)) return;
    opener.open(url.href, '_blank', 'noopener,noreferrer');
  };
}

/**
 * The terminal the pane draws into, configured and not yet opened.
 *
 * Separate from the factory below because opening is the DOM half — xterm
 * measures a cell against a real font in a real window — and the Unicode
 * widths this configures are the parser's half, which is the half a test can
 * drive. `xterm-emulator.test.ts` builds one of these and reads its buffer;
 * nothing else in the app calls it.
 */
export function createPaneTerminal(
  scheme: Scheme,
  opener: WindowOpener = browserWindowOpener,
): Terminal {
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
  /**
   * A URL an agent prints is a thing to follow rather than characters to
   * retype into an address bar. The addon supplies the finding — where a URL
   * starts and ends in a line of output — and `createWebLinkHandler` supplies
   * the following, because the handler the addon falls back to opens what its
   * regex matched without a protocol check of its own.
   */
  terminal.loadAddon(new WebLinksAddon(createWebLinkHandler(opener)));
  return terminal;
}

/**
 * The real emulator behind the seam: xterm, themed from the tokens file and
 * touched by nothing else in the app. This is the one module that imports
 * @xterm/xterm, the way browser.ts is the one that touches WebSocket — tests
 * reach the rules through `fake-emulator` and never construct this.
 */
export function createXtermEmulatorFactory(
  scheme: Scheme,
  opener: WindowOpener = browserWindowOpener,
): EmulatorFactory {
  return {
    create(container: HTMLElement): TerminalEmulator {
      const terminal = createPaneTerminal(scheme, opener);
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
