// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sessionRefSchema, storeIdSchema } from '@agentplex/protocol';
import { fakeStorage } from '../auth/fake-storage.js';
import { createTokenStore, type TokenStore } from '../auth/token.js';
import { createMockSwitch, type MockSwitch } from '../mock/mock-switch.js';
import { MockModeProvider } from '../mock/use-mock-mode.js';
import { ONBOARDING_HASH } from '../onboarding/onboarding-route.js';
import { createFakeSocketFactory, type FakeSocket } from '../store/fake-socket.js';
import { createFrameIds } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import type { HubCommand } from '../store/commands.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createLayoutStore, type LayoutStore } from '../layout/layout-store.js';
import { panes } from '../layout/operations.js';
import { NAMING_BOUND_MS } from '../terminal/pending-pane-model.js';
import { startHash } from '../terminal/start-route.js';
import { createFakeTimers } from '../store/timers.js';
import { installFlowMocks } from '../graphs/flow-test-setup.js';
import { graphHash } from '../graphs/graph-route.js';
import { nodeIdSchema } from '@agentplex/protocol';
import { sessionHash } from '../terminal/session-route.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { AppShell } from './app-shell.js';
import { createSidebarWidth, type SidebarWidth } from './sidebar-width.js';
import { destinationHash, settingsSectionHash } from './destinations.js';
import type { NewNodeKind } from './new-menu-model.js';

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
function cataloguePanelsIn(container: HTMLElement, region: string): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(`${region} [aria-label="View"]`)];
}

/**
 * The start form's autosizing prompt waits on the font set; jsdom ships none.
 * The same stand-in `new-session-form.test.tsx` installs, needed here because
 * the chrome is what opens that form now.
 */
function installFontFaceSet(): void {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { addEventListener: () => {}, removeEventListener: () => {} },
  });
}

/**
 * Every button the page holds, by what it says. The forms open into a portal,
 * so the document is the haystack and not the container: what names a form as
 * open is the button that submits it -- "Start session", "Create project" --
 * because each belongs to one form and to nothing else on the page.
 */
function buttonWords(): string[] {
  return [...document.body.querySelectorAll('button')].map((button) => button.textContent ?? '');
}

