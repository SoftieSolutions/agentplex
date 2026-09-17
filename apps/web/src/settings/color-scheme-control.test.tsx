// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COLOR_SCHEME_STORAGE_KEY, colorSchemeManager } from '../ui/color-scheme.js';
import { MantineProvider, useComputedColorScheme } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { colorForTone, hues, type Scheme } from '../ui/tokens.js';
import { ColorSchemeControl, COLOR_SCHEME_FIELD_NAME } from './color-scheme-control.js';

/**
 * The control that makes the light scheme reachable, mounted the way the page
 * mounts it: inside the app's own provider, on the app's own storage manager.
 *
 * What is asserted is the thing the screens actually read. A tone dot beside
 * a session asks `colorForTone` for the *computed* scheme, so the probe below
 * renders exactly that call, and a control that flipped the attribute on
 * `<html>` while leaving the components on the dark palette would fail here
 * rather than in somebody's eyes.
 *
 * jsdom has no media query and no preference, so the one the device would
 * answer with is installed as a seam a test can turn over -- which is the
 * only way to watch `System` follow a phone at sunset.
 */

declare global {
  // React's own name for the act flag.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

interface FakeMedia {
  /** What the device says now. Set it, then `flip` to announce the change. */
  prefersDark: boolean;
  /** Announce the current value to everybody listening, as a real device does. */
  flip(prefersDark: boolean): void;
}

/** Mantine consults the media query for its colour scheme; jsdom has none. */
function installMatchMedia(): FakeMedia {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const state: FakeMedia = {
    prefersDark: false,
    flip(prefersDark: boolean): void {
      state.prefersDark = prefersDark;
      for (const listener of listeners) {
        listener({ matches: prefersDark } as MediaQueryListEvent);
      }
    },
  };
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      get matches() {
        return query === '(prefers-color-scheme: dark)' && state.prefersDark;
      },
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
  return state;
}

/**
 * Every scheme the probe has been rendered with, oldest first. A frame is not
 * observable once `act` has flushed, so what a person would have seen is
 * recorded as it is rendered.
 */
const painted: Scheme[] = [];

/**
 * A stand-in for the screens: one element coloured the way every tone dot in
 * the app is coloured, so the assertions can read the hue a person would see.
 */
function ToneProbe(): JSX.Element {
  const scheme: Scheme = useComputedColorScheme('dark');
  // Written during render on purpose: this is the record of what was painted,
  // and an effect would only ever see the last of it. Nothing reads it back
  // during a render, and the suite mounts no StrictMode.
  painted.push(scheme);
  return (
    <span data-testid="probe" data-scheme={scheme} data-running={colorForTone('running', scheme)} />
  );
}

/** The segmented control measures its own indicator; jsdom has no layout. */
function installResizeObserver(): void {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

describe('the colour scheme control', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let media: FakeMedia;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    media = installMatchMedia();
    installResizeObserver();
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-mantine-color-scheme');
    painted.length = 0;
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
    window.localStorage.clear();
  });

  async function mount(): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          colorSchemeManager={colorSchemeManager}
          defaultColorScheme="dark"
        >
          <ColorSchemeControl />
          <ToneProbe />
        </MantineProvider>,
      );
    });
  }

  function segments(): HTMLInputElement[] {
    return [
      ...container.querySelectorAll<HTMLInputElement>(`input[name="${COLOR_SCHEME_FIELD_NAME}"]`),
    ];
  }

  function segment(value: string): HTMLInputElement {
    const found = segments().find((input) => input.value === value);
    if (found === undefined) throw new Error(`no segment for ${value}`);
    return found;
  }

  function probe(): HTMLElement {
    const element = container.querySelector<HTMLElement>('[data-testid="probe"]');
    if (element === null) throw new Error('the probe did not render');
    return element;
  }

  async function choose(value: string): Promise<void> {
    await act(async () => {
      segment(value).click();
    });
  }

  it('offers three states, because a device that flips at sunset can be followed', async () => {
    await mount();

    expect(segments().map((input) => input.value)).toEqual(['dark', 'light', 'system']);
    expect(container.textContent).toContain('Dark');
    expect(container.textContent).toContain('Light');
    expect(container.textContent).toContain('System');
  });

  it('starts on dark with nothing stored, the scheme the app falls back to', async () => {
    await mount();

    expect(segment('dark').checked).toBe(true);
    expect(probe().dataset['running']).toBe(hues.lichen);
  });

  it('takes the whole app to the light palette, not just the attribute on the document', async () => {
    await mount();

    await choose('light');

    expect(document.documentElement.getAttribute('data-mantine-color-scheme')).toBe('light');
    expect(probe().dataset['scheme']).toBe('light');
    expect(probe().dataset['running']).toBe(hues.fir);
  });

  it('keeps the choice on this device, under the key this app names', async () => {
    await mount();

    await choose('light');

    expect(window.localStorage.getItem(COLOR_SCHEME_STORAGE_KEY)).toBe('light');
  });

  it('starts on what was stored last time', async () => {
    window.localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, 'light');

    await mount();

    expect(segment('light').checked).toBe(true);
    expect(probe().dataset['running']).toBe(hues.fir);
  });

  it('falls back to dark when the stored word is not a scheme', async () => {
    window.localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, 'sepia');

    await mount();

    expect(segment('dark').checked).toBe(true);
    expect(probe().dataset['running']).toBe(hues.lichen);
  });

  it('follows the device while System is chosen, and keeps showing System when it turns over', async () => {
    media.prefersDark = false;
    await mount();

    await choose('system');
    expect(probe().dataset['scheme']).toBe('light');

    await act(async () => {
      media.flip(true);
    });

    expect(probe().dataset['scheme']).toBe('dark');
    // The segment shows what was chosen, not what it resolved to: the standing
    // instruction is still to follow the device.
    expect(segment('system').checked).toBe(true);
  });

  it('paints a light device light on the first frame, with no flash of the dark palette', async () => {
    window.localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, 'auto');
    media.prefersDark = false;

    await mount();

    // Not just "it ends up light": the whole record, because the scheme
    // reaches the screens as inline hues read at paint. Mantine's default is
    // to answer the media query in an effect, which would put one dark frame
    // in front of this.
    expect(painted).toEqual(['light']);
  });

  it('stops following the device once a scheme is chosen outright', async () => {
    await mount();

    await choose('light');
    await act(async () => {
      media.flip(true);
    });

    expect(probe().dataset['scheme']).toBe('light');
  });
});

describe('the colour scheme control in a browser that refuses storage', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let storage: PropertyDescriptor | undefined;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installResizeObserver();
    document.documentElement.removeAttribute('data-mantine-color-scheme');
    // A privacy mode, an embedded webview, a browser told to refuse site data:
    // touching the property itself throws, which is what this stands in for.
    storage = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('refused', 'SecurityError');
      },
    });
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
    if (storage !== undefined) Object.defineProperty(window, 'localStorage', storage);
  });

  it('degrades to dark and still switches for this page, rather than crashing', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          colorSchemeManager={colorSchemeManager}
          defaultColorScheme="dark"
        >
          <ColorSchemeControl />
          <ToneProbe />
        </MantineProvider>,
      );
    });

    const dark = container.querySelector<HTMLInputElement>('input[value="dark"]');
    expect(dark?.checked).toBe(true);

    await act(async () => {
      container.querySelector<HTMLInputElement>('input[value="light"]')?.click();
    });

    expect(document.documentElement.getAttribute('data-mantine-color-scheme')).toBe('light');
  });
});
