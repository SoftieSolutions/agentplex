// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeStorage } from '../auth/fake-storage.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { SidebarFrame } from './sidebar-frame.js';
import { createSidebarWidth, type SidebarWidth } from './sidebar-width.js';

/**
 * The wide shell's sidebar column and the edge that widens it.
 *
 * What a width is -- its bounds, how a stored word is read, what the window
 * allows -- is `sidebar-width.test.ts`. What is pinned here is the handle: that
 * it is a separator a keyboard can work, that a drag previews and then writes
 * once, and that a narrower window draws a narrower column without forgetting
 * the width that was chosen.
 *
 * Where the frame sits in the chrome is `app-shell.test.tsx`.
 */

declare global {
  // React's own name for the act flag.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const KEY = 'agentplex.sidebarWidth';

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

/**
 * A storage that counts its writes, because "the drag wrote once" is the
 * assertion and the fake by itself only remembers the last value.
 */
function countingStorage(initial: Record<string, string> = {}): {
  readonly storage: Storage;
  readonly writes: () => number;
} {
  const inner = fakeStorage(initial);
  let writes = 0;
  const storage: Storage = {
    get length() {
      return inner.length;
    },
    key: (index) => inner.key(index),
    getItem: (key) => inner.getItem(key),
    setItem: (key, value) => {
      writes += 1;
      inner.setItem(key, value);
    },
    removeItem: (key) => inner.removeItem(key),
    clear: () => inner.clear(),
  };
  return { storage, writes: () => writes };
}

describe('the sidebar frame', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    window.innerWidth = 1440;
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
    window.innerWidth = 1024;
  });

  function draw(store: SidebarWidth): void {
    const element: JSX.Element = (
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="dark"
      >
        <SidebarFrame store={store} scheme="dark">
          <nav>the sidebar</nav>
        </SidebarFrame>
      </MantineProvider>
    );
    act(() => {
      root ??= createRoot(container);
      root.render(element);
    });
  }

  function handle(): HTMLElement {
    const found = container.querySelector<HTMLElement>(
      '[role="separator"][aria-label="Resize sidebar"]',
    );
    if (found === null) throw new Error('the frame drew no resize handle');
    return found;
  }

  function aside(): HTMLElement {
    const found = container.querySelector<HTMLElement>('aside');
    if (found === null) throw new Error('the frame drew no aside');
    return found;
  }

  function valueNow(): string | null {
    return handle().getAttribute('aria-valuenow');
  }

  function press(key: string): void {
    act(() => {
      handle().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
  }

  function widen(viewport: number): void {
    act(() => {
      window.innerWidth = viewport;
      window.dispatchEvent(new Event('resize'));
    });
  }

  /**
   * Readies the handle for a drag the way a browser would have it: jsdom 30
   * has `PointerEvent` but no pointer capture, and no layout to measure the
   * column with, so both are stood in for on the elements the frame asks.
   */
  function readyForDrag(): void {
    const separator = handle();
    const captured = new Set<number>();
    separator.setPointerCapture = (id: number) => {
      captured.add(id);
    };
    separator.releasePointerCapture = (id: number) => {
      captured.delete(id);
    };
    separator.hasPointerCapture = (id: number) => captured.has(id);
    aside().getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 240, height: 800 });
  }

  function pointer(type: string, clientX: number): void {
    act(() => {
      handle().dispatchEvent(
        new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, clientX }),
      );
    });
  }

  it('draws a keyboard-operable separator at the default width with nothing stored', () => {
    draw(createSidebarWidth({ storage: () => fakeStorage() }));

    const separator = handle();
    expect(separator.getAttribute('aria-orientation')).toBe('vertical');
    expect(separator.getAttribute('tabindex')).toBe('0');
    expect(separator.getAttribute('aria-valuemin')).toBe('240');
    expect(separator.getAttribute('aria-valuemax')).toBe('480');
    expect(valueNow()).toBe('240');
    expect(aside().style.width).toBe('240px');
    // After the sidebar, so `aside button` still finds the sidebar's own
    // controls first.
    expect(aside().lastElementChild).toBe(separator);
  });

  it('steps wider with ArrowRight and stores the step', () => {
    const storage = fakeStorage();
    draw(createSidebarWidth({ storage: () => storage }));

    press('ArrowRight');

    expect(valueNow()).toBe('256');
    expect(storage.getItem(KEY)).toBe('256');
    expect(aside().style.width).toBe('256px');
  });

  it('stays at the narrowest with ArrowLeft there', () => {
    draw(createSidebarWidth({ storage: () => fakeStorage() }));

    press('ArrowLeft');

    expect(valueNow()).toBe('240');
  });

  it('goes to either bound with End and Home', () => {
    const storage = fakeStorage();
    draw(createSidebarWidth({ storage: () => storage }));

    press('End');
    expect(valueNow()).toBe('480');
    expect(storage.getItem(KEY)).toBe('480');

    press('Home');
    expect(valueNow()).toBe('240');
    expect(storage.getItem(KEY)).toBe('240');
  });

  it('returns to the default on a double click', () => {
    const storage = fakeStorage({ [KEY]: '400' });
    draw(createSidebarWidth({ storage: () => storage }));
    expect(valueNow()).toBe('400');

    act(() => {
      handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    expect(valueNow()).toBe('240');
    expect(storage.getItem(KEY)).toBe('240');
  });

  it('draws a narrower window narrower without forgetting the width chosen', () => {
    const storage = fakeStorage({ [KEY]: '480' });
    draw(createSidebarWidth({ storage: () => storage }));

    widen(900);
    expect(valueNow()).toBe('372');
    expect(handle().getAttribute('aria-valuemax')).toBe('372');
    expect(aside().style.width).toBe('372px');
    expect(storage.getItem(KEY)).toBe('480');

    widen(1440);
    expect(valueNow()).toBe('480');
    expect(handle().getAttribute('aria-valuemax')).toBe('480');
  });

  it('previews a drag while it moves and stores once, at the release', () => {
    const { storage, writes } = countingStorage();
    draw(createSidebarWidth({ storage: () => storage }));
    readyForDrag();

    pointer('pointerdown', 240);
    pointer('pointermove', 300);
    expect(valueNow()).toBe('300');
    expect(aside().style.width).toBe('300px');
    pointer('pointermove', 600);
    expect(valueNow()).toBe('480');
    expect(writes()).toBe(0);
    pointer('pointerup', 600);

    expect(writes()).toBe(1);
    expect(storage.getItem(KEY)).toBe('480');
    expect(valueNow()).toBe('480');
  });

  it('stores nothing for a drag the browser cancels, and draws the stored width again', () => {
    const { storage, writes } = countingStorage();
    draw(createSidebarWidth({ storage: () => storage }));
    readyForDrag();

    pointer('pointerdown', 240);
    pointer('pointermove', 300);
    pointer('pointermove', 600);
    expect(valueNow()).toBe('480');
    pointer('pointercancel', 600);

    expect(writes()).toBe(0);
    expect(storage.getItem(KEY)).toBeNull();
    expect(valueNow()).toBe('240');
  });

  it('stores nothing for a press that never moved', () => {
    // A click on the edge, or the two presses of a double click, is not a
    // drag: committing the pointer's position then would nudge the width by
    // however far inside the five-pixel handle the press landed.
    const { storage, writes } = countingStorage({ [KEY]: '400' });
    draw(createSidebarWidth({ storage: () => storage }));
    readyForDrag();

    pointer('pointerdown', 398);
    pointer('pointerup', 398);

    expect(writes()).toBe(0);
    expect(valueNow()).toBe('400');
  });
});
