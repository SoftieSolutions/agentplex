// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeStorage } from '../auth/fake-storage.js';
import { createTokenStore } from '../auth/token.js';
import { createMockSwitch, type MockSwitch } from '../mock/mock-switch.js';
import { MockModeProvider, useMockMode } from '../mock/use-mock-mode.js';
import { createFakeSocketFactory } from '../store/fake-socket.js';
import { createFrameIds } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { mintClientInstance } from '../store/client-instance.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import type { HubSnapshot } from '../store/views.js';
import type { SettingsSection } from '../shell/destinations.js';
import type { ShellForm } from '../shell/shell-form.js';
import { createFakeTimers } from '../store/timers.js';
import { MantineProvider, MockTag } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { colorForToneText } from '../ui/tokens.js';
import { createFakePairingOperations } from './fake-pairing-operations.js';
import { createFakePushOperations } from './fake-push-operations.js';
import { SettingsRoute } from './settings-route.js';
import { SettingsScreen } from './settings-screen.js';

/**
 * That the screen carries the controls it is the home of, and what it says
 * when it has nothing to list, which is what a new install has.
 *
 * The screen is three sections at three addresses (AGX-388), and each test
 * draws the one that carries what it asserts: Connections for the hub token
 * and pairing, Preferences for notifications and appearance, Developer for the
 * mock switch. Each section is also asserted to draw nothing of the others,
 * because a control left behind in the wrong section is the regression a
 * split invites.
 *
 * The appearance control is asserted here rather than only in its own suite
 * because its own suite mounts it directly: without this, deleting the
 * section from the screen would leave every test green and the light scheme
 * unreachable again, which is the bug AGX-126 was filed about.
 *
 * The snapshot the unpaired suite draws is a real store's, walked through a
 * fake socket on captured frames rather than assembled here: the paired-server
 * list is read off a machine state, and a state written by hand would be a
 * claim about what a hub sends rather than a record of one.
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

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The seam, answering a refusal. Nothing below submits the form -- these
 * assertions are about what the screen says with nothing paired -- so the
 * answer is the one that records no registration this fleet does not have.
 */
const NO_PAIRING = createFakePairingOperations({
  answer: { ok: false, reason: 'no test here pairs anything' },
});

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
      instance: mintClientInstance(),
      timers: createFakeTimers(),
      frameIds: createFrameIds(),
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
          <SettingsRoute
            store={store}
            tokens={createTokenStore(() => storage)}
            section="preferences"
            form="wide"
          />
        </MantineProvider>,
      );
    });

    // And says nothing at all about notifications, because the route builds
    // the real operations over this browser and jsdom has no service worker
    // registration and no `PushManager`. Degrading silently is the ticket's
    // own rule, and this is the assertion that the wiring honours it rather
    // than drawing a section nothing can act on.
    expect(container.textContent).not.toContain('Notifications');

    const group = container.querySelector('[aria-label="Appearance"]');
    expect(group).not.toBeNull();
    expect([...(group?.querySelectorAll('input') ?? [])].map((input) => input.value)).toEqual([
      'dark',
      'light',
      'system',
    ]);
  });
});

