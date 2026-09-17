// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeSocketFactory } from '../store/fake-socket.js';
import { createFrameIdCounter } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { createOnboardingDismissal, type OnboardingDismissal } from './dismissal.js';
import { ONBOARDING_HASH } from './onboarding-route.js';
import { OnboardingScreen } from './onboarding-screen.js';

/**
 * The wizard's shell, on a store walked through a real hub's opening frames.
 *
 * What is asserted here is what the screen promises a first-time reader: the
 * sentence that says what the product is, a stepper whose live step is the one
 * the connection has actually reached, and a way out that both remembers
 * itself and leaves the address. The copy is checked as copy, because on this
 * screen the words are the feature -- including the one thing they must never
 * say, which is that a server dials the hub. It does not; the hub dials it,
 * and a reader who opened a port on the strength of this screen would have
 * opened it on the wrong machine.
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

/** Lets the ticket promise inside `connect` settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A browser that remembers, so a dismissal can be read back as stored. */
function createMemoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length(): number {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => {
      entries.delete(key);
    },
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
  };
}

describe('the onboarding wizard', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let store: HubStore;
  let sockets: ReturnType<typeof createFakeSocketFactory>;
  let dismissal: OnboardingDismissal;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    container = document.createElement('div');
    document.body.append(container);
    sockets = createFakeSocketFactory();
    store = createHubStore({
      fetchTicket: () => Promise.resolve('ticket-1'),
      createSocket: (ticket) => sockets.create(ticket),
      timers: createFakeTimers(),
      frameIds: createFrameIdCounter(),
    });
    dismissal = createOnboardingDismissal(createMemoryStorage);
    window.location.hash = ONBOARDING_HASH;
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
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

  /** Mounts the wizard with nothing yet answered by the hub. */
  async function mount(): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(withProvider(<OnboardingScreen store={store} dismissal={dismissal} />));
    });
    await act(settle);
  }

  /** Mounts, then walks the store's connection through to a connected hub. */
  async function mountConnected(): Promise<void> {
    await mount();
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the screen dialled nothing');
    await act(() => {
      socket.open();
      socket.deliver(hubFrames.welcome);
      socket.deliver(hubFrames.machineState);
    });
  }

  /** The stepper, found by the name it carries rather than by a class. */
  function stepper(): Element {
    const found = container.querySelector('[aria-label="Setup steps"]');
    if (found === null) throw new Error('the wizard drew no stepper');
    return found;
  }

  function stepLabels(): string[] {
    return [...stepper().querySelectorAll('button')].map((button) => button.textContent ?? '');
  }

  function liveStep(): string {
    const step = stepper().querySelector('button[data-progress]');
    if (step === null) throw new Error('no step is live');
    return step.textContent ?? '';
  }

  function skipButton(): HTMLButtonElement {
    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Skip for now',
    );
    if (button === undefined) throw new Error('the wizard offers no way out');
    return button;
  }

  it('says what the product is before it asks for anything', async () => {
    await mount();

    expect(container.textContent).toContain('Every agent session, every machine, one place.');
  });

  it('names both steps, in the order they have to happen', async () => {
    await mount();

    // Contains rather than equals: a step's button also carries its number and
    // its description, and neither is what this is asserting.
    expect(stepLabels()).toEqual([
      expect.stringContaining('Connect this hub'),
      expect.stringContaining('Pair a server'),
    ]);
  });

  it('stands on connecting to the hub while the hub has not answered', async () => {
    await mount();

    expect(liveStep()).toContain('Connect this hub');
  });

  it('moves to pairing once the hub has answered', async () => {
    await mountConnected();

    expect(liveStep()).toContain('Pair a server');
  });

  it('draws the pairing step beside the stepper, pointing at Settings', async () => {
    await mountConnected();

    expect(container.querySelector('h2')?.textContent).toBe('Pair a server');
    expect(container.textContent).toContain('Settings');
  });

  it('carries the app icon, named', async () => {
    await mount();

    expect(container.querySelector('img')?.getAttribute('alt')).toBe('agentplex');
  });

  it('promises the machines it is not asking for now', async () => {
    await mount();

    expect(container.textContent).toContain('You can enroll more machines later from Settings.');
  });

  it('never says a server dials the hub, because it does not', async () => {
    await mountConnected();

    // The hub dials the server. Any sentence that puts a server on the dialling
    // end of this is an instruction to open a port on the wrong machine.
    expect(container.textContent ?? '').not.toMatch(
      /server[^.]*\b(dials?|connects? to|points? at|reaches?)\b[^.]*hub/i,
    );
  });

  it('remembers a skip on this device and leaves the wizard', async () => {
    await mount();

    await act(() => {
      skipButton().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });

    expect(dismissal.read()).toBe(true);
    expect(window.location.hash).toBe('');
  });
});
