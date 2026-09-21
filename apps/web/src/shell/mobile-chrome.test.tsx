// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame, type MachineState } from '@agentplex/protocol';
import { notificationList } from '../sessions/notification-model.js';
import { listSessions } from '../sessions/session-list-model.js';
import { createFakeSocketFactory } from '../store/fake-socket.js';
import { createFrameIdCounter } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createHubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { MantineProvider, Text } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { AttentionBell } from './attention-bell.js';
import { connectionView } from './connection-model.js';
import { ConnectionStatus } from './connection-status.js';
import { destinationHash } from './destinations.js';
import { MobileChrome } from './mobile-chrome.js';

/**
 * The phone chrome, rendered directly.
 *
 * Directly and not through `AppShell` at a narrow window, because jsdom has no
 * layout: nothing here can be answered by measuring, and a test that set a
 * width and then asserted on what CSS did would be asserting on nothing. The
 * width decision is pinned as a function in `shell-form.test.ts`; what is left
 * for this file is what the chrome draws once that decision is made -- the
 * header and the two slots the shell fills, the tab bar, and the action
 * button.
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

/** The machine selector is a Mantine menu, which observes its target's box. */
function installResizeObserver(): void {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the fixture is not a machine-state frame');
  }
  return parsed.value.state;
}

const populated = stateFrom(hubFrames.machineStatePopulated);
const quiet = stateFrom(hubFrames.machineState);

/** The moment the fixtures were reported, so the ages are the real elapsed ones. */
const NOW = 1_756_000_000_000;

/** What the shell hands the bell: two sessions asking, and none. */
const twoWaiting = notificationList(listSessions(populated), NOW);
const nothingWaiting = notificationList(listSessions(quiet), NOW);

/**
 * A store for the bell to carry, and nothing more. What its panel sends is
 * `attention-bell.test.tsx`; what is asked here is where the chrome puts the
 * bell, so this one is never subscribed to and therefore never dials.
 */
const store = createHubStore({
  fetchTicket: () => Promise.resolve('ticket-1'),
  createSocket: (ticket) => createFakeSocketFactory().create(ticket),
  timers: createFakeTimers(),
  frameIds: createFrameIdCounter(),
});

const DOWN = connectionView({
  phase: 'reconnecting',
  problem: null,
  hasState: true,
  hasToken: true,
});

const NO_TOKEN = connectionView({
  phase: 'reconnecting',
  problem: null,
  hasState: false,
  hasToken: false,
});

