// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeSocketFactory, type FakeSocket } from '../store/fake-socket.js';
import { createFrameIdCounter } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { NewSessionForm } from './new-session-form.js';

/**
 * What the form does with a refusal that names a holder.
 *
 * The refusals delivered here are captured: a real hub answered a real start
 * and a real stop with each of them, holder and all. What is asserted is that
 * the machine on the holder reaches the screen -- "it is running over here" is
 * a different answer from "no", and a client that drops the field leaves the
 * user with the second one.
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

/** The dialog observes its own box to trap focus; jsdom has no layout. */
function installResizeObserver(): void {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

/** The autosizing prompt waits on the font set; jsdom ships none. */
function installFontFaceSet(): void {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { addEventListener: () => {}, removeEventListener: () => {} },
  });
}

/** Lets the ticket promise inside `connect` settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('the new-session form meeting a holder', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let store: HubStore;
  let sockets: ReturnType<typeof createFakeSocketFactory>;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
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
   * The form open on a store whose connection has reached a captured state
   * with exactly one store in it -- one store is not a choice, so the form is
   * submittable without anything being picked.
   */
  async function mountForm(): Promise<FakeSocket> {
    await act(async () => {
      root = createRoot(container);
      root.render(
        withProvider(
          <NewSessionForm
            store={store}
            opened
            onClose={() => {}}
            scheme="dark"
            navigate={() => {}}
          />,
        ),
      );
    });
    await act(settle);
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the form dialled nothing');
    await act(() => {
      socket.open();
      socket.deliver(hubFrames.welcome);
      socket.deliver(hubFrames.machineStateSingle);
    });
    return socket;
  }

  /** The dialog renders into a portal, so the whole document is the haystack. */
  function shown(): string {
    return document.body.textContent ?? '';
  }

  function button(label: string): HTMLButtonElement {
    const found = [...document.body.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === label,
    );
    if (found === undefined) throw new Error(`no button labelled ${label}`);
    return found;
  }

  async function submit(): Promise<void> {
    await act(() => {
      button('Start session').click();
    });
  }

  it('names the machine already running the session it was refused for', async () => {
    const socket = await mountForm();

    // The start this form sent is frame 3 -- the form asks for the tree first,
    // to fill its project select -- which is the frame this captured refusal
    // answers.
    await submit();
    await act(() => {
      socket.deliver(hubFrames.refusalHeldBusy);
    });

    expect(shown()).toContain(
      'that session is mid-turn; stopping it now could leave an edit half applied',
    );
    expect(shown()).toContain('held by mbp-robert');
  });

  it('offers no stop for a holder the server will not interrupt', async () => {
    const socket = await mountForm();
    await submit();

    await act(() => {
      socket.deliver(hubFrames.refusalHeldBusy);
    });

    expect(document.body.querySelector('button[aria-label^="stop "]')).toBeNull();
  });

  it('offers none either when the start named no session to aim one at', async () => {
    const socket = await mountForm();
    // The second start is frame 4, which the stoppable-holder refusal answers.
    await submit();
    await act(() => {
      socket.deliver(hubFrames.refusalHeldBusy);
    });
    await submit();

    await act(() => {
      socket.deliver(hubFrames.refusalHeldStoppable);
    });

    // The holder can be stopped, and there is still nothing to aim at: this
    // flow starts new sessions, and a new session has no id until the provider
    // writes one. The machine is named anyway, which is the half that is true.
    expect(shown()).toContain('that session is already running on mbp-robert');
    expect(shown()).toContain('held by mbp-robert');
    expect(document.body.querySelector('button[aria-label^="stop "]')).toBeNull();
  });
});
