// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame, type MachineState } from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { colorForRole, colorForToneText, type Scheme } from '../ui/tokens.js';
import { MachineSelector } from './machine-selector.js';

/**
 * The selector drawn, for the two things its model cannot show: that the
 * header carries the figure the hub measured, and that a slow row's words take
 * the warning tone while a quick one's stay quiet.
 *
 * The state is a captured one, with its one figure varied for the slow row:
 * what is under test is the tone a number earns, and the frame still goes
 * through the parser the store reads with.
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

/** The selector is a Mantine menu, which observes its target's box. */
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
    throw new Error('the captured frame is not a machine state');
  }
  return parsed.value.state;
}

/** When the captured timed machine's pong was read, by the hub's clock. */
const MEASURED_AT = 1_756_000_020_012;

/** A colour as the browser normalises it when it is set on an element. */
function toCssColor(color: string): string {
  const probe = document.createElement('span');
  probe.style.color = color;
  return probe.style.color;
}

describe('the machine selector, drawn', () => {
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

  async function draw(state: MachineState, scheme: Scheme = 'dark'): Promise<void> {
    const element: JSX.Element = (
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme={scheme}
        // Mantine hides a dropdown whose target it measures as detached, and
        // in a DOM with no layout every target does; `env="test"` is its
        // switch for that, as the New menu's suite explains.
        env="test"
      >
        <MachineSelector
          state={state}
          chosen={null}
          onPick={() => {}}
          scheme={scheme}
          now={() => MEASURED_AT}
        />
      </MantineProvider>
    );
    await act(async () => {
      root = createRoot(container);
      root.render(element);
    });
  }

  /** Opens the menu, whose rows Mantine renders into a portal on the body. */
  async function open(): Promise<void> {
    const target = container.querySelector('button');
    if (target === null) throw new Error('the selector drew no target');
    await act(async () => {
      target.click();
    });
    // Lets the dropdown that has just been asked for reach the document.
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  }

  /** The element anywhere on the page whose own text is exactly `words`. */
  function drawn(words: string): HTMLElement {
    const found = [...document.body.querySelectorAll<HTMLElement>('*')].find(
      (element) => element.textContent === words && element.children.length === 0,
    );
    if (found === undefined) throw new Error(`nothing on the page reads ${words}`);
    return found;
  }

  it('carries the round trip the hub measured in the header', async () => {
    await draw(stateFrom(hubFrames.machineStateMeasured));

    expect(container.textContent).toContain('1/1 online · 12ms');
  });

  it('draws a quick row in the muted tone and a slow one in the warning tone', async () => {
    await draw(stateFrom(hubFrames.machineStateMeasured));
    await open();
    expect(drawn('12ms').style.color).toBe(toCssColor(colorForRole('textMuted', 'dark')));
    await act(async () => {
      root?.unmount();
    });

    await draw(stateFrom(hubFrames.machineStateMeasured.replace('"ms":12,', '"ms":410,')));
    await open();
    expect(drawn('410ms').style.color).toBe(toCssColor(colorForToneText('needs-you', 'dark')));
  });

  it('writes a slow round trip in the warning word hue on paper, not the dot hue', async () => {
    await draw(stateFrom(hubFrames.machineStateMeasured.replace('"ms":12,', '"ms":410,')), 'light');
    await open();
    expect(drawn('410ms').style.color).toBe(toCssColor(colorForToneText('needs-you', 'light')));
  });
});
