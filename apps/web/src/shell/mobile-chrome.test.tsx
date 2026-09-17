// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame, type MachineState } from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { MantineProvider, Text } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
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
 * for this file is what the chrome draws once that decision is made, which is
 * everything the ticket is about -- the header, the tab bar, and the action
 * button with the attention count on it.
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
    readonly needsYou?: number;
    readonly current?: 'sessions' | 'projects' | 'more' | null;
    readonly status?: JSX.Element;
  }

  function draw({ needsYou = 0, current = 'sessions', status }: Options = {}): void {
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
          needsYou={needsYou}
          onStartSession={() => {
            started += 1;
          }}
          status={status}
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

  /**
   * The live region. Mounted at every count, which is half of what it is for.
   *
   * Addressed through the button rather than as "the live region on screen":
   * the header holds one too since AGX-119 -- the connection line -- and a
   * query that took the first would have started reading that one instead.
   */
  function announcement(): HTMLElement | null {
    return container.querySelector<HTMLElement>(
      'button[aria-label="Start a session"] + [role="status"]',
    );
  }

  /** The drawn badge, which exists only above zero. */
  function badge(): HTMLElement | null {
    return container.querySelector<HTMLElement>('[data-needs-you]');
  }

  it('draws a compact header holding the machine selector, and no search entry', () => {
    draw();

    const header = container.querySelector('header');
    expect(header?.textContent).toContain('All machines');
    // The palette is not built (AGX-139), so nothing is drawn that looks like
    // a place to type into.
    expect(header?.querySelectorAll('input')).toHaveLength(0);
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
    draw({ current: null, needsYou: 2 });

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

  it('carries the needs-you count as a badge, and says it in words', () => {
    draw({ needsYou: 2 });

    expect(badge()?.textContent).toBe('2');
    expect(announcement()?.textContent).toBe('2 sessions need you');
    // The count is not part of the button's name: "Start a session, 2" is not
    // what either half means.
    expect(actionButton().getAttribute('aria-label')).toBe('Start a session');
  });

  it('says it in the singular for one session', () => {
    draw({ needsYou: 1 });

    expect(announcement()?.textContent).toBe('1 session needs you');
  });

  it('draws no badge when nothing is waiting on anyone', () => {
    draw({ needsYou: 0 });

    expect(badge()).toBeNull();
    // The region itself stays mounted and empty, because a live region
    // inserted along with its first number is a region nothing was watching.
    expect(announcement()?.textContent).toBe('');
    // And the button is still there: it is how a session is started, not only
    // a place to hang a count.
    expect(actionButton()).not.toBeNull();
  });
});
