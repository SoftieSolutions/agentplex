// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clipboardProblem, type Clipboard } from '../terminal/clipboard.js';
import { createFakeClipboard, createRefusingClipboard } from '../terminal/fake-clipboard.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { EnrollPanel } from './enroll-panel.js';
import { installCommand, targetNotes } from './install-command.js';

/**
 * The panel a reader with no server gets: three machines it might be, the one
 * command for the one they are standing at, and a way to take that command
 * without retyping it.
 *
 * Two things are tested harder than the markup. The copy button, because it is
 * the only thing on this screen that can fail: the clipboard is absent on an
 * insecure origin and refusable everywhere else, and a button that silently
 * did nothing is the failure a reader cannot tell from a button that worked.
 * And the words, because on this screen the words are the feature -- the
 * command is a shell line somebody will run as themselves, and the token
 * sentence is the difference between reading a file and searching a scrollback
 * that never carried one.
 *
 * The commands and the notes are not spelled out here. `install-command.test.ts`
 * pins those against the script that has to honour them; what this file holds
 * is that the panel shows the pair belonging to the tab the reader is on, and
 * copies that same string rather than a stale one.
 */

declare global {
  // React's own name for the act flag.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** Mantine consults the media query for its colour scheme; jsdom has none. */
function installMatchMedia(): void {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

/** Lets the clipboard's already-resolved answer reach the handler's `then`. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('the enroll panel', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let paired: number;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    container = document.createElement('div');
    document.body.append(container);
    paired = 0;
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  async function mount(clipboard?: Clipboard): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="dark"
        >
          <EnrollPanel
            scheme="dark"
            clipboard={clipboard}
            onHaveToken={() => {
              paired += 1;
            }}
          />
        </MantineProvider>,
      );
    });
  }

  /**
   * What the panel says, with Mantine's injected stylesheet out of it: its
   * `<style>` text is part of `container.textContent`, and a copy assertion
   * that reads it is an assertion about the component library.
   */
  function copy(): string {
    const clone = container.cloneNode(true) as HTMLElement;
    for (const style of clone.querySelectorAll('style')) style.remove();
    return clone.textContent ?? '';
  }

  function button(text: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button')].find(
      (element) => element.textContent === text,
    );
    if (found === undefined) throw new Error(`no ${text} button`);
    return found;
  }

  /**
   * A click, and the microtask the clipboard's answer comes back on. Both
   * inside one `act`, because the state this panel sets after a copy is set in
   * that microtask and React counts an update outside `act` as one a test did
   * not mean to cause.
   */
  async function click(text: string): Promise<void> {
    await act(async () => {
      button(text).click();
      await settle();
    });
  }

  /** The command as the reader sees it, read off the box rather than the page. */
  function shownCommand(): string {
    return container.querySelector('[data-install-command]')?.textContent ?? '';
  }

  it('says what the reader is about to do, with the direction the right way round', async () => {
    await mount();

    expect(copy()).toContain('Run a server on a machine');
    expect(copy()).toContain('Works on macOS and Linux.');
    // The hub dials the server. A sentence the other way round would send
    // somebody to open a port on the machine that needs none.
    expect(copy()).not.toMatch(/server[^.]*\b(dials?|connects? to|points? at)\b[^.]*hub/i);
  });

  it('opens on the command for a Linux box, with what that run leaves behind', async () => {
    await mount();

    expect(shownCommand()).toBe(installCommand('linux'));
    expect(copy()).toContain(targetNotes('linux'));
  });

  it('answers each machine with its own command and its own note', async () => {
    await mount();

    await click('macOS');
    expect(shownCommand()).toBe(installCommand('macos'));
    expect(copy()).toContain(targetNotes('macos'));

    await click('Already installed');
    expect(shownCommand()).toBe(installCommand('installed'));
    expect(copy()).toContain(targetNotes('installed'));
    // One answer at a time. The three notes differ in what will keep the
    // server up, and a page showing all three at once is a page that answers
    // the question the reader asked with two answers they have to rule out.
    expect(copy()).not.toContain(targetNotes('linux'));
  });

  it('copies the command that is on screen, once, and says it did', async () => {
    const clipboard = createFakeClipboard();
    await mount(clipboard);

    await click('Copy');

    expect(clipboard.writes).toBe(1);
    expect(clipboard.text).toBe(installCommand('linux'));
    expect(copy()).toMatch(/copied/i);
  });

  it('copies the tab the reader is on and not the one it opened with', async () => {
    const clipboard = createFakeClipboard();
    await mount(clipboard);

    await click('Already installed');
    await click('Copy');

    expect(clipboard.text).toBe(installCommand('installed'));
  });

  it('says so when the clipboard refuses, rather than looking like it worked', async () => {
    await mount(createRefusingClipboard('denied'));

    await click('Copy');

    // The seam's own sentence, which names what refused and which half of the
    // operation it refused, because "copy failed" is not something a reader
    // can act on and "grant this page the clipboard" is.
    expect(copy()).toContain(clipboardProblem('copy', new Error('denied')));
    expect(copy()).not.toMatch(/copied/i);
  });

  it('drops the copy line when the tab changes, so it never labels the wrong command', async () => {
    const clipboard = createFakeClipboard();
    await mount(clipboard);

    await click('Copy');
    await click('macOS');

    expect(copy()).not.toMatch(/copied/i);
  });

  it('names the file setup leaves the token in, and never says anything printed it', async () => {
    await mount();

    const opening = copy();

    // Setup mints the token into the server's identity file and shows it
    // nowhere. A panel that promised a printed token would send the reader to
    // search a scrollback that never carried one -- the same rule the pairing
    // step is already held to.
    expect(opening).toContain('~/.agentplex/server.json');
    expect(opening).not.toMatch(/print/i);
    // Held on every tab, and not only the one this opens on. macOS's note does
    // say the script prints the daemon command, which is a command and not a
    // secret, so the rule that has to hold everywhere is the narrow one.
    for (const tab of ['macOS', 'Already installed']) {
      await click(tab);
      expect(copy()).not.toMatch(/token[^.]*\bprint/i);
      expect(copy()).not.toMatch(/print[^.]*\btoken/i);
    }
  });

  it('mints nothing: there is no token on this screen to leak', async () => {
    const clipboard = createFakeClipboard();
    await mount(clipboard);

    // The mock this came from put a minted token in the one-liner and a
    // countdown under it. The real install mints its own on the machine it
    // installs, so a secret here would be one nobody could have produced.
    await click('Copy');
    expect(clipboard.text).not.toMatch(/token/i);
    expect(copy()).not.toMatch(/expires/i);
    expect(copy()).not.toMatch(/apx_/);
  });

  it('hands the reader back to the form once they have the token', async () => {
    await mount();

    await click('I have the token, pair it');

    expect(paired).toBe(1);
  });
});
