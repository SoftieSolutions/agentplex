// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame, type GraphRunState } from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { RunStrip } from './run-strip.js';

/**
 * The strip, drawn from the states a real hub sent: the sentence, the tone
 * dot, the hub's reason when a run failed, and Cancel exactly while a run is
 * live.
 */

declare global {
  // React's own name for the act flag.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

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

function state(text: string): GraphRunState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'graph-run-state') {
    throw new Error('the captured frame is not a run state');
  }
  const { type: _type, ...run } = parsed.value;
  return run;
}

describe('RunStrip', () => {
  let container: HTMLElement;
  let root: Root | null = null;
  let cancels: number;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    container = document.createElement('div');
    document.body.append(container);
    cancels = 0;
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
      <MantineProvider theme={theme} cssVariablesResolver={cssVariablesResolver} env="test">
        {element}
      </MantineProvider>
    );
  }

  async function mount(run: GraphRunState, cancelling = false, stale = false): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(
        withProvider(
          <RunStrip
            run={run}
            scheme="dark"
            cancelling={cancelling}
            stale={stale}
            onCancel={() => {
              cancels += 1;
            }}
          />,
        ),
      );
    });
  }

  function cancel(): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find((each) => each.textContent === 'Cancel');
  }

  it('reads the run live with its step, in the running tone, and offers Cancel', async () => {
    await mount(state(hubFrames.graphRunStateRunning));

    const strip = container.querySelector<HTMLElement>('[data-run-strip]');
    expect(strip?.textContent).toContain('run #1 · live · step 3/3');
    expect(strip?.dataset['runStatus']).toBe('running');
    // The tone and not the hue: which colour answers is the tokens file's
    // business, and jsdom serialises a hex as rgb() anyway.
    expect(strip?.dataset['runTone']).toBe('running');

    const button = cancel();
    expect(button?.disabled).toBe(false);
    await act(() => {
      button?.click();
    });
    expect(cancels).toBe(1);
  });

  it('reads a stale run as reconnecting, at rest, with no Cancel: nothing here can vouch for it', async () => {
    await mount(state(hubFrames.graphRunStateRunning), false, true);

    const strip = container.querySelector<HTMLElement>('[data-run-strip]');
    expect(strip?.textContent).toContain('run #1 · reconnecting · step 3/3');
    expect(strip?.textContent).not.toContain('live');
    expect(strip?.dataset['runTone']).toBe('idle');
    expect(strip?.dataset['runStale']).toBe('true');
    expect(cancel()).toBeUndefined();
  });

  it('reads a parked run as waiting on a person, in the needs-you tone, and still offers Cancel', async () => {
    await mount(state(hubFrames.graphRunStateWaiting));

    const strip = container.querySelector<HTMLElement>('[data-run-strip]');
    expect(strip?.textContent).toContain('run #1 · waiting on a person · step 2/2');
    expect(strip?.dataset['runStatus']).toBe('waiting');
    expect(strip?.dataset['runTone']).toBe('needs-you');
    expect(cancel()?.disabled).toBe(false);
  });

  it('disables Cancel while the cancel is out', async () => {
    await mount(state(hubFrames.graphRunStateRunning), true);
    expect(cancel()?.disabled).toBe(true);
  });

  it('draws a failed run with the hub’s sentence, in the blocked tone, and no Cancel', async () => {
    await mount(state(hubFrames.graphRunStateFailed));

    const strip = container.querySelector<HTMLElement>('[data-run-strip]');
    expect(strip?.textContent).toContain('run #2 · failed · step 2/3');
    expect(strip?.dataset['runTone']).toBe('blocked');
    expect(strip?.textContent).toContain('no route on Classify diff matched');
    expect(cancel()).toBeUndefined();
  });

  it('draws a cancelled run and a succeeded one at rest, with no Cancel', async () => {
    await mount(state(hubFrames.graphRunStateCancelled));
    expect(container.textContent).toContain('run #1 · cancelled · step 3/3');
    expect(cancel()).toBeUndefined();

    await act(async () => {
      root?.unmount();
    });
    root = null;
    await mount(state(hubFrames.graphRunStateSucceeded));
    expect(container.textContent).toContain('run #1 · succeeded · step 1/1');
    expect(cancel()).toBeUndefined();
  });
});
