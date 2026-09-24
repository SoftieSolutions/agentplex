// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseHubFrame,
  parseTextFrame,
  type GraphRunId,
  type GraphRunSummary,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { RunHistory } from './run-history.js';

/**
 * The history list, drawn from the list a real hub sent: newest first, one
 * row per run in the strip's words, the picked run marked, and a pick handed
 * up. A graph never run says so rather than drawing an empty box.
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

function capturedRuns(): readonly GraphRunSummary[] {
  const parsed = parseTextFrame(parseHubFrame, hubFrames.graphRunHistory);
  if (!parsed.ok || parsed.value.type !== 'graph-run-history') {
    throw new Error('the captured frame is not a history');
  }
  return parsed.value.runs;
}

describe('RunHistory', () => {
  let container: HTMLElement;
  let root: Root | null = null;
  let picked: (GraphRunId | null)[];

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    container = document.createElement('div');
    document.body.append(container);
    picked = [];
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

  async function mount(
    runs: readonly GraphRunSummary[] | null,
    selected: GraphRunId | null = null,
  ): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(
        withProvider(
          <RunHistory
            runs={runs}
            selected={selected}
            scheme="dark"
            onSelect={(runId) => picked.push(runId)}
          />,
        ),
      );
    });
  }

  function rows(): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('[data-history-run]')];
  }

  it('draws the runs newest first, in the strip’s words and tones', async () => {
    await mount(capturedRuns());

    expect(rows().map((row) => row.dataset['historyRun'])).toEqual(['hub-21', 'hub-15']);
    expect(rows()[0]?.textContent).toContain('run #2 · succeeded · 0s');
    expect(rows()[1]?.textContent).toContain('run #1 · succeeded');
    expect(rows().map((row) => row.dataset['runTone'])).toEqual(['idle', 'idle']);
  });

  it('hands a pick up, and marks the picked run', async () => {
    const runs = capturedRuns();
    const older = runs[1]?.runId ?? null;
    await mount(runs, older);

    expect(rows().map((row) => row.getAttribute('aria-current'))).toEqual([null, 'true']);

    await act(() => {
      rows()[0]?.click();
    });
    expect(picked).toEqual(['hub-21']);
  });

  it('hands up null when the picked run is picked again, to follow the newest', async () => {
    const runs = capturedRuns();
    await mount(runs, runs[0]?.runId ?? null);

    await act(() => {
      rows()[0]?.click();
    });

    expect(picked).toEqual([null]);
  });

  it('draws a failed run’s sentence beside it', async () => {
    const [first] = capturedRuns();
    if (first === undefined) throw new Error('the capture has no runs');
    await mount([{ ...first, status: 'failed', reason: 'no route on Classify diff matched' }]);

    expect(rows()[0]?.dataset['runTone']).toBe('blocked');
    expect(rows()[0]?.textContent).toContain('no route on Classify diff matched');
  });

  it('says a graph never run has no runs, and draws nothing while the hub has not answered', async () => {
    await mount([]);
    expect(container.textContent).toContain('No runs yet');

    await act(async () => {
      root?.unmount();
    });
    root = null;
    await mount(null);
    expect(rows()).toEqual([]);
    expect(container.textContent).not.toContain('No runs yet');
  });
});
