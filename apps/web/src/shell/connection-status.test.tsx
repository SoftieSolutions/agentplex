// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { connectionView, type ConnectionView } from './connection-model.js';
import { ConnectionStatus } from './connection-status.js';

/**
 * The connection line, drawn: what it offers to do about a failure.
 *
 * Which phases earn a retry is `connection-model.ts` and pinned there. What is
 * pinned here is that the line draws the offer when it is given one and a way
 * to act on it, and nothing when it is not.
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

const FAILED = connectionView({
  phase: 'failed',
  problem: 'the hub could not read a frame this client sent: frame is not valid JSON',
  hasState: true,
  hasToken: true,
});

const RECONNECTING = connectionView({
  phase: 'reconnecting',
  problem: null,
  hasState: true,
  hasToken: true,
});

describe('the connection line', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  function draw(view: ConnectionView, onRetry?: () => void): void {
    const element: JSX.Element = (
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="dark"
      >
        <ConnectionStatus
          view={view}
          scheme="dark"
          {...(onRetry === undefined ? {} : { onRetry })}
        />
      </MantineProvider>
    );
    act(() => {
      root ??= createRoot(container);
      root.render(element);
    });
  }

  function buttons(): HTMLButtonElement[] {
    return [...container.querySelectorAll('button')];
  }

  it('offers a retry on a failure, and asks for one when pressed', () => {
    let asked = 0;
    draw(FAILED, () => {
      asked += 1;
    });

    const [retry, ...rest] = buttons();
    expect(rest).toHaveLength(0);
    expect(retry?.textContent).toBe('Retry');
    act(() => {
      retry?.click();
    });
    expect(asked).toBe(1);
    // The failure keeps its own words beside the button.
    expect(container.textContent).toContain('frame is not valid JSON');
  });

  it('draws no button while the store is retrying on its own', () => {
    draw(RECONNECTING, () => {});
    expect(buttons()).toHaveLength(0);
  });

  it('draws no button when nothing was given to press it with', () => {
    draw(FAILED);
    expect(buttons()).toHaveLength(0);
  });
});
