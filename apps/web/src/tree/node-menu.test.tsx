// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeIdSchema } from '@agentplex/protocol';
import { createFakeSocketFactory } from '../store/fake-socket.js';
import { createFrameIdCounter } from '../store/frame-ids.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { colorForRole } from '../ui/tokens.js';
import { NodeMenu } from './node-menu.js';

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

const NODE = nodeIdSchema.parse('node-observatory-notes');

describe('the node menu', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let store: HubStore;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
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

  /**
   * Stone is the same hue in both schemes, so this proves the trigger is
   * wired to the muted-text role rather than to Mantine's stock gray; it does
   * not prove the trigger follows the scheme.
   */
  it('paints its trigger in the muted-text role', () => {
    act(() => {
      root = createRoot(container);
      root.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="dark"
        >
          <NodeMenu
            store={store}
            nodeId={NODE}
            name="x"
            layout={null}
            anchor={null}
            scheme="dark"
          />
        </MantineProvider>,
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Actions for x"]',
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.style.getPropertyValue('--button-color')).toBe(
      colorForRole('textMuted', 'dark'),
    );
  });
});
