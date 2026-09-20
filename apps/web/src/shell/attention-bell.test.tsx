// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { AttentionBell } from './attention-bell.js';
import { destinationHash } from './destinations.js';

/**
 * The bell, on its own: the chrome's standing answer to "is anything waiting
 * on me", drawn identically in both forms of the shell.
 *
 * Both chromes hand it the same node, so what is pinned here is what it draws
 * for a count rather than where it sits -- that is `app-shell.test.tsx` for
 * the wide form and `mobile-chrome.test.tsx` for the phone.
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

describe('the attention bell', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  function draw(count: number): void {
    const element: JSX.Element = (
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="dark"
      >
        <AttentionBell count={count} scheme="dark" />
      </MantineProvider>
    );
    act(() => {
      // Re-rendered into the same root rather than mounted again, so a test
      // can move the count the way the fleet does and the region that has to
      // survive the move actually survives it.
      root ??= createRoot(container);
      root.render(element);
    });
  }

  function bell(): HTMLAnchorElement {
    const anchor = container.querySelector<HTMLAnchorElement>('a[data-attention-bell]');
    if (anchor === null) throw new Error('nothing drew a bell');
    return anchor;
  }

  /** The mark on the bell, which exists only when something is asking. */
  function mark(): HTMLElement | null {
    return container.querySelector<HTMLElement>('[data-needs-you]');
  }

  function announcement(): HTMLElement | null {
    return container.querySelector<HTMLElement>('[data-attention-bell] + [role="status"]');
  }

  it('is an address and not a control, so it does nothing only by going somewhere', () => {
    // The panel it will open is AGX-259. Until then it is the session list it
    // would have listed: a bell that swallows a tap is worse than no bell.
    draw(2);

    expect(bell().getAttribute('href')).toBe(destinationHash('sessions'));
  });

  it('says the count in its name, in the words every surface uses', () => {
    draw(2);
    expect(bell().getAttribute('aria-label')).toBe('2 sessions need you');

    draw(1);
    expect(bell().getAttribute('aria-label')).toBe('1 session needs you');
  });

  it('is still named when nothing is waiting, because it is still drawn', () => {
    draw(0);

    expect(bell().getAttribute('aria-label')).toBe('Nothing needs you');
  });

  it('marks itself when something is asking, and draws no number', () => {
    draw(2);

    // The mockup's mark is a bare dot: the number is the tab title's job and
    // the panel's, and a two-digit badge on a 32px control is a smudge.
    expect(mark()).not.toBeNull();
    expect(bell().textContent).toBe('');
  });

  it('draws no mark at all when nothing is waiting', () => {
    draw(0);

    expect(mark()).toBeNull();
  });

  it('reads the count out when it changes, from a region that was already there', () => {
    // Mounted at every count and empty at zero: a live region inserted along
    // with its first number is a region nothing was watching, so the first
    // session to start asking -- the announcement worth making -- is the one
    // that would be missed.
    draw(0);
    expect(announcement()?.textContent).toBe('');

    draw(2);
    expect(announcement()?.textContent).toBe('2 sessions need you');
  });
});