describe('the phone chrome', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let started = 0;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installResizeObserver();
    container = document.createElement('div');
    document.body.append(container);
    started = 0;
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  interface Options {
    readonly current?: 'sessions' | 'projects' | 'more' | null;
    readonly status?: JSX.Element;
    readonly actions?: JSX.Element;
    readonly search?: JSX.Element;
  }

  function draw({ current = 'sessions', status, actions, search }: Options = {}): void {
    const element: JSX.Element = (
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="dark"
      >
        <MobileChrome
          state={populated}
          machine={null}
          onPickMachine={() => {}}
          current={current}
          onStartSession={() => {
            started += 1;
          }}
          status={status}
          actions={actions}
          search={search}
          scheme="dark"
        >
          <Text>the content region</Text>
        </MobileChrome>
      </MantineProvider>
    );
    act(() => {
      root = createRoot(container);
      root.render(element);
    });
  }

  function tabs(): HTMLAnchorElement[] {
    return [...container.querySelectorAll<HTMLAnchorElement>('nav a')];
  }

  function maybeActionButton(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>('button[aria-label="Start a session"]');
  }

  function actionButton(): HTMLButtonElement {
    const button = maybeActionButton();
    if (button === null) throw new Error('the chrome drew no action button');
    return button;
  }

  /** The attention mark, wherever it is: the phone draws exactly one. */
  function attentionMark(): HTMLElement | null {
    return container.querySelector<HTMLElement>('[data-needs-you]');
  }

  it('draws a compact header holding the machine selector', () => {
    draw();

    const header = container.querySelector('header');
    expect(header?.textContent).toContain('All machines');
  });

  it('puts the chrome’s search slot on its own row under that header', () => {
    draw({ search: <button data-search>Search sessions</button> });

    const header = container.querySelector('header');
    const control = header?.querySelector('[data-search]');
    // In the header block and not in the row the selector is on: mockup 6c
    // gives it the full width, which is the only way it clears a fingertip.
    expect(control).not.toBeNull();
    expect(control?.closest('header')).toBe(header);
    expect(header?.firstElementChild?.contains(control ?? null)).toBe(false);
  });

  it('draws no search row at all when the shell hands it none', () => {
    draw();

    expect(container.querySelector('header [data-search]')).toBeNull();
  });

  it('carries the chrome’s status slot in the header, beside the selector', () => {
    // The same node the top bar is handed: the shell builds one connection
    // line and both forms draw it, so a phone never words a dropped socket
    // differently from a desk.
    draw({ status: <ConnectionStatus view={DOWN} scheme="dark" /> });

    const header = container.querySelector('header');
    expect(header?.textContent).toContain('connection lost');
    expect(header?.querySelector('a')).toBeNull();
  });

  it('lets the long reconnect sentence truncate rather than shove the header', () => {
    draw({ status: <ConnectionStatus view={DOWN} scheme="dark" /> });

    const words = container.querySelector<HTMLElement>(
      'header [role="status"] span:nth-of-type(2)',
    );
    expect(words?.style.textOverflow).toBe('ellipsis');
    // The whole sentence survives where it can be got at: on the title, and
    // unshortened in the live region a screen reader hears.
    expect(words?.getAttribute('title')).toBe(DOWN.words);
    expect(words?.textContent).toBe(DOWN.words);
  });

  it('carries the next action through that slot when the state has one', () => {
    draw({ status: <ConnectionStatus view={NO_TOKEN} scheme="dark" /> });

    const link = container.querySelector<HTMLAnchorElement>('header a');
    expect(link?.textContent).toBe('Settings');
    expect(link?.getAttribute('href')).toBe(destinationHash('settings'));
  });

  it('draws the content region between the header and the bar', () => {
    draw();

    expect(container.querySelector('main')?.textContent).toContain('the content region');
  });

  it('offers Sessions, Projects and More, each an address', () => {
    draw();

    expect(tabs().map((tab) => tab.textContent)).toEqual(['Sessions', 'Projects', 'More']);
    expect(tabs().map((tab) => tab.getAttribute('href'))).toEqual([
      destinationHash('sessions'),
      destinationHash('projects'),
      destinationHash('more'),
    ]);
  });

  it('marks the tab the app is on, and only that one', () => {
    draw({ current: 'projects' });

    const marked = tabs().filter((tab) => tab.getAttribute('aria-current') === 'page');
    expect(marked.map((tab) => tab.textContent)).toEqual(['Projects']);
  });

  it('marks no tab when the address names a session rather than a place', () => {
    draw({ current: null });

    expect(tabs().filter((tab) => tab.hasAttribute('aria-current'))).toHaveLength(0);
  });

  it('floats nothing over a session, where the corner is the last line of output', () => {
    draw({ current: null });

    expect(maybeActionButton()).toBeNull();
    // The bar is still the way back to a place the button is drawn on.
    expect(tabs()).toHaveLength(3);
  });

  it('starts a session from the floating button', () => {
    draw();

    act(() => {
      actionButton().click();
    });

    expect(started).toBe(1);
  });

  it('carries the chrome’s actions slot in the header, so the bell is on a phone too', () => {
    draw({ actions: <AttentionBell list={twoWaiting} store={store} form="phone" scheme="dark" /> });

    const header = container.querySelector('header');
    expect(header?.querySelector('[data-attention-bell]')?.getAttribute('aria-label')).toBe(
      '2 sessions need you',
    );
  });

  it('leaves the count to the bell: the action button is a way to start and nothing else', () => {
    draw({ actions: <AttentionBell list={twoWaiting} store={store} form="phone" scheme="dark" /> });

    // One screen, one attention number. The button used to wear a badge of
    // its own, narrowed by the machine the header had picked, so a phone
    // could show two different counts for one fleet; the bell is the one that
    // survived, because it is the one the tab title agrees with.
    expect(attentionMark()?.closest('[data-attention-bell]')).not.toBeNull();
    expect(actionButton().getAttribute('aria-label')).toBe('Start a session');
    expect(actionButton().parentElement?.querySelector('[role="status"]')).toBeNull();
  });

  it('draws no mark anywhere when nothing is waiting on anyone', () => {
    draw({
      actions: <AttentionBell list={nothingWaiting} store={store} form="phone" scheme="dark" />,
    });

    expect(attentionMark()).toBeNull();
    // And the button is still there: it is how a session is started, which
    // never depended on the count it used to carry.
    expect(actionButton()).not.toBeNull();
  });
});
