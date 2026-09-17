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
 * The two things about the terminal box that a style object decides and
 * something outside the view depends on.
 *
 * Behaviour cannot be asserted here. jsdom dispatches no touches of its own,
 * lays nothing out, and runs no browser gesture recognizer, so what a `pan-y`
 * would have done to a page is not a question this suite can ask, and neither
 * is what a fit would have made of a padded box. What it can ask is whether
 * the declarations those two depend on are the ones the view renders -- which
 * is the half that silently stops being true when somebody rearranges the
 * pane's styles.
 *
 * Both are worth pinning because both read as wrong on their face. `pan-y` is
 * what a terminal that scrolled natively would want, and it is wrong here:
 * xterm 6 has no scroll container, so the browser's pan reaches nothing and
 * goes to the page, and a pan the browser has begun is one the page can no
 * longer cancel -- which is what `touch-scroll.ts` needs in order to keep
 * xterm from reading the drag as a text selection. And a terminal pane
 * obviously wants padding, which this box obviously has none of: it is on the
 * terminal element instead, for the reason `padTerminalElement` argues.
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
  /** The box the view renders, which is the element the emulator is built into. */
  function renderedBox(): HTMLElement {
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
    return box;
  }

  it('claims every touch on it, because the browser has nothing to do with one', () => {
    expect(getComputedStyle(renderedBox()).touchAction).toBe('none');
  });

  it('has no padding of its own, because the fit addon would measure it and subtract none', () => {
    // The rule `padTerminalElement` exists for, asserted where it can be
    // broken. Everything else about the padding is asked of a box a test
    // built; this is the only assertion that fails when the padding comes
    // back to the element the view actually renders.
    //
    // Parsed rather than compared as a string: jsdom answers a bare `0` for a
    // length nobody set, and an assertion against `'0px'` would be pinning
    // jsdom's spelling rather than the pane's padding. `NaN` fails, which is
    // the right answer for a declaration that could not be read at all.
    const style = getComputedStyle(renderedBox());

    expect([Number.parseFloat(style.paddingTop), Number.parseFloat(style.paddingLeft)]).toEqual([
      0, 0,
    ]);
  });
});
