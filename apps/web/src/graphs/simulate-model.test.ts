import { describe, expect, it } from 'vitest';
import {
  graphDocumentSchema,
  graphSimulatedStepSchema,
  parseHubFrame,
  parseTextFrame,
  ROUTE_INPUT_MAX_CHARS,
  type GraphDocument,
  type GraphSimulatedStep,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import {
  parseSimulateInput,
  sampleInput,
  sampleInputText,
  simulatedRows,
  simulationSummary,
} from './simulate-model.js';

/**
 * What the simulate panel reads: the input a person typed, parsed by the
 * schema a run's input is parsed by, the sample it starts from, and the path
 * the hub answered drawn as a sequence with each step's why and every place a
 * run would wait on a person.
 */

const BASE = {
  position: { x: 0, y: 0 },
  placement: { kind: 'cheapest' },
  retry: { max: 0, backoff: 1 },
};

function document(value: unknown): GraphDocument {
  return graphDocumentSchema.parse(value);
}

const DOC = document({
  nodes: [
    { ...BASE, id: 'start', kind: 'trigger', label: 'PR opened', source: 'manual' },
    {
      ...BASE,
      id: 'classify',
      kind: 'router',
      label: 'Classify diff',
      model: 'haiku',
      routes: [
        { condition: 'pr.language == rust', to: 'review' },
        { condition: 'only docs/**', to: 'review' },
        { condition: 'pr.language != go', to: 'review' },
      ],
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

function step(value: unknown): GraphSimulatedStep {
  return graphSimulatedStepSchema.parse(value);
}

function capturedPath(): readonly GraphSimulatedStep[] {
  const parsed = parseTextFrame(parseHubFrame, hubFrames.graphSimulated);
  if (!parsed.ok || parsed.value.type !== 'graph-simulated') {
    throw new Error('the captured frame is not a simulation');
  }
  return parsed.value.path;
}

describe('parseSimulateInput', () => {
  it('takes one JSON object, parsed by the schema a run’s input is', () => {
    expect(parseSimulateInput('{"language": "rust", "files": ["a.rs"]}')).toEqual({
      ok: true,
      input: { language: 'rust', files: ['a.rs'] },
    });
    expect(parseSimulateInput('{}')).toEqual({ ok: true, input: {} });
  });

  it('refuses what is not JSON in a sentence', () => {
    const parsed = parseSimulateInput('{language: rust}');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problem).toMatch(/^the input is not JSON: /);
  });

  it('refuses JSON that is not one object of named fields', () => {
    for (const text of ['[1, 2]', '"rust"', 'null', '42']) {
      expect(parseSimulateInput(text)).toEqual({
        ok: false,
        problem: 'the input is one JSON object of named fields, like {"language": "rust"}',
      });
    }
  });

  it('refuses an input past the bound a run’s input has', () => {
    const parsed = parseSimulateInput(JSON.stringify({ files: 'x'.repeat(ROUTE_INPUT_MAX_CHARS) }));
    expect(parsed).toEqual({
      ok: false,
      problem: `an input is at most ${String(ROUTE_INPUT_MAX_CHARS)} characters serialised`,
    });
  });

  it('says an empty box is not an input rather than guessing one', () => {
    expect(parseSimulateInput('   ')).toEqual({
      ok: false,
      problem: 'the input is one JSON object of named fields, like {"language": "rust"}',
    });
  });
});

describe('sampleInput', () => {
  it('fills every field a route reads with the literal of the first route that names it', () => {
    // The first route holds against the sample, so the path shows the graph
    // taking a branch rather than falling off its first router.
    expect(sampleInput(DOC)).toEqual({ pr: { language: 'rust' }, files: [] });
  });

  it('is the empty object for a graph with no router', () => {
    expect(sampleInput(document({ nodes: [], edges: [] }))).toEqual({});
  });

  it('is pretty-printed for the box, and parses back as itself', () => {
    const text = sampleInputText(DOC);
    expect(text).toBe('{\n  "pr": {\n    "language": "rust"\n  },\n  "files": []\n}');
    expect(parseSimulateInput(text)).toEqual({ ok: true, input: sampleInput(DOC) });
  });
});

describe('simulatedRows', () => {
  it('draws the captured path as a sequence, each step with its why and its tone', () => {
    const rows = simulatedRows(capturedPath(), DOC);
    expect(rows.map((row) => [row.label, row.kind, row.outcome, row.tone])).toEqual([
      ['PR opened', 'TRIGGER', 'would run', 'running'],
      ['Classify diff', 'ROUTER', 'would run', 'running'],
      ['Rust reviewer', 'AGENT', 'would run', 'running'],
    ]);
    expect(rows[1]?.why).toBe(
      'route 1, language == rust, would send it to Rust reviewer: language is "rust"',
    );
    expect(rows.map((row) => row.depth)).toEqual([0, 0, 0]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
  });

  it('marks a wait and a stop, and names a child graph’s node by its id', () => {
    const path: GraphSimulatedStep[] = [
      step({ ...capturedPath()[0] }),
      step({
        nodeId: 'gate',
        kind: 'human',
        depth: 1,
        outcome: 'would-wait',
        why: 'would wait on a person up to 30 minutes for ana',
      }),
      step({
        nodeId: 'ship',
        kind: 'action',
        depth: 1,
        outcome: 'would-stop',
        why: 'would perform merge, and no action of that name exists on this build',
      }),
    ];
    const rows = simulatedRows(path, DOC);
    expect(rows.map((row) => [row.label, row.outcome, row.tone, row.depth])).toEqual([
      ['PR opened', 'would run', 'running', 0],
      ['gate', 'would wait', 'needs-you', 1],
      ['ship', 'would stop', 'blocked', 1],
    ]);
  });
});

describe('simulationSummary', () => {
  it('says the walk reached its end, how far, and where it would wait', () => {
    expect(simulationSummary(capturedPath(), null)).toBe('would reach the end in 3 steps');
    const waiting: GraphSimulatedStep[] = [
      ...capturedPath(),
      step({
        nodeId: 'gate',
        kind: 'human',
        depth: 0,
        outcome: 'would-wait',
        why: 'would wait on a person for as long as it takes, for ana',
      }),
    ];
    expect(simulationSummary(waiting, null)).toBe(
      'would reach the end in 4 steps, waiting on a person once',
    );
    expect(simulationSummary([...waiting, ...waiting.slice(3)], null)).toBe(
      'would reach the end in 5 steps, waiting on a person 2 times',
    );
  });

  it('says where it would stop, in the hub’s sentence', () => {
    expect(
      simulationSummary([], 'a run starts at the one TRIGGER node, and this document has 0'),
    ).toBe('would stop: a run starts at the one TRIGGER node, and this document has 0');
  });
});
