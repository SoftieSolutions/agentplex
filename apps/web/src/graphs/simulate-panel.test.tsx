// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  graphDocumentSchema,
  graphSimulatedStepSchema,
  parseHubFrame,
  parseTextFrame,
  type GraphDocument,
  type GraphSimulatedStep,
  type RouteInput,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { SimulatePanel, type SimulatePanelProps } from './simulate-panel.js';
import panelSource from './simulate-panel.tsx?raw';

/**
 * The simulate panel, drawn from the path a real hub sent: the input box
 * pre-filled with the sample the graph's routes read, a refusal in words for
 * a box that is not an input, and the path as a sequence with each step's
 * why and the places a run would wait.
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

/** React tracks a field's value itself; the prototype's setter is the one it does not intercept. */
function typeInto(field: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter === undefined) throw new Error('no value setter on HTMLTextAreaElement');
  setter.call(field, text);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

const BASE = {
  position: { x: 0, y: 0 },
  placement: { kind: 'cheapest' },
  retry: { max: 0, backoff: 1 },
};

const DOC: GraphDocument = graphDocumentSchema.parse({
  nodes: [
    { ...BASE, id: 'start', kind: 'trigger', label: 'PR opened', source: 'manual' },
    {
      ...BASE,
      id: 'classify',
      kind: 'router',
      label: 'Classify diff',
      model: 'haiku',
      routes: [{ condition: 'language == rust', to: 'review' }],
      otherwise: null,
    },
    {
      ...BASE,
      id: 'review',
      kind: 'agent',
      label: 'Rust reviewer',
      prompt: 'Review.',
      provider: 'claude',
      storeId: 'store-work',
    },
  ],
  edges: [{ from: 'start', to: 'classify' }],
});

function capturedPath(): readonly GraphSimulatedStep[] {
  const parsed = parseTextFrame(parseHubFrame, hubFrames.graphSimulated);
  if (!parsed.ok || parsed.value.type !== 'graph-simulated') {
    throw new Error('the captured frame is not a simulation');
  }
  return parsed.value.path;
}

describe('SimulatePanel', () => {
  let container: HTMLElement;
  let root: Root | null = null;
  let sentInputs: RouteInput[];
  let closed: number;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    container = document.createElement('div');
    document.body.append(container);
    sentInputs = [];
    closed = 0;
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

  async function mount(props: Partial<SimulatePanelProps> = {}): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(
        withProvider(
          <SimulatePanel
            document={DOC}
            simulation={null}
            simulating={false}
            blocked={null}
            scheme="dark"
            onSimulate={(input) => sentInputs.push(input)}
            onClose={() => {
              closed += 1;
            }}
            {...props}
          />,
        ),
      );
    });
  }

  function box(): HTMLTextAreaElement {
    const field = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Input"]');
    if (field === null) throw new Error('no input box');
    return field;
  }

  function simulateButton(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>('[data-simulate-send]');
    if (button === null) throw new Error('no Simulate button in the panel');
    return button;
  }

  function steps(): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('[data-simulated-step]')];
  }

  it('pre-fills the box with the sample the graph’s routes read, and sends it parsed', async () => {
    await mount();

    expect(JSON.parse(box().value)).toEqual({ language: 'rust' });
    await act(() => {
      simulateButton().click();
    });
    expect(sentInputs).toEqual([{ language: 'rust' }]);
  });

  it('refuses a box that is not an input, in a sentence, and sends nothing', async () => {
    await mount();

    await act(() => {
      typeInto(box(), '["rust"]');
    });

    expect(container.querySelector('[data-simulate-refusal]')?.textContent).toBe(
      'the input is one JSON object of named fields, like {"language": "rust"}',
    );
    expect(simulateButton().disabled).toBe(true);

    await act(() => {
      typeInto(box(), '{"language": "go"}');
    });
    expect(container.querySelector('[data-simulate-refusal]')).toBeNull();
    await act(() => {
      simulateButton().click();
    });
    expect(sentInputs).toEqual([{ language: 'go' }]);
  });

  it('draws the captured path as a sequence, each step with its why', async () => {
    await mount({ simulation: { path: capturedPath(), reason: null } });

    expect(steps().map((step) => step.dataset['simulatedStep'])).toEqual([
      'start',
      'classify',
      'review',
    ]);
    expect(steps()[1]?.textContent).toContain('Classify diff');
    expect(steps()[1]?.textContent).toContain(
      'route 1, language == rust, would send it to Rust reviewer: language is "rust"',
    );
    expect(steps()[2]?.textContent).toContain('would run claude on mbp-robert');
    expect(steps().map((step) => step.dataset['simulatedTone'])).toEqual([
      'running',
      'running',
      'running',
    ]);
    expect(container.querySelector('[data-simulate-summary]')?.textContent).toBe(
      'would reach the end in 3 steps',
    );
  });

  it('marks where a run would wait, indents a child graph, and says where it would stop', async () => {
    const [start] = capturedPath();
    if (start === undefined) throw new Error('the capture has no steps');
    await mount({
      simulation: {
        path: [
          start,
          graphSimulatedStepSchema.parse({
            nodeId: 'gate',
            kind: 'human',
            depth: 1,
            outcome: 'would-wait',
            why: 'would wait on a person up to 30 minutes for ana',
          }),
        ],
        reason: 'a run would stop at the SUB-GRAPH node Lint suite: it would stop',
      },
    });

    const gate = steps()[1];
    expect(gate?.dataset['simulatedTone']).toBe('needs-you');
    expect(gate?.dataset['simulatedDepth']).toBe('1');
    expect(gate?.textContent).toContain('would wait on a person up to 30 minutes for ana');
    expect(container.querySelector('[data-simulate-summary]')?.textContent).toBe(
      'would stop: a run would stop at the SUB-GRAPH node Lint suite: it would stop',
    );
  });

  it('sends nothing while blocked or while one is out, and says why it is blocked', async () => {
    await mount({ blocked: 'Save the draft first: a simulation walks the draft the hub holds' });
    expect(simulateButton().disabled).toBe(true);
    expect(container.textContent).toContain('Save the draft first');

    await act(async () => {
      root?.unmount();
    });
    root = null;
    await mount({ simulating: true });
    expect(simulateButton().disabled).toBe(true);
  });

  it('closes when asked', async () => {
    await mount();
    const close = container.querySelector<HTMLButtonElement>('[data-simulate-close]');
    await act(() => {
      close?.click();
    });
    expect(closed).toBe(1);
  });

  it('is a named function component with no effect, reaching the library only through ui', () => {
    const source = panelSource;
    expect(source).toMatch(/export function SimulatePanel\(/);
    expect(source).not.toMatch(/useEffect/);
    expect(source).not.toMatch(/@mantine\//);
  });
});
