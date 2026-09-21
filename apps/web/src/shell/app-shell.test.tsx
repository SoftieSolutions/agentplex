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
 * That last one is the whole of AGX-122. A session used to replace the page,
 * so opening one was leaving the app; here the assertion is that the sidebar
 * the session list was drawn beside is the same sidebar the session screen is
 * drawn beside, and that it is one sidebar and not two.
 *
 * The phone form is mounted here too, at a window narrow enough to ask for it.
 * What that pins is the wiring rather than the layout -- one shell, one set of
 * addresses, one bell counting the fleet in both forms -- because jsdom has no
 * layout to assert on. The chrome's own drawing is `mobile-chrome.test.tsx`,
 * and the width rule is `shell-form.test.ts`.
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

/**
 * The catalogue panel, by the one control it always draws. Which region holds
 * it is the question in both suites below: the sidebar's on a wide screen, the
 * content region's on a phone, and never both at once.
 */
function catalogueSearchesIn(container: HTMLElement, region: string): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(`${region} [aria-label="Search the catalogue"]`),
  ];
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

/** The moment the fixture was reported, so a pinned clock gives the real ages. */
const NOW = 1_756_000_000_000;

describe('the shell', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let store: HubStore;
  let tokens: TokenStore;
  let sockets: ReturnType<typeof createFakeSocketFactory>;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    // jsdom's own default, restated because a test below narrows it.
    window.innerWidth = 1024;
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
    window.innerWidth = 1024;
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

  /**
   * Mounts the shell at the current address and walks it through to a fleet.
   *
   * The clock is the shell's own default unless a test pins one, because only
   * the tests about what an age says need it fixed. Handed over explicitly
   * rather than left off: `exactOptionalPropertyTypes` makes an absent prop
   * and an undefined one two different things.
   */
  async function mount(now: () => number = Date.now): Promise<FakeSocket> {
    await act(async () => {
      root = createRoot(container);
      // No StrictMode: its simulated remount would subscribe, hang up and
      // dial again, and one dial is part of what the page test asserts.
      root.render(withProvider(<AppShell hub={store} tokens={tokens} now={now} />));
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

  function catalogueSearches(region: string): HTMLElement[] {
    return catalogueSearchesIn(container, region);
  }

  /**
   * Presses the bell and waits for what it opens. The panel is a portal in
   * both forms of the shell, so it is looked for in the document rather than
   * in the container, and it is waited for rather than assumed -- see `frame`.
   */
  async function openBell(): Promise<void> {
    const bell = container.querySelector<HTMLButtonElement>('header [data-attention-bell]');
    if (bell === null) throw new Error('the chrome drew no bell');
    await act(() => {
      bell.click();
    });
    await act(settle);
    await act(frame);
    await act(settle);
  }

  /** Every session the open panel names, in the order it names them. */
  function panelRows(): string[] {
    return [
      ...document.body.querySelectorAll<HTMLAnchorElement>(
        '[role="dialog"] a[data-notification-row]',
      ),
    ].map((row) => row.getAttribute('href') ?? '');
  }

  /** Everything the open panel's rows say, in the order it drew them. */
  function panelRowWords(): string[] {
    return [
      ...document.body.querySelectorAll<HTMLAnchorElement>(
        '[role="dialog"] a[data-notification-row]',
      ),
    ].map((row) => row.textContent ?? '');
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

  it('fills the top bar slot with how the connection is doing', async () => {
    await mount();

    // Said even when all is well: a status line that empties when there is
    // nothing wrong is one nobody can tell apart from a broken one.
    const status = container.querySelector('header [role="status"]');
    expect(status?.textContent).toContain('connected');
    expect(status?.querySelector('a')).toBeNull();
  });

  it('hangs the bell in the top bar, counting the whole fleet', async () => {
    await mount();

    const bell = container.querySelector<HTMLButtonElement>('header [data-attention-bell]');
    expect(bell?.getAttribute('aria-label')).toBe('2 sessions need you');
    // A control and not an address: what it opens is the panel, which is why
    // it says whether it is open rather than where it goes.
    expect(bell?.getAttribute('href')).toBeNull();
    expect(bell?.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the bell on the whole fleet when the app is narrowed to one machine', async () => {
    await mount();

    await pickMachine('gpu-box-01');

    // The screen narrows and the bell does not. The bell is an ambient
    // surface, like the browser tab beside it -- neither has a machine
    // selector on it -- and two attention numbers that disagree because one of
    // them quietly answered a different question is how both stop being
    // believed. The chip counts what this screen is showing; the bell counts
    // what the app knows.
    const chips = [...container.querySelectorAll('main [aria-pressed]')].map(
      (chip) => chip.textContent,
    );
    expect(chips).toContain('Needs you · 1');
    expect(
      container
        .querySelector<HTMLButtonElement>('header [data-attention-bell]')
        ?.getAttribute('aria-label'),
    ).toBe('2 sessions need you');
  });

  it('opens the fleet’s own list, from a chrome narrowed to one machine', async () => {
    await mount();
    await pickMachine('gpu-box-01');

    await openBell();

    // The panel is the other half of the same claim. Narrowing the screen must
    // not quietly shorten what the bell opens, or the mark would count two and
    // the list under it would name one.
    expect(panelRows()).toEqual([
      '#/session/store-agentplex/session-migrate-db',
      '#/session/store-universe/session-docs-sweep',
    ]);
  });

  it('ages the panel’s rows by the clock it was handed', async () => {
    // The shell is where the fleet is turned into notifications, so the moment
    // those ages are measured from is read here. It is injected for the reason
    // the session list injects its own: a clock is something a test cannot
    // supply otherwise, and against the real one the fixture's rows read
    // however long ago it was captured -- a line nobody can assert on.
    await mount(() => NOW);

    await openBell();

    expect(panelRowWords()[0]).toContain('store-agentplex · mbp-robert · 3m');
  });

  it('names the missing token in the chrome, and links to where one is typed', async () => {
    // What an empty Bearer earns from the hub: an ordinary 401, a rejected
    // ticket exchange, and a retry that will never succeed. The store's own
    // words for that are honest and terminal; the chrome's name the token.
    store = createHubStore({
      fetchTicket: () => Promise.reject(new Error('the hub answered 401 at the ticket exchange')),
      createSocket: (ticket) => sockets.create(ticket),
      timers: createFakeTimers(),
      frameIds: createFrameIdCounter(),
    });
    await act(async () => {
      root = createRoot(container);
      root.render(withProvider(<AppShell hub={store} tokens={tokens} />));
    });
    await act(settle);

    const status = container.querySelector('header [role="status"]');
    expect(status?.textContent).toContain('no hub token on this device');
    const link = status?.querySelector('a');
    expect(link?.textContent).toBe('Settings');
    expect(link?.getAttribute('href')).toBe(destinationHash('settings'));
  });

  it('stops naming the token once one is stored, even while the hub refuses', async () => {
    tokens.write('token-typed-on-this-device');
    store = createHubStore({
      fetchTicket: () => Promise.reject(new Error('the hub answered 401 at the ticket exchange')),
      createSocket: (ticket) => sockets.create(ticket),
      timers: createFakeTimers(),
      frameIds: createFrameIdCounter(),
    });
    await act(async () => {
      root = createRoot(container);
      root.render(withProvider(<AppShell hub={store} tokens={tokens} />));
    });
    await act(settle);

    const status = container.querySelector('header [role="status"]');
    expect(status?.textContent).not.toContain('no hub token');
    expect(status?.querySelector('a')).toBeNull();
  });

  it('keeps the sidebar when the address names a session', async () => {
    window.location.hash = sessionHash(SESSION);

    await mount();

    // The session screen mounts in the content region rather than in place of
    // the page: the chrome is still there, and it is still one of it.
    expect(sidebars()).toHaveLength(1);
    expect(navLinks().map((link) => link.textContent)).toEqual(['Settings']);
  });

  it('lands on Settings when the chrome’s action is followed from over a session', async () => {
    // The one place an AGX-119 action is drawn over a session route is the
    // chrome, which is on screen at every address, so this is the click a
    // person actually makes: no token, from a session. It lands because
    // `destinationHash` is a route and not a fragment id -- the hash moves,
    // `useSessionRoute` stops parsing one, `parseDestinationHash` starts, and
    // the content region is decided again. Nothing is scrolled to, so there
    // is no element that has to be mounted when the browser goes looking.
    window.location.hash = sessionHash(SESSION);
    store = createHubStore({
      fetchTicket: () => Promise.reject(new Error('the hub answered 401 at the ticket exchange')),
      createSocket: (ticket) => sockets.create(ticket),
      timers: createFakeTimers(),
      frameIds: createFrameIdCounter(),
    });
    await act(async () => {
      root = createRoot(container);
      root.render(withProvider(<AppShell hub={store} tokens={tokens} />));
    });
    await act(settle);

    const link = container.querySelector<HTMLAnchorElement>('header [role="status"] a');
    if (link === null) throw new Error('the chrome offered no next action');
    await act(() => {
      link.click();
    });
    await act(settle);
    expect(window.location.hash).toBe(destinationHash('settings'));
    // jsdom moves the address on a task of its own and delivers no
    // `hashchange` for the move; a browser fires one for a click onto a
    // different fragment, and that event is what every route in this app
    // subscribes to. The same stand-in `onboarding-route.test.ts` uses,
    // delivered once the address has actually landed.
    await act(() => {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });

    // The screen the link named, by the field only it draws -- and the layout
    // screen gone, which is the half the address had to undo.
    expect(container.querySelector('main input[type="password"]')).not.toBeNull();
    expect(container.querySelector('main')?.textContent).not.toContain('stored layout');
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

  it('answers the session list for an address only the phone has a place for', async () => {
    // Sent from a phone, or left in a bookmark. The tree is in the sidebar at
    // this width, so the content region is the list it stands beside rather
    // than a second copy of the tree.
    window.location.hash = destinationHash('projects');

    await mount();

    expect(catalogueSearches('aside')).toHaveLength(1);
    expect(catalogueSearches('main')).toHaveLength(0);
    expect(container.querySelector('main')?.textContent).toContain('Sessions');
  });
});

describe('the shell on a phone', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let store: HubStore;
  let tokens: TokenStore;
  let sockets: ReturnType<typeof createFakeSocketFactory>;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installResizeObserver();
    // A phone in portrait, which `shellForm` reads as the phone chrome.
    window.innerWidth = 390;
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
    window.innerWidth = 1024;
  });

  async function mount(): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="dark"
        >
          <AppShell hub={store} tokens={tokens} />
        </MantineProvider>,
      );
    });
    await act(settle);
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the shell dialled nothing');
    await act(() => {
      socket.open();
      socket.deliver(hubFrames.welcome);
      socket.deliver(hubFrames.machineStatePopulated);
    });
  }

  function tabs(): HTMLAnchorElement[] {
    return [...container.querySelectorAll<HTMLAnchorElement>('nav a')];
  }

  function catalogueSearches(region: string): HTMLElement[] {
    return catalogueSearchesIn(container, region);
  }

  it('draws the tab bar instead of the sidebar, and one content region', async () => {
    await mount();

    expect(container.querySelectorAll('aside')).toHaveLength(0);
    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect(tabs().map((tab) => tab.textContent)).toEqual(['Sessions', 'Projects', 'More']);
  });

  it('hangs the bell in the phone header, and hangs no second count on the button', async () => {
    await mount();

    // One screen, one attention number: the same bell the wide form draws,
    // counting the same fleet. The action button wore a badge of its own once
    // -- narrowed by the machine this header picks, so it could disagree with
    // the bell above it by design -- and it no longer does.
    const bell = container.querySelector<HTMLButtonElement>('header [data-attention-bell]');
    expect(bell?.getAttribute('aria-label')).toBe('2 sessions need you');
    const chips = [...container.querySelectorAll('main [aria-pressed]')].map(
      (chip) => chip.textContent,
    );
    expect(chips).toContain('Needs you · 2');
    expect(container.querySelectorAll('[data-needs-you]')).toHaveLength(1);
    expect(
      container.querySelector('button[aria-label="Start a session"] + [role="status"]'),
    ).toBeNull();
  });

  it('opens the bell’s panel as a sheet, over whatever the address named', async () => {
    await mount();
    const bell = container.querySelector<HTMLButtonElement>('header [data-attention-bell]');
    if (bell === null) throw new Error('the phone chrome drew no bell');

    await act(() => {
      bell.click();
    });
    await act(settle);
    await act(frame);
    await act(settle);

    // One shell, one panel: the same two rows the wide form's popover holds,
    // in the container this form has room for. That it is a sheet rather than
    // a card is `attention-bell.test.tsx`; what is pinned here is that the
    // phone chrome's bell opens at all, over a content region it does not
    // replace.
    const panel = document.body.querySelector('[role="dialog"]');
    expect(panel?.querySelectorAll('a[data-notification-row]')).toHaveLength(2);
    expect(container.querySelectorAll('main')).toHaveLength(1);
  });

  it('puts the tree in the content region, where the Projects tab leads', async () => {
    window.location.hash = destinationHash('projects');

    await mount();

    // One tree, in the only place a phone has for one.
    expect(catalogueSearches('main')).toHaveLength(1);
    expect(tabs().find((tab) => tab.getAttribute('aria-current') === 'page')?.textContent).toBe(
      'Projects',
    );
  });

  it('holds the nav under More, from the same list the sidebar draws', async () => {
    window.location.hash = destinationHash('more');

    await mount();

    const main = container.querySelector('main');
    const rows = [...(main?.querySelectorAll<HTMLAnchorElement>('nav a') ?? [])];
    expect(rows.map((row) => row.textContent)).toEqual(['Settings']);
    expect(rows[0]?.getAttribute('href')).toBe(destinationHash('settings'));
  });

  it('takes the same session address the wide form does', async () => {
    window.location.hash = sessionHash(SESSION);

    await mount();

    expect(container.querySelectorAll('main')).toHaveLength(1);
    // A session is a thing and not one of the three places, so the bar points
    // at none of them -- and it is still there to leave by.
    expect(tabs()).toHaveLength(3);
    expect(tabs().filter((tab) => tab.hasAttribute('aria-current'))).toHaveLength(0);
    // And nothing floats over the terminal's bottom-right corner.
    expect(container.querySelector('button[aria-label="Start a session"]')).toBeNull();
  });
});