/** What the screen under the chrome offers, which is the other half of that. */
function screenButtonWords(container: HTMLElement): string[] {
  return [...container.querySelectorAll('main button')].map((button) => button.textContent ?? '');
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

/** A fresh spawn, as the New form sends one. */
const START: HubCommand = {
  type: 'session-start',
  storeId: storeIdSchema.parse('store-agentplex'),
  sessionId: null,
  provider: 'claude',
  prompt: null,
  server: null,
  project: null,
};

/** A captured reply, re-addressed to the frame this test's store sent. */
function addressedTo(frame: string, replyTo: number): string {
  const parsed: unknown = JSON.parse(frame);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('not a frame');
  return JSON.stringify({ ...parsed, replyTo });
}

describe('the shell', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let store: HubStore;
  let tokens: TokenStore;
  let sidebarWidth: SidebarWidth;
  let sockets: ReturnType<typeof createFakeSocketFactory>;

  beforeAll(() => {
    // The graph screen mounts the canvas, which measures with what jsdom lacks.
    installFlowMocks();
  });

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    // jsdom's own default, restated because a test below narrows it.
    window.innerWidth = 1024;
    installMatchMedia();
    installResizeObserver();
    installFontFaceSet();
    container = document.createElement('div');
    document.body.append(container);
    sockets = createFakeSocketFactory();
    store = createHubStore({
      fetchTicket: () => Promise.resolve('ticket-1'),
      createSocket: (ticket) => sockets.create(ticket),
      timers: createFakeTimers(),
      frameIds: createFrameIds(),
    });
    const storage = fakeStorage();
    tokens = createTokenStore(() => storage);
    // Never jsdom's own localStorage, which every test in the run shares.
    sidebarWidth = createSidebarWidth({ storage: () => storage });
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
        // Mantine hides a dropdown whose target it measures as detached, and in
        // a DOM with no layout every target measures that way. The chrome's
        // popovers trap their focus, and a dropdown Mantine has hidden is one
        // its own trap reads as holding nothing worth focusing; `env="test"` is
        // Mantine's switch for exactly that.
        env="test"
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
  async function mount(
    now: () => number = Date.now,
    mock: MockSwitch | null = null,
    layoutStore?: LayoutStore,
  ): Promise<FakeSocket> {
    const shell = (
      <AppShell
        hub={store}
        tokens={tokens}
        now={now}
        sidebarWidth={sidebarWidth}
        // Only where a test reads the panes: the page's own layout store
        // is a singleton bound to the first hub store this file built.
        {...(layoutStore === undefined ? {} : { layoutStore })}
      />
    );
    await act(async () => {
      root = createRoot(container);
      // No StrictMode: its simulated remount would subscribe, hang up and
      // dial again, and one dial is part of what the page test asserts.
      root.render(
        withProvider(
          mock === null ? shell : <MockModeProvider mock={mock}>{shell}</MockModeProvider>,
        ),
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
    return socket;
  }

  function sidebars(): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('aside')];
  }

  /** The rows of the nav at the sidebar's foot. */
  function navLinks(): HTMLAnchorElement[] {
    return [
      ...container.querySelectorAll<HTMLAnchorElement>('aside nav[aria-label="Destinations"] a'),
    ];
  }

  /** The settings sections the sidebar offers while the address is a settings one. */
  function sectionLinks(): HTMLAnchorElement[] {
    return [
      ...container.querySelectorAll<HTMLAnchorElement>(
        'aside nav[aria-label="Settings sections"] a',
      ),
    ];
  }

  /** A switch that exists and is off, so the Developer section is one there is. */
  function anySwitch(): MockSwitch {
    return createMockSwitch({ storage: () => fakeStorage(), search: () => '' });
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

  function cataloguePanels(region: string): HTMLElement[] {
    return cataloguePanelsIn(container, region);
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

  /**
   * Presses the chrome's New button and waits for the popover it opens, the
   * way `openBell` waits for the panel it opens: the dropdown is a portal
   * placed a frame after the click that asked for it.
   */
  async function openNewMenu(): Promise<void> {
    const button = container.querySelector<HTMLButtonElement>('header button[data-new-menu]');
    if (button === null) throw new Error('the chrome drew no New button');
    await act(() => {
      button.click();
    });
    await act(settle);
    await act(frame);
    await act(settle);
  }

  /** One row of the open menu, which portals out of the shell like the panel. */
  function newMenuRow(kind: NewNodeKind): HTMLElement {
    const row = document.body.querySelector<HTMLElement>(`[data-new-menu-entry="${kind}"]`);
    if (row === null) throw new Error(`the menu drew no ${kind} row`);
    return row;
  }

  /** Chooses a kind and lets whatever that opens reach the document. */
  async function pickNew(kind: NewNodeKind): Promise<void> {
    await openNewMenu();
    await act(() => {
      newMenuRow(kind).click();
    });
    await act(settle);
    await act(frame);
    await act(settle);
  }

  /** The Projects/Sessions pair, by the name the sidebar gives that control. */
  function sidebarTabs(): HTMLInputElement[] {
    return [
      ...container.querySelectorAll<HTMLInputElement>(
        'aside [aria-label="What the sidebar shows"] input',
      ),
    ];
  }

  /** Which reading of the fleet the sidebar is showing. */
  function chosenTab(): string | undefined {
    return sidebarTabs().find((tab) => tab.checked)?.value;
  }

  /** Chooses the Sessions reading the way a person does: by pressing the tab. */
  async function chooseSessionsTab(): Promise<void> {
    const tab = sidebarTabs().find((input) => input.value === 'sessions');
    if (tab === undefined) throw new Error('the sidebar drew no sessions tab');
    await act(() => {
      tab.click();
    });
  }

  /**
   * Follows an address the way a browser does. jsdom moves the hash on a task
   * of its own and delivers no `hashchange` for the move; the event is what
   * every route in this app subscribes to, so it is fired here -- the same
   * stand-in the Settings action test above uses.
   */
  async function follow(hash: string): Promise<void> {
    window.location.hash = hash;
    await act(() => {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
  }

  it('draws one sidebar, a top bar with the brand mark, and a content region', async () => {
    await mount();

    expect(sidebars()).toHaveLength(1);
    expect(container.querySelectorAll('header')).toHaveLength(1);
    expect(container.querySelectorAll('main')).toHaveLength(1);
    const brand = container.querySelector<HTMLAnchorElement>('header a[aria-label="agentplex"]');
    expect(brand?.getAttribute('href')).toBe(destinationHash('sessions'));
  });

  it('draws one edge the sidebar is widened by', async () => {
    // What the edge does is `sidebar-frame.test.tsx`; here it is that the wide
    // chrome has exactly one.
    await mount();

    expect(
      container.querySelectorAll('[role="separator"][aria-label="Resize sidebar"]'),
    ).toHaveLength(1);
  });

  it('fills the top bar slot with how the connection is doing', async () => {
    await mount();

    // Said even when all is well: a status line that empties when there is
    // nothing wrong is one nobody can tell apart from a broken one.
    const status = container.querySelector('header [data-connection-status]');
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

  it('hangs the palette between the mark and the chrome’s own controls', async () => {
    await mount();

    // The chrome's own order: the mark, the thing you search with, then how
    // things are and what the chrome offers at every address. Where the search
    // sits along the bar is `top-bar.tsx`'s; this is only the reading order.
    const bar = [
      ...container.querySelectorAll<HTMLElement>(
        'header a[aria-label="agentplex"], header [data-palette-trigger], header [data-attention-bell]',
      ),
    ];
    expect(bar).toHaveLength(3);
    expect(bar[1]?.hasAttribute('data-palette-trigger')).toBe(true);
  });

  it('opens the palette on the whole fleet, from the chrome and not from a screen', async () => {
    await mount();
    const control = container.querySelector<HTMLButtonElement>('header [data-palette-trigger]');
    if (control === null) throw new Error('the chrome drew no palette trigger');

    await act(() => {
      control.click();
    });
    await act(settle);
    await act(frame);
    await act(settle);

    // Every session the hub reported, and not the narrowing the screen behind
    // it happens to be under: the palette is handed the fleet on purpose, and
    // `palette-model.ts` is where that argument lives.
    expect(
      document.body.querySelectorAll('[data-palette-dialog] a[data-palette-result]'),
    ).toHaveLength(6);
  });

  it('hangs the New menu in the top bar, after the bell as the mockup draws it', async () => {
    await mount();

    // One control for everything this app can make, in the chrome rather than
    // on a screen, because it is offered at every address.
    const slot = [
      ...container.querySelectorAll<HTMLElement>(
        'header [data-attention-bell], header [data-new-menu]',
      ),
    ];
    expect(slot.map((control) => control.hasAttribute('data-new-menu'))).toEqual([false, true]);
  });

  it('leaves the screen under it no second way to start either kind', async () => {
    await mount();

    // The whole of this step: the list screen's own two buttons are gone in
    // this form, so New is the one way in, and nobody has to learn which of
    // two controls the app meant.
    const words = screenButtonWords(container);
    expect(words).not.toContain('New session');
    expect(words).not.toContain('New project');
  });

  it('opens the start form when the menu’s Session row is chosen', async () => {
    await mount();
    expect(buttonWords()).not.toContain('Start session');

    await pickNew('session');

    // One form and not two: the chrome owns the only NewSessionForm in the
    // page now, so a start opens a pane whichever control asked for it.
    expect(buttonWords().filter((word) => word === 'Start session')).toHaveLength(1);
  });

  it('opens the project form when the menu’s Project row is chosen', async () => {
    await mount();
    expect(buttonWords()).not.toContain('Create project');

    await pickNew('project');

    expect(buttonWords().filter((word) => word === 'Create project')).toHaveLength(1);
  });

  it('opens the graph form when the menu’s Graph row is chosen', async () => {
    await mount();
    expect(buttonWords()).not.toContain('Create graph');

    await pickNew('graph');

    expect(buttonWords().filter((word) => word === 'Create graph')).toHaveLength(1);
  });

  it('sends Enroll machine to onboarding, as an address and not a form', async () => {
    await mount();
    await openNewMenu();

    const row = newMenuRow('machine');
    expect(row.tagName).toBe('A');
    expect(row.getAttribute('href')).toBe(ONBOARDING_HASH);
    await act(() => {
      row.click();
    });
    await act(settle);

    // The second way into onboarding, which is what "you can enroll more
    // machines later" was a promise of. The hash is the whole of it: what
    // answers that address is `App.tsx`, above this shell.
    expect(window.location.hash).toBe(ONBOARDING_HASH);
  });

  it('names the missing token in the chrome, and links to where one is typed', async () => {
    // What an empty Bearer earns from the hub: an ordinary 401, a rejected
    // ticket exchange, and a retry that will never succeed. The store's own
    // words for that are honest and terminal; the chrome's name the token.
    store = createHubStore({
      fetchTicket: () => Promise.reject(new Error('the hub answered 401 at the ticket exchange')),
      createSocket: (ticket) => sockets.create(ticket),
      timers: createFakeTimers(),
      frameIds: createFrameIds(),
    });
    await act(async () => {
      root = createRoot(container);
      root.render(
        withProvider(<AppShell hub={store} tokens={tokens} sidebarWidth={sidebarWidth} />),
      );
    });
    await act(settle);

    const status = container.querySelector('header [data-connection-status]');
    expect(status?.textContent).toContain('no hub token on this device');
    const link = status?.querySelector('a');
    expect(link?.textContent).toBe('Settings');
    expect(link?.getAttribute('href')).toBe(settingsSectionHash('connections'));
  });

  it('stops naming the token once one is stored, even while the hub refuses', async () => {
    tokens.write('token-typed-on-this-device');
    store = createHubStore({
      fetchTicket: () => Promise.reject(new Error('the hub answered 401 at the ticket exchange')),
      createSocket: (ticket) => sockets.create(ticket),
      timers: createFakeTimers(),
      frameIds: createFrameIds(),
    });
    await act(async () => {
      root = createRoot(container);
      root.render(
        withProvider(<AppShell hub={store} tokens={tokens} sidebarWidth={sidebarWidth} />),
      );
    });
    await act(settle);

    const status = container.querySelector('header [data-connection-status]');
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

  it('draws the list for a start address this tab never asked for', async () => {
    // A start's frame id is this tab's own name for it, so a reload or a
    // pasted link carries a number that means nothing here: the list, not a
    // blank region and not a pane waiting on nothing.
    window.location.hash = '#/start/999';

    await mount();

    const main = container.querySelector('main');
    expect(main?.textContent).toContain('Sessions');
    expect(main?.textContent).not.toContain('starting');
  });

  it('draws the pane waiting on a start this tab sent, at its address', async () => {
    const layoutStore = createLayoutStore({ hub: store, timers: createFakeTimers() });
    const socket = await mount(Date.now, null, layoutStore);
    // In act: the start is filed in the snapshot the shell is subscribed to,
    // so sending it renders.
    const sent = await act(() => store.sendCommand(START));
    if (!sent.accepted) throw new Error(sent.reason);

    await follow(startHash(sent.id));
    await act(() => {
      socket.deliver(hubFrames.paneLayoutEmpty);
      socket.deliver(addressedTo(hubFrames.sessionStarted, sent.id));
    });

    expect(container.querySelector('main')?.textContent).toContain('starting on mbp-robert');
  });

  it('shows the session a named start became when its address is visited again', async () => {
    const layoutStore = createLayoutStore({ hub: store, timers: createFakeTimers() });
    const socket = await mount(Date.now, null, layoutStore);
    // In act: the start is filed in the snapshot the shell is subscribed to,
    // so sending it renders.
    const sent = await act(() => store.sendCommand(START));
    if (!sent.accepted) throw new Error(sent.reason);

    await follow(startHash(sent.id));
    await act(() => {
      socket.deliver(hubFrames.paneLayoutEmpty);
      socket.deliver(addressedTo(hubFrames.sessionStarted, sent.id));
      socket.deliver(addressedTo(hubFrames.sessionNamed, sent.id));
    });
    const named = sessionRefSchema.parse({ storeId: 'store-work', sessionId: 'session-spawned' });
    // Focus elsewhere, as a split leaves it: a pane opened on the start here
    // would rebind at once to the session the first pane already shows.
    await act(() => layoutStore.split('row'));

    // Away to the list and back, twice: the remount shows the address again.
    for (let visit = 0; visit < 2; visit += 1) {
      await follow('#/');
      await follow(startHash(sent.id));
    }

    const showing = panes(layoutStore.getSnapshot().tree)
      .map(({ leaf }) => leaf.content)
      .filter((content) => content.type !== 'empty');
    expect(showing).toEqual([{ type: 'session', session: named }]);
  });

  /**
   * Builds this test's store again on a clock and timers it holds, so it can
   * drop the connection and redial, or move time past the naming bound, and the
   * shell reads the same clock the store stamped the yes with.
   */
  function storeOn(now: () => number): ReturnType<typeof createFakeTimers> {
    const timers = createFakeTimers();
    store = createHubStore({
      fetchTicket: () => Promise.resolve('ticket-1'),
      createSocket: (ticket) => sockets.create(ticket),
      timers,
      frameIds: createFrameIds(),
      now,
    });
    return timers;
  }

  /** The sidebar's rows for starts with no session yet, by their accessible names. */
  function pendingRowNames(): string[] {
    return [...container.querySelectorAll('aside button[aria-label*=" session starting in "]')].map(
      (button) => button.getAttribute('aria-label') ?? '',
    );
  }

  /** Sends the start, opens its address, and has the hub place it. */
  async function placedStart(socket: FakeSocket): Promise<number> {
    const sent = await act(() => store.sendCommand(START));
    if (!sent.accepted) throw new Error(sent.reason);
    await follow(startHash(sent.id));
    await act(() => {
      socket.deliver(hubFrames.paneLayoutEmpty);
      socket.deliver(addressedTo(hubFrames.sessionStarted, sent.id));
    });
    return sent.id;
  }

  it('lists no start and draws no pane for it on a connection after the one that carried it', async () => {
    const timers = storeOn(Date.now);
    const layoutStore = createLayoutStore({ hub: store, timers: createFakeTimers() });
    const socket = await mount(Date.now, null, layoutStore);
    await chooseSessionsTab();
    await placedStart(socket);
    expect(pendingRowNames()).toHaveLength(1);
    expect(container.querySelector('main')?.textContent).toContain('starting on mbp-robert');

    // The connection drops between the yes and the naming. The hub forgot this
    // socket's start handles when it closed, so the name cannot come now.
    await act(() => {
      socket.drop();
    });
    await act(() => {
      timers.fireAll();
    });
    await act(settle);
    // The newest socket rather than the second: what dialled in between is
    // the redial's business, and the one that will be welcomed is the last.
    const next = sockets.sockets.at(-1);
    if (next === undefined || next === socket) throw new Error('the store did not redial');
    await act(() => {
      next.open();
      next.deliver(hubFrames.welcome);
      next.deliver(hubFrames.machineStatePopulated);
    });

    expect(pendingRowNames()).toEqual([]);
    const main = container.querySelector('main');
    expect(main?.textContent).toContain('Sessions');
    expect(main?.textContent).not.toContain('starting on');
  });

  it('lists no start and draws no pane for it while the connection that carried it is down', async () => {
    const timers = storeOn(Date.now);
    const layoutStore = createLayoutStore({ hub: store, timers: createFakeTimers() });
    const socket = await mount(Date.now, layoutStore);
    await chooseSessionsTab();
    const id = await placedStart(socket);
    expect(pendingRowNames()).toHaveLength(1);

    // The hub forgets this socket's start handles at the close, not at the next
    // welcome: through a long outage the store is backing off and counts no
    // welcome at all, and the name still cannot come.
    await act(() => {
      socket.drop();
    });

    expect(pendingRowNames()).toEqual([]);
    const main = container.querySelector('main');
    expect(main?.textContent).toContain('Sessions');
    expect(main?.textContent).not.toContain('starting on');

    // A redial the hub refuses on the protocol version stops the store
    // redialling for good, so no welcome ever comes to count; the start stays
    // gone rather than coming back as "starting" over a failed connection.
    await act(() => {
      timers.fireAll();
    });
    await act(settle);
    const next = sockets.sockets.at(-1);
    if (next === undefined || next === socket) throw new Error('the store did not redial');
    await act(() => {
      next.open();
      next.deliver(hubFrames.refusalProtocolVersion);
    });
    expect(store.getSnapshot().phase).toBe('failed');

    await follow('#/');
    await follow(startHash(id));
    expect(pendingRowNames()).toEqual([]);
    expect(container.querySelector('main')?.textContent).not.toContain('starting on');
    expect(container.querySelector('main')?.textContent).toContain('Sessions');
  });

  it('stops listing a start, and drawing its pane, once its name is overdue', async () => {
    let clock = 1_000_000;
    storeOn(() => clock);
    const layoutStore = createLayoutStore({ hub: store, timers: createFakeTimers() });
    const socket = await mount(() => clock, layoutStore);
    await chooseSessionsTab();
    await placedStart(socket);
    expect(pendingRowNames()).toHaveLength(1);

    clock += NAMING_BOUND_MS;
    // Any frame draws the shell again; the bound is read when it does.
    await act(() => {
      socket.deliver(hubFrames.machineStatePopulated);
    });

    expect(pendingRowNames()).toEqual([]);
    expect(container.querySelector('main')?.textContent).not.toContain('starting on');
  });

  /**
   * Has the hub answer the pane's subscribe by start handle: the captured
   * pending reply, re-addressed to the subscribe this store sent and to this
   * test's start.
   */
  async function relayStart(socket: FakeSocket, startId: number): Promise<void> {
    const subscribe = socket.sent
      .map((text): unknown => JSON.parse(text))
      .filter(
        (frame): frame is { id: number; type: string } =>
          typeof frame === 'object' &&
          frame !== null &&
          'type' in frame &&
          frame.type === 'session-subscribe',
      )
      .at(-1);
    if (subscribe === undefined) throw new Error('the pending pane sent no subscribe');
    const parsed: unknown = JSON.parse(hubFrames.sessionSubscribedPending);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not a frame');
    await act(() => {
      socket.deliver(JSON.stringify({ ...parsed, replyTo: subscribe.id, startId }));
    });
  }

  it('keeps listing an unnamed start past the bound while its terminal is relayed, until it ends', async () => {
    let clock = 1_000_000;
    storeOn(() => clock);
    const layoutStore = createLayoutStore({ hub: store, timers: createFakeTimers() });
    const socket = await mount(() => clock, layoutStore);
    await chooseSessionsTab();
    const id = await placedStart(socket);
    await relayStart(socket, id);

    // Seventy seconds unnamed: a spawn with no prompt that somebody may be
    // typing into. The pane keeps its address, so the row keeps the way back.
    clock += 70_000;
    await act(() => {
      socket.deliver(hubFrames.machineStatePopulated);
    });
    expect(pendingRowNames()).toHaveLength(1);
    expect(window.location.hash).toBe(startHash(id));
    expect(container.querySelector('main')?.textContent).toContain('starting on mbp-robert');

    // The terminal ends: nothing is relaying it, and past the bound nothing
    // more is owed, so the row goes and the address falls to the list.
    const ended: unknown = JSON.parse(hubFrames.sessionSubscriptionEnded);
    if (typeof ended !== 'object' || ended === null) throw new Error('not a frame');
    await act(() => {
      socket.deliver(
        JSON.stringify({
          ...ended,
          target: { by: 'start', startId: id },
          reason: 'session-ended',
        }),
      );
    });
    expect(pendingRowNames()).toEqual([]);
    expect(container.querySelector('main')?.textContent).not.toContain('starting on');
  });

  it('stops listing a relayed start past the bound once the hub names it', async () => {
    let clock = 1_000_000;
    storeOn(() => clock);
    const layoutStore = createLayoutStore({ hub: store, timers: createFakeTimers() });
    const socket = await mount(() => clock, layoutStore);
    await chooseSessionsTab();
    const id = await placedStart(socket);
    await relayStart(socket, id);
    clock += 70_000;
    await act(() => {
      socket.deliver(hubFrames.machineStatePopulated);
    });
    expect(pendingRowNames()).toHaveLength(1);

    await act(() => {
      socket.deliver(addressedTo(hubFrames.sessionNamed, id));
    });

    // Named, so the scan lists it under its own row: a second would be one
    // agent drawn twice.
    expect(pendingRowNames()).toEqual([]);
  });

  it('keeps showing the session a start was named in time, past the bound', async () => {
    let clock = 1_000_000;
    storeOn(() => clock);
    const layoutStore = createLayoutStore({ hub: store, timers: createFakeTimers() });
    const socket = await mount(() => clock, layoutStore);
    await chooseSessionsTab();
    const id = await placedStart(socket);
    clock += 1_000;
    await act(() => {
      socket.deliver(addressedTo(hubFrames.sessionNamed, id));
    });

    clock += NAMING_BOUND_MS;
    await follow('#/');
    await follow(startHash(id));

    expect(pendingRowNames()).toEqual([]);
    const named = sessionRefSchema.parse({ storeId: 'store-work', sessionId: 'session-spawned' });
    const showing = panes(layoutStore.getSnapshot().tree)
      .map(({ leaf }) => leaf.content)
      .filter((content) => content.type !== 'empty');
    expect(showing).toEqual([{ type: 'session', session: named }]);
    expect(container.querySelector('main')?.textContent).not.toContain('Sessions');
  });

  it('keeps the sidebar when the address names a graph, and draws the graph in the content region', async () => {
    window.location.hash = graphHash(nodeIdSchema.parse('hub-10'));

    const socket = await mount();
    await act(() => {
      socket.deliver(hubFrames.graphDocument);
    });

    // A graph is a screen and not a pane: it is drawn straight into the
    // content region rather than through the pane layout, whose persisted
    // shape knows sessions and documents and is not widened here.
    expect(sidebars()).toHaveLength(1);
    const main = container.querySelector('main')?.textContent ?? '';
    expect(main).toContain('release-pipeline');
    expect(main).toContain('v2 · draft');
    expect(main).not.toContain('stored layout');
  });

  it('lands on Settings when the chrome’s action is followed from over a session', async () => {
    // The one place an AGX-119 action is drawn over a session route is the
    // chrome, which is on screen at every address, so this is the click a
    // person actually makes: no token, from a session. It lands because
    // the settings address is a route and not a fragment id -- the hash moves,
    // `useSessionRoute` stops parsing one, `parseDestinationHash` starts, and
    // the content region is decided again. Nothing is scrolled to, so there
    // is no element that has to be mounted when the browser goes looking.
    window.location.hash = sessionHash(SESSION);
    store = createHubStore({
      fetchTicket: () => Promise.reject(new Error('the hub answered 401 at the ticket exchange')),
      createSocket: (ticket) => sockets.create(ticket),
      timers: createFakeTimers(),
      frameIds: createFrameIds(),
    });
    await act(async () => {
      root = createRoot(container);
      root.render(
        withProvider(<AppShell hub={store} tokens={tokens} sidebarWidth={sidebarWidth} />),
      );
    });
    await act(settle);

    const link = container.querySelector<HTMLAnchorElement>('header [data-connection-status] a');
    if (link === null) throw new Error('the chrome offered no next action');
    await act(() => {
      link.click();
    });
    await act(settle);
    expect(window.location.hash).toBe(settingsSectionHash('connections'));
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

    await mount(Date.now, anySwitch());

    const main = container.querySelector('main');
    expect(main?.textContent).toContain('Pair a server');
    // And the nav says where the page is, rather than leaving the reader to
    // work it out from what is drawn.
    expect(navLinks()[0]?.getAttribute('aria-current')).toBe('page');
  });

  it('turns the sidebar to the settings sections while the address is a settings one', async () => {
    window.location.hash = destinationHash('settings');

    await mount(Date.now, anySwitch());

    // Plain `#/settings` is Connections, and the column says so.
    expect(sectionLinks().map((link) => link.textContent)).toEqual([
      'Connections',
      'Preferences',
      'Developer',
    ]);
    expect(sectionLinks().map((link) => link.getAttribute('aria-current'))).toEqual([
      'page',
      null,
      null,
    ]);
    // Nothing that narrows a fleet: no tabs, no filter, no tree.
    expect(sidebarTabs()).toHaveLength(0);
    expect(container.querySelector('aside input[aria-label="Filter tree"]')).toBeNull();
    expect(cataloguePanels('aside')).toHaveLength(0);
    // The section links live in the column; the screen beside it draws none.
    expect(container.querySelector('main nav[aria-label="Settings sections"]')).toBeNull();
  });

  it('draws the section the address names, and marks it current in the column', async () => {
    window.location.hash = settingsSectionHash('preferences');

    await mount(Date.now, anySwitch());

    const main = container.querySelector('main')?.textContent ?? '';
    expect(main).toContain('Appearance');
    expect(main).not.toContain('Pair a server');
    expect(
      sectionLinks()
        .filter((link) => link.getAttribute('aria-current') === 'page')
        .map((link) => link.textContent),
    ).toEqual(['Preferences']);
  });

  it('offers no Developer section, and opens Connections for its address, with no switch', async () => {
    window.location.hash = settingsSectionHash('developer');

    await mount();

    expect(sectionLinks().map((link) => link.textContent)).toEqual(['Connections', 'Preferences']);
    expect(sectionLinks()[0]?.getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('main')?.textContent).toContain('Pair a server');
  });

  it('gives the fleet controls back on leaving settings, on the reading chosen before', async () => {
    // The tab and the tree's letters are held above the branch that draws the
    // section nav, so a visit to settings is not a reset of the column.
    await mount();
    await chooseSessionsTab();
    expect(chosenTab()).toBe('sessions');

    await follow(destinationHash('settings'));
    expect(sidebarTabs()).toHaveLength(0);

    await follow(destinationHash('sessions'));
    expect(sectionLinks()).toHaveLength(0);
    expect(chosenTab()).toBe('sessions');
  });

  it('answers the session list for an address only the phone has a place for', async () => {
    // Sent from a phone, or left in a bookmark. The tree is in the sidebar at
    // this width, so the content region is the list it stands beside rather
    // than a second copy of the tree.
    window.location.hash = destinationHash('projects');

    await mount();

    expect(cataloguePanels('aside')).toHaveLength(1);
    expect(cataloguePanels('main')).toHaveLength(0);
    expect(container.querySelector('main')?.textContent).toContain('Sessions');
  });

  it('turns the sidebar to the tree when the address names the projects', async () => {
    // What following a project row out of the palette does at this width: the
    // row is an anchor at `#/projects`, the content region stays the list it
    // already was, and the tree is in the column. A sidebar reading Sessions
    // would leave that click with nothing visible behind it.
    await mount();
    await chooseSessionsTab();
    expect(chosenTab()).toBe('sessions');

    await follow(destinationHash('projects'));

    expect(chosenTab()).toBe('projects');
    expect(cataloguePanels('aside')).toHaveLength(1);
  });

  it('lets a person choose the other reading under that same address', async () => {
    // The address says where the app was sent, not which reading it is pinned
    // to: a sidebar that put the tree back on every render would be a tab pair
    // one of whose tabs cannot be pressed.
    const socket = await mount();
    await follow(destinationHash('projects'));

    await chooseSessionsTab();
    expect(chosenTab()).toBe('sessions');

    await act(() => {
      socket.deliver(hubFrames.machineStatePopulated);
    });

    expect(chosenTab()).toBe('sessions');
  });
});

describe('the shell on a phone', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let store: HubStore;
  let tokens: TokenStore;
  let sidebarWidth: SidebarWidth;
  let sockets: ReturnType<typeof createFakeSocketFactory>;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installResizeObserver();
    installFontFaceSet();
    // A phone in portrait, which `shellForm` reads as the phone chrome.
    window.innerWidth = 390;
    container = document.createElement('div');
    document.body.append(container);
    sockets = createFakeSocketFactory();
    store = createHubStore({
      fetchTicket: () => Promise.resolve('ticket-1'),
      createSocket: (ticket) => sockets.create(ticket),
      timers: createFakeTimers(),
      frameIds: createFrameIds(),
    });
    const storage = fakeStorage();
    tokens = createTokenStore(() => storage);
    // Never jsdom's own localStorage, which every test in the run shares.
    sidebarWidth = createSidebarWidth({ storage: () => storage });
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
          <AppShell hub={store} tokens={tokens} sidebarWidth={sidebarWidth} />
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

  /** The tab bar's own links, by the name it gives its nav. */
  function tabs(): HTMLAnchorElement[] {
    return [...container.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Sections"] a')];
  }

  function cataloguePanels(region: string): HTMLElement[] {
    return cataloguePanelsIn(container, region);
  }

  it('draws the tab bar instead of the sidebar, and one content region', async () => {
    await mount();

    expect(container.querySelectorAll('aside')).toHaveLength(0);
    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect(tabs().map((tab) => tab.textContent)).toEqual(['Sessions', 'Projects', 'More']);
  });

  it('draws no sidebar edge, because there is no sidebar to widen', async () => {
    await mount();

    expect(
      container.querySelectorAll('[role="separator"][aria-label="Resize sidebar"]'),
    ).toHaveLength(0);
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

  it('draws the palette on its own row under the phone header, not squeezed into it', async () => {
    await mount();

    // Mockup 6c. The same control the top bar draws, in the place a phone has
    // room for it: the header row is the selector and the two slots already.
    const header = container.querySelector('header');
    const control = header?.querySelector('[data-palette-trigger]');
    expect(control).not.toBeNull();
    expect(header?.firstElementChild?.contains(control ?? null)).toBe(false);
  });

  it('draws no New menu, because the action button is what starts a session here', async () => {
    await mount();

    // The popover is the wide form's. A phone that drew both would offer two
    // ways to start a session on one screen, which is the thing the wide form
    // just stopped doing.
    expect(container.querySelector('[data-new-menu]')).toBeNull();
    expect(container.querySelector('button[aria-label="Start a session"]')).not.toBeNull();
    // And the screen keeps its own New project, because nothing in this
    // chrome starts one: a phone that could start neither could only watch.
    expect(screenButtonWords(container)).toContain('New project');
  });

  it('opens the shell’s one start form from the action button', async () => {
    await mount();
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Start a session"]',
    );
    if (button === null) throw new Error('the phone chrome drew no action button');

    await act(() => {
      button.click();
    });
    await act(settle);
    await act(frame);
    await act(settle);

    // The same single form the wide menu opens, and the same wiring with it:
    // a second copy owned by the screen is what used to start a session
    // without opening a pane for it.
    expect(buttonWords().filter((word) => word === 'Start session')).toHaveLength(1);
  });

  it('puts the tree in the content region, where the Projects tab leads', async () => {
    window.location.hash = destinationHash('projects');

    await mount();

    // One tree, in the only place a phone has for one.
    expect(cataloguePanels('main')).toHaveLength(1);
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

  it('draws the settings sections as a row in the content region, there being no sidebar', async () => {
    window.location.hash = settingsSectionHash('preferences');

    await mount();

    const row = container.querySelector('main nav[aria-label="Settings sections"]');
    const links = [...(row?.querySelectorAll<HTMLAnchorElement>('a') ?? [])];
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      settingsSectionHash('connections'),
      settingsSectionHash('preferences'),
    ]);
    expect(links[1]?.getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('main')?.textContent).toContain('Appearance');
    expect(tabs()).toHaveLength(3);
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
