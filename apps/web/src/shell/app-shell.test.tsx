// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionRefSchema } from '@agentplex/protocol';
import { fakeStorage } from '../auth/fake-storage.js';
import { createTokenStore, type TokenStore } from '../auth/token.js';
import { createFakeSocketFactory, type FakeSocket } from '../store/fake-socket.js';
import { createFrameIdCounter } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { sessionHash } from '../terminal/session-route.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { AppShell } from './app-shell.js';
import { destinationHash } from './destinations.js';

/**
 * The frame, on a fleet a real hub reported: what is drawn around whatever
 * screen the address names, and that it stays drawn when the address names a
 * session.
 *
 * That last one is the whole of this ticket. A session used to replace the
 * page, so opening one was leaving the app; here the assertion is that the
 * sidebar the session list was drawn beside is the same sidebar the session
 * screen is drawn beside, and that it is one sidebar and not two.
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

/**
 * Mantine's popover-backed controls observe their target's box; jsdom has no
 * layout and no observer. A stub that reports nothing is enough -- nothing
 * here asserts on a measurement.
 */
function installResizeObserver(): void {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

/** Lets the ticket promise inside `connect` settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * One animation frame. Mantine's popovers place themselves with a floating-ui
 * measurement and open through a transition, so a dropdown reaches the
 * document a frame after the click that asked for it rather than in the same
 * flush.
 */
function frame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

const SESSION = sessionRefSchema.parse({
  storeId: 'store-agentplex',
  sessionId: 'session-migrate-db',
});

describe('the shell', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let store: HubStore;
  let tokens: TokenStore;
  let sockets: ReturnType<typeof createFakeSocketFactory>;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installResizeObserver();
    container = document.createElement('div');
    document.body.append(container);
    sockets = createFakeSocketFactory();
    store = createHubStore({
      fetchTicket: () => Promise.resolve('ticket-1'),
      createSocket: (ticket) => sockets.create(ticket),
      timers: createFakeTimers(),
      frameIds: createFrameIdCounter(),
    });
    const storage = fakeStorage();
    tokens = createTokenStore(() => storage);
    window.location.hash = '';
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
    window.location.hash = '';
  });

  function withProvider(element: JSX.Element): JSX.Element {
    return (
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="dark"
      >
        {element}
      </MantineProvider>
    );
  }

  /** Mounts the shell at the current address and walks it through to a fleet. */
  async function mount(): Promise<FakeSocket> {
    await act(async () => {
      root = createRoot(container);
      // No StrictMode: its simulated remount would subscribe, hang up and
      // dial again, and one dial is part of what the page test asserts.
      root.render(withProvider(<AppShell hub={store} tokens={tokens} />));
    });
    await act(settle);
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the shell dialled nothing');
    await act(() => {
      socket.open();
      socket.deliver(hubFrames.welcome);
      socket.deliver(hubFrames.machineStatePopulated);
    });
    return socket;
  }

  function sidebars(): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('aside')];
  }

  function navLinks(): HTMLAnchorElement[] {
    return [...container.querySelectorAll<HTMLAnchorElement>('nav a')];
  }

  /** Every session address a part of the page links to, in the order drawn. */
  function addresses(selector: string): string[] {
    return [...container.querySelectorAll<HTMLAnchorElement>(selector)].map(
      (link) => link.getAttribute('href') ?? '',
    );
  }

  /**
   * Picks a machine the way a person does: open the selector, then choose.
   * The dropdown is a portal, so it is looked for in the document rather than
   * in the container, and it is waited for rather than assumed -- see
   * `frame`.
   */
  async function pickMachine(label: string): Promise<void> {
    const target = container.querySelector<HTMLElement>('aside button');
    if (target === null) throw new Error('the sidebar drew no machine selector');
    await act(() => {
      target.click();
    });
    await act(settle);
    await act(frame);
    await act(settle);
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (candidate) => candidate.textContent?.includes(label) ?? false,
    );
    if (item === undefined) throw new Error(`the menu offers no ${label}`);
    await act(() => {
      item.click();
    });
  }

  /** The Projects/Sessions pair, by the name the sidebar gives that control. */
  function sidebarTabs(): HTMLInputElement[] {
    return [
      ...container.querySelectorAll<HTMLInputElement>(
        'aside [aria-label="What the sidebar shows"] input',
      ),
    ];
  }

  it('draws one sidebar, a top bar with the brand mark, and a content region', async () => {
    await mount();

    expect(sidebars()).toHaveLength(1);
    expect(container.querySelectorAll('header')).toHaveLength(1);
    expect(container.querySelectorAll('main')).toHaveLength(1);
    const brand = container.querySelector<HTMLAnchorElement>('header a[aria-label="agentplex"]');
    expect(brand?.getAttribute('href')).toBe(destinationHash('sessions'));
  });

  it('keeps the sidebar when the address names a session', async () => {
    window.location.hash = sessionHash(SESSION);

    await mount();

    // The session screen mounts in the content region rather than in place of
    // the page: the chrome is still there, and it is still one of it.
    expect(sidebars()).toHaveLength(1);
    expect(navLinks().map((link) => link.textContent)).toEqual(['Settings']);
  });

  it('offers both readings of the fleet, and the projects tree first', async () => {
    await mount();

    const tabs = sidebarTabs();
    expect(tabs.map((tab) => tab.value)).toEqual(['projects', 'sessions']);
    expect(tabs.find((tab) => tab.checked)?.value).toBe('projects');
  });

  it('lists the sessions in the sidebar when that is the reading chosen', async () => {
    await mount();
    const sessionsTab = sidebarTabs().find((input) => input.value === 'sessions');
    if (sessionsTab === undefined) throw new Error('the sidebar drew no sessions tab');

    await act(() => {
      sessionsTab.click();
    });

    const rows = [...container.querySelectorAll<HTMLAnchorElement>('aside a[href^="#/session/"]')];
    expect(rows.map((row) => row.getAttribute('aria-label'))).toContain('open migrate-db-v9');
  });

  /** The classes Mantine's breakpoint props leave behind, which is what the
   * shell uses to say which of the two is on screen below `md`. */
  function hiddenBelowMd(element: Element | null): boolean {
    return element?.classList.contains('mantine-visible-from-md') ?? false;
  }

  function theSidebarToggle(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(
      'header button[aria-label$="the sidebar"]',
    );
    if (button === null) throw new Error('the bar drew no sidebar toggle');
    return button;
  }

  it('closes the sidebar when the address changes, so the tap lands somewhere', async () => {
    await mount();
    await act(() => {
      theSidebarToggle().click();
    });

    // Open below the breakpoint: the sidebar is drawn at every width and the
    // content is the one that is not.
    expect(hiddenBelowMd(container.querySelector('aside'))).toBe(false);
    expect(hiddenBelowMd(container.querySelector('main'))).toBe(true);

    await act(async () => {
      window.location.hash = sessionHash(SESSION);
      await settle();
    });

    // And closed again by going somewhere -- a session row, a nav link or the
    // brand mark, all of which are this. Without it the phone shows the
    // sidebar it was tapped in and none of what was tapped.
    expect(hiddenBelowMd(container.querySelector('aside'))).toBe(true);
    expect(hiddenBelowMd(container.querySelector('main'))).toBe(false);
  });

  it('narrows both readings to the machine the selector picked', async () => {
    await mount();

    await pickMachine('gpu-box-01');

    // The cards are the fleet's own reading and the sidebar list is the
    // other; the selection is one fact with one writer, so the two cannot
    // answer it differently.
    const cards = addresses('main a[href^="#/session/"]');
    expect(cards).toEqual([
      '#/session/store-universe/session-docs-sweep',
      '#/session/store-universe/session-bench-tokenizer',
      '#/session/store-universe/session-train-lora',
    ]);

    const sessionsTab = sidebarTabs().find((input) => input.value === 'sessions');
    if (sessionsTab === undefined) throw new Error('the sidebar drew no sessions tab');
    await act(() => {
      sessionsTab.click();
    });

    expect(addresses('aside a[href^="#/session/"]')).toEqual(cards);
  });

  it('draws no nav row for a destination nothing is behind', async () => {
    await mount();

    const labels = navLinks().map((link) => link.textContent);
    expect(labels).not.toContain('Graphs');
    expect(labels).not.toContain('Library');
  });

  it('shows settings in the content region when the address names it', async () => {
    window.location.hash = destinationHash('settings');

    await mount();

    const main = container.querySelector('main');
    expect(main?.textContent).toContain('Pair a server');
    // And the nav says where the page is, rather than leaving the reader to
    // work it out from what is drawn.
    expect(navLinks()[0]?.getAttribute('aria-current')).toBe('page');
  });
});
