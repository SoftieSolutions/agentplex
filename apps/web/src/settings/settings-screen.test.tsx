// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeStorage } from '../auth/fake-storage.js';
import { createTokenStore } from '../auth/token.js';
import { createFakeSocketFactory } from '../store/fake-socket.js';
import { createFrameIdCounter } from '../store/frame-ids.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { SettingsRoute } from './settings-route.js';

/**
 * That the screen carries the controls it is the home of.
 *
 * The appearance control is asserted here rather than only in its own suite
 * because its own suite mounts it directly: without this, deleting the
 * section from the screen would leave every test green and the light scheme
 * unreachable again, which is the bug AGX-126 was filed about.
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

/** The appearance control measures its own indicator; jsdom has no layout. */
function installResizeObserver(): void {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

describe('the settings screen', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let store: HubStore;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installResizeObserver();
    container = document.createElement('div');
    document.body.append(container);
    const sockets = createFakeSocketFactory();
    store = createHubStore({
      fetchTicket: () => Promise.resolve('ticket-1'),
      createSocket: (ticket) => sockets.create(ticket),
      timers: createFakeTimers(),
      frameIds: createFrameIdCounter(),
    });
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  it('carries the appearance control, which is the only place the light scheme is reachable from', async () => {
    const storage = fakeStorage();
    await act(async () => {
      root = createRoot(container);
      root.render(
        <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver}>
          <SettingsRoute store={store} tokens={createTokenStore(() => storage)} />
        </MantineProvider>,
      );
    });

    const group = container.querySelector('[aria-label="Appearance"]');
    expect(group).not.toBeNull();
    expect([...(group?.querySelectorAll('input') ?? [])].map((input) => input.value)).toEqual([
      'dark',
      'light',
      'system',
    ]);
  });
});
