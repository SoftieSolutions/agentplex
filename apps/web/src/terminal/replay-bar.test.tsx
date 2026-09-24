// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { ReplayBar } from './replay-bar.js';

/**
 * The scrubber as a screen reader and a keyboard meet it: a slider with its
 * range and value declared, two step buttons that stop at the ends, an Exit,
 * and a sentence about which step this is. It draws props and owns nothing --
 * every press is reported to the pane, which holds the position.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** Mantine reads the colour-scheme media query on mount; jsdom has none. */
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

/** jsdom has no `ResizeObserver`, and Mantine's slider measures itself with one. */
function installResizeObserver(): void {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

let container: HTMLDivElement;
let root: Root | null = null;
let sought: number[] = [];
let exits = 0;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  installMatchMedia();
  installResizeObserver();
  container = document.createElement('div');
  document.body.append(container);
  sought = [];
  exits = 0;
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container.remove();
});

async function mount(element: JSX.Element): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="dark"
      >
        {element}
      </MantineProvider>,
    );
  });
}

async function mountBar(position: number, count: number): Promise<void> {
  await mount(
    <ReplayBar
      position={position}
      count={count}
      status={`Replaying step ${String(position + 1)} of ${String(count)}`}
      onSeek={(to) => sought.push(to)}
      onExit={() => {
        exits += 1;
      }}
      scheme="dark"
    />,
  );
}

function slider(): HTMLElement {
  const found = container.querySelector('[role="slider"]');
  if (found === null) throw new Error('no slider is drawn');
  return found as HTMLElement;
}

function button(label: string): HTMLButtonElement {
  const found = container.querySelector(`button[aria-label="${label}"]`);
  if (found === null) throw new Error(`no button labelled ${label}`);
  return found as HTMLButtonElement;
}

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('the replay bar', () => {
  it('declares the slider’s range as the steps and its value as the position', async () => {
    await mountBar(2, 7);

    expect(slider().getAttribute('aria-valuemin')).toBe('0');
    expect(slider().getAttribute('aria-valuemax')).toBe('6');
    expect(slider().getAttribute('aria-valuenow')).toBe('2');
  });

  it('says which step this is, in a region a screen reader is watching', async () => {
    await mountBar(2, 7);

    const status = container.querySelector('[data-replay-status]');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.textContent).toBe('Replaying step 3 of 7');
  });

  it('steps back and forward by one, reporting the new position', async () => {
    await mountBar(2, 7);

    await press(button('back one step'));
    await press(button('forward one step'));

    expect(sought).toEqual([1, 3]);
  });

  it('disables Back on the first step and Forward on the last', async () => {
    await mountBar(0, 7);
    expect(button('back one step').disabled).toBe(true);
    expect(button('forward one step').disabled).toBe(false);

    await mountBar(6, 7);
    expect(button('back one step').disabled).toBe(false);
    expect(button('forward one step').disabled).toBe(true);
  });

  it('disables both when the list has one step to stand on', async () => {
    await mountBar(0, 1);

    expect(button('back one step').disabled).toBe(true);
    expect(button('forward one step').disabled).toBe(true);
    expect(slider().getAttribute('aria-valuemax')).toBe('0');
  });

  it('reports Exit and moves nothing', async () => {
    await mountBar(2, 7);

    await press(button('leave replay and show the live transcript'));

    expect(exits).toBe(1);
    expect(sought).toEqual([]);
  });
});