describe('the settings screen with nothing paired', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installResizeObserver();
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

  /** A real store, and its snapshot, after the hub has answered with one state. */
  async function storeOn(state: string): Promise<{ store: HubStore; snapshot: HubSnapshot }> {
    const sockets = createFakeSocketFactory();
    const store = createHubStore({
      fetchTicket: () => Promise.resolve('ticket-1'),
      createSocket: (ticket) => sockets.create(ticket),
      instance: mintClientInstance(),
      timers: createFakeTimers(),
      frameIds: createFrameIds(),
    });
    const detach = store.subscribe(() => {});
    await settle();
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the store dialled nothing');
    socket.open();
    socket.deliver(hubFrames.welcome);
    socket.deliver(state);
    const snapshot = store.getSnapshot();
    detach();
    return { store, snapshot };
  }

  interface DrawOptions {
    readonly now?: () => number;
    readonly scheme?: 'light' | 'dark';
    readonly section?: SettingsSection;
    readonly form?: ShellForm;
    /** A switch to provide, so the Developer section is one that exists. */
    readonly mock?: MockSwitch;
  }

  async function draw(
    state: string,
    {
      now = Date.now,
      scheme = 'dark',
      section = 'connections',
      form = 'wide',
      mock,
    }: DrawOptions = {},
  ): Promise<void> {
    const { store, snapshot } = await storeOn(state);
    const storage = fakeStorage();
    const screen = (
      <SettingsScreen
        snapshot={snapshot}
        store={store}
        tokens={createTokenStore(() => storage)}
        pairing={NO_PAIRING}
        push={createFakePushOperations()}
        candidates={[]}
        now={now}
        section={section}
        form={form}
      />
    );
    const element: JSX.Element = (
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme={scheme}
      >
        {mock === undefined ? screen : <MockModeProvider mock={mock}>{screen}</MockModeProvider>}
      </MantineProvider>
    );
    await act(async () => {
      root = createRoot(container);
      root.render(element);
    });
  }

  /** A switch that exists and is off, so every section is on offer. */
  function anySwitch(): MockSwitch {
    return createMockSwitch({ storage: () => fakeStorage(), search: () => '' });
  }

  function headings(level: 'h2' | 'h3'): (string | null)[] {
    return [...container.querySelectorAll(level)].map((heading) => heading.textContent);
  }

  it('draws Connections: this browser and its hub token, then the servers', async () => {
    await draw(hubFrames.machineState, { mock: anySwitch() });

    expect(headings('h2')).toEqual(['Connections']);
    expect(headings('h3')).toEqual(['This browser', 'Servers']);
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
    // The connection line, which is what proves a token rather than saving it.
    expect(container.textContent).toContain('connected');
    expect(container.textContent).toContain('Pair a server');
    expect(container.textContent).toContain('Paired servers');
    expect(container.textContent).toContain('No servers are paired with this hub');

    const words = container.textContent ?? '';
    expect(words).not.toContain('Hub access');
    expect(words).not.toContain('Appearance');
    expect(words).not.toContain('Notifications');
    expect(words).not.toContain('Developer');
  });

  it('draws Preferences: notifications and appearance, and nothing about connections', async () => {
    await draw(hubFrames.machineState, { section: 'preferences', mock: anySwitch() });

    expect(headings('h2')).toEqual(['Preferences']);
    expect(container.textContent).toContain('Notifications');
    expect(container.querySelector('[aria-label="Appearance"]')).not.toBeNull();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.textContent).not.toContain('Pair a server');
    expect(container.textContent).not.toContain('Show mock data');
  });

  it('pads its own content the way the other destinations do', async () => {
    await draw(hubFrames.machineState);

    // The first element the screen draws: Mantine's provider puts its style
    // tags ahead of it, and those are not the screen's.
    const outer = container.querySelector<HTMLElement>(':scope > :not(style)');
    expect(outer?.style.padding).toBe('var(--mantine-spacing-md)');
    expect(outer?.querySelector('h2')?.textContent).toBe('Connections');
  });

  it('draws the sections as a row of links above the content on a phone', async () => {
    await draw(hubFrames.machineState, {
      section: 'preferences',
      form: 'phone',
      mock: anySwitch(),
    });

    const nav = container.querySelector('nav[aria-label="Settings sections"]');
    expect(nav).not.toBeNull();
    const links = [...(nav?.querySelectorAll('a') ?? [])];
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Connections', '#/settings/connections'],
      ['Preferences', '#/settings/preferences'],
      ['Developer', '#/settings/developer'],
    ]);
    expect(links.map((link) => link.getAttribute('aria-current'))).toEqual([null, 'page', null]);
    // Above the content: the nav comes before the section's own title.
    const title = container.querySelector('h2');
    expect(title?.textContent).toBe('Preferences');
    expect(
      nav !== null &&
        title !== null &&
        nav.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('draws no section row in the wide form, where the sidebar holds it', async () => {
    await draw(hubFrames.machineState, { mock: anySwitch() });

    expect(container.querySelector('nav[aria-label="Settings sections"]')).toBeNull();
  });

  /** When the captured timed machine's pong was read, by the hub's clock. */
  const MEASURED_AT = 1_756_000_020_012;

  /** The element whose own text is exactly `words`, or a failure naming them. */
  function drawn(words: string): HTMLElement {
    const found = [...container.querySelectorAll<HTMLElement>('*')].find(
      (element) => element.textContent === words && element.children.length === 0,
    );
    if (found === undefined) throw new Error(`nothing on the screen reads ${words}`);
    return found;
  }

  it('names the form above it and the installer that produces a server to pair', async () => {
    await draw(hubFrames.machineState);

    const words = container.textContent ?? '';
    expect(words).toContain('No servers are paired with this hub');
    // Both halves of the answer: the form on this screen for a server that is
    // already running, and the installer for the case where none is.
    expect(words).toContain('Pair one above');
    expect(words).toContain('install.sh --role=server');
    // No host, in either command. Where the bootstrap is fetched from is a
    // fact about a deployment, and inventing one here would be the screen
    // making it up.
    expect(words).not.toContain('https://');
  });

  it('sends the operator to the identity file, because nothing prints the token', async () => {
    await draw(hubFrames.machineState);

    const words = container.textContent ?? '';
    // `install.sh` writes no token by design (scripts/install.sh) and
    // `agentplex setup` never prints one (describe-outcome.ts, pinned by
    // setup-command.test.ts). A screen that said either hands you one would be
    // sending somebody to look for something that is not there.
    expect(words).toContain('agentplex setup');
    expect(words).toContain('identity file');
    expect(words).toContain('the pairing token is in it');
    expect(words).toContain('never printed');
  });

  it('sets every paragraph of explanation at the prose line height', async () => {
    await draw(hubFrames.machineState);

    // A paragraph is anything that runs past a line at this width; the labels,
    // statuses and field names are shorter and keep the body's own height.
    const paragraphs = Array.from(container.querySelectorAll('p')).filter(
      (p) => (p.textContent ?? '').length > 80,
    );
    expect(paragraphs.length).toBeGreaterThan(3);
    for (const paragraph of paragraphs) {
      expect(paragraph.style.lineHeight, paragraph.textContent ?? '').toBe(
        'var(--mantine-line-height-prose)',
      );
    }
  });

  it('says nothing about pairing before the hub has answered at all', async () => {
    const storage = fakeStorage();
    const { store, snapshot } = await storeOn(hubFrames.pong);
    const element: JSX.Element = (
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="dark"
      >
        <SettingsScreen
          snapshot={snapshot}
          store={store}
          tokens={createTokenStore(() => storage)}
          pairing={NO_PAIRING}
          push={createFakePushOperations()}
          candidates={[]}
          section="connections"
          form="wide"
        />
      </MantineProvider>
    );
    await act(async () => {
      root = createRoot(container);
      root.render(element);
    });

    // An empty list and a list that has not arrived are two different facts,
    // and only the first one has a next action.
    expect(container.textContent).toContain('the hub');
    expect(container.textContent).not.toContain('install.sh');
  });

  it('carries the notifications control in Preferences, where this browser has push', async () => {
    await draw(hubFrames.machineState, { section: 'preferences' });

    // The screen is the home of the control; its own suite mounts it alone,
    // so without this the section could be deleted from the screen and every
    // other test would stay green.
    expect(container.textContent).toContain('Notifications');
    expect(container.textContent).toContain('one shared hub token');
  });

  it('drops the guidance the moment a server is paired', async () => {
    await draw(hubFrames.machineStateWithServer);

    expect(container.textContent).not.toContain('No servers are paired');
    expect(container.textContent).toContain('gpu-box-01');
  });

  it('draws what each machine said it runs, muted beside its identity', async () => {
    await draw(hubFrames.machineStatePopulated, { now: () => MEASURED_AT });

    // Both captured servers named themselves in their handshake; the row
    // draws each in the same muted monospace as the identity it sits beside.
    const beside = [
      ['server-mbp', 'macOS 26.6.2 · daemon 2.0.3'],
      ['server-gpu', 'Ubuntu 24.04.5 LTS · daemon 2.0.3'],
    ] as const;
    for (const [identity, words] of beside) {
      const about = drawn(words);
      expect(about.style.fontFamily).toContain('monospace');
      expect(about.parentElement).toBe(drawn(identity).parentElement);
    }
  });

  it('draws nothing in their place for a machine that has not said', async () => {
    await draw(hubFrames.machineStateWithServer);

    expect(container.textContent).toContain('gpu-box-01');
    expect(container.textContent).not.toMatch(/daemon|unknown/i);
  });

  it('draws the round trip the hub measured beside the phase', async () => {
    await draw(hubFrames.machineStateMeasured, { now: () => MEASURED_AT });

    expect(container.textContent).toContain('connected · 1 store');
    expect(drawn('12ms')).toBeDefined();
    expect(container.textContent).not.toContain(' ago');
  });

  it('draws no figure for a machine the hub has not timed', async () => {
    await draw(hubFrames.machineStateJustPaired, { now: () => MEASURED_AT });

    expect(container.textContent).toContain('mbp-robert');
    expect(container.textContent).not.toMatch(/\d+ms/);
  });

  it('labels a reading with its age once it is no longer current', async () => {
    await draw(hubFrames.machineStateMeasured, { now: () => MEASURED_AT + 3 * 60_000 });

    expect(drawn('12ms · 3m ago')).toBeDefined();
  });

  it('draws a slow round trip in the warning tone', async () => {
    // The captured frame with its one figure raised past the threshold: what
    // is under test is the tone a number earns, and the frame still goes
    // through the store's own parser.
    await draw(hubFrames.machineStateMeasured.replace('"ms":12,', '"ms":410,'), {
      now: () => MEASURED_AT,
    });

    expect(drawn('410ms').style.color).toBe(toCssColor(colorForToneText('needs-you', 'dark')));
  });

  it('writes a slow round trip in the warning word hue on paper, not the dot hue', async () => {
    await draw(hubFrames.machineStateMeasured.replace('"ms":12,', '"ms":410,'), {
      now: () => MEASURED_AT,
      scheme: 'light',
    });

    expect(drawn('410ms').style.color).toBe(toCssColor(colorForToneText('needs-you', 'light')));
  });

  it("leaves a round trip under the threshold in the row's own quiet tone", async () => {
    await draw(hubFrames.machineStateMeasured, { now: () => MEASURED_AT });

    expect(drawn('12ms').style.color).not.toBe(toCssColor(colorForToneText('needs-you', 'dark')));
  });
});

