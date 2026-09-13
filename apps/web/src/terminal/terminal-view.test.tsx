// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { createTerminalFeed } from './chunk-feed.js';
import { createFakeEmulatorFactory } from './fake-emulator.js';
import { TerminalView } from './terminal-view.js';

/**
 * The one thing about the terminal box that a stylesheet decides and a
 * gesture depends on.
 *
 * Behaviour cannot be asserted here. jsdom dispatches no touches of its own,
 * lays nothing out, and runs no browser gesture recognizer, so what a `pan-y`
 * would have done to a page is not a question this suite can ask. What it can
 * ask is whether the declaration the gesture relies on is on the element the
 * gesture is attached to -- which is the half that silently stops being true
 * when somebody rearranges the pane's styles.
 *
 * It is worth pinning because the value is counter-intuitive on its face.
 * `pan-y` is what a terminal that scrolled natively would want, and it is
 * wrong here: xterm 6 has no scroll container, so the browser's pan reaches
 * nothing and goes to the page, and a pan the browser has begun is one the
 * page can no longer cancel -- which is what `touch-scroll.ts` needs in order
 * to keep xterm from reading the drag as a text selection.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let host: HTMLDivElement;
let root: Root;

/**
 * jsdom has no `ResizeObserver`, and the view watches its own box with one.
 * A stub that observes nothing and fires nothing: what the watch does with an
 * observation is `resize.test.ts`'s question, asked against a seam.
 */
/** Mantine asks for the colour scheme with one, and jsdom has no answer. */
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

function installResizeObserver(): void {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  installMatchMedia();
  installResizeObserver();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

describe('the terminal box', () => {
  it('claims every touch on it, because the browser has nothing to do with one', () => {
    act(() => {
      root.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="dark"
        >
          <TerminalView
            feed={createTerminalFeed({ maxBytes: 1024 })}
            scheme="dark"
            onData={() => {}}
            onResize={() => {}}
            emulators={createFakeEmulatorFactory()}
          />
        </MantineProvider>,
      );
    });

    const box = host.querySelector('div');
    if (!(box instanceof HTMLElement)) throw new Error('the view rendered no element');
    expect(getComputedStyle(box).touchAction).toBe('none');
  });
});