describe('the developer section', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installResizeObserver();
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

  /** A switch that records what the toggle asked of it, and otherwise is one. */
  function recording(inner: MockSwitch): MockSwitch & { readonly calls: boolean[] } {
    const calls: boolean[] = [];
    return {
      calls,
      read: inner.read,
      subscribe: inner.subscribe,
      set(on: boolean): boolean {
        calls.push(on);
        return inner.set(on);
      },
    };
  }

  /** What a mocked feature looks like: a sample, tagged, only while it is on. */
  function Harness(): JSX.Element | null {
    return useMockMode() ? (
      <p data-harness="">
        sample graph run
        <MockTag scheme="dark" />
      </p>
    ) : null;
  }

  async function draw(
    mock: MockSwitch | null,
    section: SettingsSection = 'developer',
  ): Promise<void> {
    const storage = fakeStorage();
    const sockets = createFakeSocketFactory();
    const store = createHubStore({
      fetchTicket: () => Promise.resolve('ticket-1'),
      createSocket: (ticket) => sockets.create(ticket),
      instance: mintClientInstance(),
      timers: createFakeTimers(),
      frameIds: createFrameIds(),
    });
    const screen = (
      <>
        <SettingsScreen
          snapshot={store.getSnapshot()}
          store={store}
          tokens={createTokenStore(() => storage)}
          pairing={NO_PAIRING}
          push={createFakePushOperations()}
          candidates={[]}
          section={section}
          form="wide"
        />
        <Harness />
      </>
    );
    await act(async () => {
      root = createRoot(container);
      root.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="dark"
        >
          {mock === null ? screen : <MockModeProvider mock={mock}>{screen}</MockModeProvider>}
        </MantineProvider>,
      );
    });
  }

  function toggle(): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>('input[role="switch"]');
    if (input === null) throw new Error('no mock data toggle drawn');
    return input;
  }

  it('is a section of its own, with a toggle that reads the switch as off', async () => {
    await draw(createMockSwitch({ storage: () => fakeStorage(), search: () => '' }));

    expect([...container.querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['Developer']);
    // The panel names what it holds rather than repeating the section's name.
    expect([...container.querySelectorAll('h4')].map((h) => h.textContent)).toEqual(['Mock data']);
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector('[aria-label="Appearance"]')).toBeNull();
    const words = container.textContent ?? '';
    expect(words).toContain('Show mock data');
    expect(words).toContain(
      'Shows sample data for features that have no backend yet. Kept on this device only.',
    );
    expect(toggle().checked).toBe(false);
  });

  it('reads the switch as on when this device turned it on', async () => {
    await draw(createMockSwitch({ storage: () => fakeStorage(), search: () => '?mock=1' }));
    expect(toggle().checked).toBe(true);
  });

  it('flips the switch, and the sample appears and goes without a reload', async () => {
    const storage = fakeStorage();
    const mock = recording(createMockSwitch({ storage: () => storage, search: () => '' }));
    await draw(mock);
    expect(container.querySelector('[data-harness]')).toBeNull();

    await act(async () => {
      toggle().click();
    });
    expect(mock.calls).toEqual([true]);
    expect(storage.getItem('agentplex.mock')).toBe('on');
    expect(toggle().checked).toBe(true);
    expect(container.querySelector('[data-harness] [data-mock-tag]')).not.toBeNull();

    await act(async () => {
      toggle().click();
    });
    expect(mock.calls).toEqual([true, false]);
    expect(toggle().checked).toBe(false);
    expect(container.querySelector('[data-harness]')).toBeNull();
  });

  it('says the choice holds for this page only when the browser refuses to keep it', async () => {
    await draw(
      createMockSwitch({
        storage: () => {
          throw new Error('SecurityError');
        },
        search: () => '',
      }),
    );
    await act(async () => {
      toggle().click();
    });
    expect(toggle().checked).toBe(true);
    expect(container.textContent).toContain('This browser refused to keep it');
  });

  it('is absent with no switch to flip', async () => {
    await draw(null, 'connections');
    expect(container.textContent).not.toContain('Developer');
    expect(container.querySelector('input[role="switch"]')).toBeNull();
  });

  it('opens Connections for a Developer address with no switch behind it', async () => {
    await draw(null, 'developer');
    expect(container.textContent).toContain('This browser');
    expect(container.textContent).not.toContain('Developer');
    expect(container.querySelector('input[role="switch"]')).toBeNull();
  });
});

/** A colour as the browser normalises it when it is set on an element. */
function toCssColor(color: string): string {
  const probe = document.createElement('span');
  probe.style.color = color;
  return probe.style.color;
}
