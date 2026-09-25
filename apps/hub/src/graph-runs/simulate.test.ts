import { describe, expect, it } from 'vitest';
import {
  GRAPH_RUN_OUTPUT_MAX_CHARS,
  graphDocumentSchema,
  nodeIdSchema,
  type GraphDocument,
  type GraphNode,
  type NodeId,
  type ServerRegistrationId,
} from '@agentplex/protocol';
import type { StartPlacement } from '../sessions/sessions.js';
import {
  SIMULATED_STEPS,
  simulate,
  type SimulatedTable,
  type SimulationDependencies,
} from './simulate.js';
import { SUBGRAPH_DEPTH_LIMIT, type LineageEntry } from './subgraph-executor.js';

/**
 * A simulation: the walk a run would take, with every node answered by a
 * table that reports and does nothing.
 *
 * Everything it may consult is a plain function this suite writes -- where an
 * AGENT would be placed, a published version's document, a graph's name --
 * and nothing else is handed in: no sessions, no timers, no database, no
 * approvals. So what is under test is the sentence each kind of node says
 * and the path the walk takes, and the absence of anything else is the
 * absence of any way to reach it.
 */

const RELEASE = nodeIdSchema.parse('graph-release');
const LINT = nodeIdSchema.parse('graph-lint');
const ATTIC = 'registration-attic' as ServerRegistrationId;
const ROOT: LineageEntry = { graph: RELEASE, name: 'release-pipeline' };

const BASE = {
  position: { x: 0, y: 0 },
  placement: { kind: 'cheapest' },
  retry: { max: 0, backoff: 1 },
};
const TRIGGER = { ...BASE, id: 'start', kind: 'trigger', label: 'PR opened', source: 'manual' };
const ROUTER = {
  ...BASE,
  id: 'classify',
  kind: 'router',
  label: 'Classify',
  model: 'haiku',
  routes: [
    { condition: 'only docs/**', to: 'docs' },
    { condition: 'language == rust', to: 'review' },
  ],
  otherwise: null,
};
const AGENT = {
  ...BASE,
  id: 'review',
  kind: 'agent',
  label: 'Rust reviewer',
  prompt: 'Review the Rust in this change.',
  provider: 'claude',
  storeId: 'store-work',
};
const DOCS = { ...AGENT, id: 'docs', label: 'Docs reviewer' };
const GATE = {
  ...BASE,
  id: 'gate',
  kind: 'human',
  label: 'Ana approves',
  approvers: ['ana', 'bo'],
  timeoutMinutes: 60,
};
const SHIP = { ...BASE, id: 'ship', kind: 'action', label: 'Ship it', name: 'merge' };
const LINT_NODE = {
  ...BASE,
  id: 'lint',
  kind: 'subgraph',
  label: 'Lint suite',
  graph: LINT,
  version: 3,
};

function document(value: unknown): GraphDocument {
  return graphDocumentSchema.parse(value);
}

/** TRIGGER -> ROUTER -> AGENT -> HUMAN, with a docs branch off the router. */
const PIPELINE = document({
  nodes: [TRIGGER, ROUTER, AGENT, DOCS, GATE],
  edges: [
    { from: 'start', to: 'classify' },
    { from: 'review', to: 'gate' },
  ],
});

interface Recorded {
  readonly placed: Extract<GraphNode, { kind: 'agent' }>[];
  readonly versions: { graph: NodeId; version: number }[];
}

function dependencies(
  options: {
    place?: StartPlacement;
    published?: ReadonlyMap<string, GraphDocument>;
  } = {},
): SimulationDependencies & Recorded {
  const placed: Extract<GraphNode, { kind: 'agent' }>[] = [];
  const versions: { graph: NodeId; version: number }[] = [];
  return {
    placed,
    versions,
    place: (node) => {
      placed.push(node);
      return options.place ?? { ok: true, server: ATTIC, label: 'attic' };
    },
    publishedVersion: async (graph, version) => {
      versions.push({ graph, version });
      return options.published?.get(`${graph}@${String(version)}`) ?? null;
    },
    nameOf: async (graph) => (graph === LINT ? 'lint-suite' : graph),
  };
}

describe('simulate', () => {
  it('walks TRIGGER, ROUTER, AGENT and HUMAN and says why at every step', async () => {
    const deps = dependencies();
    const simulated = await simulate(ROOT, PIPELINE, { language: 'rust' }, deps);

    expect(simulated).toEqual({
      path: [
        {
          nodeId: 'start',
          kind: 'trigger',
          depth: 0,
          outcome: 'would-run',
          why: 'would start the run with {"language":"rust"}',
        },
        {
          nodeId: 'classify',
          kind: 'router',
          depth: 0,
          outcome: 'would-run',
          why: 'route 2, language == rust, would send it to Rust reviewer: language is "rust"',
        },
        {
          nodeId: 'review',
          kind: 'agent',
          depth: 0,
          outcome: 'would-run',
          why: 'would run claude on attic',
        },
        {
          nodeId: 'gate',
          kind: 'human',
          depth: 0,
          outcome: 'would-wait',
          why: 'would wait on a person up to 60 minutes for ana, bo',
        },
      ],
      reason: null,
    });
    // Placement was asked, of the one node that needed it; nothing started.
    expect(deps.placed.map((node) => node.id)).toEqual(['review']);
  });

  it('follows the route whose condition holds against the input, and says which and why', async () => {
    const simulated = await simulate(
      ROOT,
      PIPELINE,
      { files: ['docs/intro.md', 'docs/guide/setup.md'] },
      dependencies(),
    );
    expect(simulated.path[1]).toEqual({
      nodeId: 'classify',
      kind: 'router',
      depth: 0,
      outcome: 'would-run',
      why: 'route 1, only docs/**, would send it to Docs reviewer: every entry of files fits docs/**',
    });
    expect(simulated.path.map((step) => step.nodeId)).toEqual(['start', 'classify', 'docs']);
  });

  it('says a not-equals route held because the field is not the literal', async () => {
    const doc = document({
      nodes: [
        TRIGGER,
        { ...ROUTER, routes: [{ condition: 'language != rust', to: 'docs' }], otherwise: 'review' },
        AGENT,
        DOCS,
      ],
      edges: [{ from: 'start', to: 'classify' }],
    });
    const simulated = await simulate(ROOT, doc, { language: 'go' }, dependencies());
    expect(simulated.path[1]?.why).toBe(
      'route 1, language != rust, would send it to Docs reviewer: language is not "rust"',
    );
  });

  it('falls to otherwise when no route holds, and stops where no route and no otherwise would', async () => {
    const withOtherwise = document({
      nodes: [TRIGGER, { ...ROUTER, otherwise: 'docs' }, AGENT, DOCS],
      edges: [{ from: 'start', to: 'classify' }],
    });
    const fell = await simulate(ROOT, withOtherwise, { language: 'go' }, dependencies());
    expect(fell.path[1]?.why).toBe('no route holds, so otherwise would send it to Docs reviewer');
    expect(fell.reason).toBeNull();

    const stopped = await simulate(ROOT, PIPELINE, { language: 'go' }, dependencies());
    expect(stopped.path[1]).toEqual({
      nodeId: 'classify',
      kind: 'router',
      depth: 0,
      outcome: 'would-stop',
      why: 'no route holds for this input and there is no otherwise',
    });
    expect(stopped.path).toHaveLength(2);
    expect(stopped.reason).toBe(
      'a run would stop at the ROUTER node Classify: no route holds for this input and there is no otherwise',
    );
  });

  it('reports the machine placement would choose, or that no machine could take the node', async () => {
    const deps = dependencies({ place: { ok: false, problem: 'attic does not run claude' } });
    const simulated = await simulate(ROOT, PIPELINE, { language: 'rust' }, deps);
    expect(simulated.path.at(-1)).toEqual({
      nodeId: 'review',
      kind: 'agent',
      depth: 0,
      outcome: 'would-stop',
      why: 'no machine could take this node: attic does not run claude',
    });
    // The walk ends where a run would: the HUMAN after it is never reached.
    expect(simulated.path.map((step) => step.nodeId)).toEqual(['start', 'classify', 'review']);
    expect(simulated.reason).toBe(
      'a run would stop at the AGENT node Rust reviewer: no machine could take this node: attic does not run claude',
    );
  });

  it('reports each node’s retry policy, and none for a HUMAN, whose answer is never asked again', async () => {
    const doc = document({
      nodes: [
        TRIGGER,
        { ...AGENT, retry: { max: 2, backoff: 30 } },
        { ...GATE, retry: { max: 3, backoff: 5 } },
      ],
      edges: [
        { from: 'start', to: 'review' },
        { from: 'review', to: 'gate' },
      ],
    });
    const simulated = await simulate(ROOT, doc, {}, dependencies());
    expect(simulated.path[1]?.why).toBe(
      'would run claude on attic; a failure would be tried again up to 2 more times, 30 s apart',
    );
    expect(simulated.path[2]?.why).toBe('would wait on a person up to 60 minutes for ana, bo');
  });

  it('says a HUMAN with no timeout would wait as long as it takes', async () => {
    const doc = document({
      nodes: [TRIGGER, { ...GATE, timeoutMinutes: null, approvers: ['ana'] }],
      edges: [{ from: 'start', to: 'gate' }],
    });
    const simulated = await simulate(ROOT, doc, {}, dependencies());
    expect(simulated.path[1]).toEqual({
      nodeId: 'gate',
      kind: 'human',
      depth: 0,
      outcome: 'would-wait',
      why: 'would wait on a person for as long as it takes, for ana',
    });
  });

  it('reports an ACTION by name and does nothing', async () => {
    const doc = document({
      nodes: [TRIGGER, SHIP, AGENT],
      edges: [
        { from: 'start', to: 'ship' },
        { from: 'ship', to: 'review' },
      ],
    });
    const deps = dependencies();
    const simulated = await simulate(ROOT, doc, {}, deps);
    expect(simulated.path.at(-1)).toEqual({
      nodeId: 'ship',
      kind: 'action',
      depth: 0,
      outcome: 'would-stop',
      why: 'would perform merge, and no action of that name exists on this build',
    });
    expect(deps.placed).toEqual([]);
    expect(deps.versions).toEqual([]);
  });

  describe('SUB-GRAPH', () => {
    const PARENT = document({
      nodes: [TRIGGER, LINT_NODE, AGENT],
      edges: [
        { from: 'start', to: 'lint' },
        { from: 'lint', to: 'review' },
      ],
    });
    const CHILD = document({
      nodes: [TRIGGER, { ...GATE, approvers: ['cy'] }],
      edges: [{ from: 'start', to: 'gate' }],
    });

    it('recurses into the pinned published version, its steps one depth down after the step', async () => {
      const deps = dependencies({ published: new Map([[`${LINT}@3`, CHILD]]) });
      const simulated = await simulate(ROOT, PARENT, { language: 'rust' }, deps);
      expect(simulated.path).toEqual([
        expect.objectContaining({ nodeId: 'start', depth: 0 }),
        {
          nodeId: 'lint',
          kind: 'subgraph',
          depth: 0,
          outcome: 'would-run',
          why: 'would run lint-suite v3',
        },
        {
          nodeId: 'start',
          kind: 'trigger',
          depth: 1,
          outcome: 'would-run',
          why: 'would start the run with {"language":"rust"}',
        },
        {
          nodeId: 'gate',
          kind: 'human',
          depth: 1,
          outcome: 'would-wait',
          why: 'would wait on a person up to 60 minutes for cy',
        },
        expect.objectContaining({ nodeId: 'review', depth: 0, outcome: 'would-run' }),
      ]);
      expect(simulated.reason).toBeNull();
      expect(deps.versions).toEqual([{ graph: LINT, version: 3 }]);
    });

    it('stops at a pin that resolves to no published version', async () => {
      const simulated = await simulate(ROOT, PARENT, {}, dependencies());
      expect(simulated.path.at(-1)).toEqual({
        nodeId: 'lint',
        kind: 'subgraph',
        depth: 0,
        outcome: 'would-stop',
        why: `it pins ${LINT} at v3, which is not a published version of any graph this hub has`,
      });
    });

    it('stops the parent where its child would stop, and says so on the SUB-GRAPH step', async () => {
      const stuck = document({
        nodes: [TRIGGER, SHIP],
        edges: [{ from: 'start', to: 'ship' }],
      });
      const deps = dependencies({ published: new Map([[`${LINT}@3`, stuck]]) });
      const simulated = await simulate(ROOT, PARENT, {}, deps);
      expect(simulated.path.map((step) => [step.nodeId, step.depth, step.outcome])).toEqual([
        ['start', 0, 'would-run'],
        ['lint', 0, 'would-stop'],
        ['start', 1, 'would-run'],
        ['ship', 1, 'would-stop'],
      ]);
      expect(simulated.path[1]?.why).toBe(
        'would run lint-suite v3, and it would stop: a run would stop at the ACTION node Ship it: would perform merge, and no action of that name exists on this build',
      );
    });

    it('refuses a chain that reaches itself, in the words a run uses', async () => {
      const self = document({
        nodes: [TRIGGER, { ...LINT_NODE, graph: RELEASE, version: 1 }],
        edges: [{ from: 'start', to: 'lint' }],
      });
      const simulated = await simulate(ROOT, self, {}, dependencies());
      expect(simulated.path.at(-1)).toEqual({
        nodeId: 'lint',
        kind: 'subgraph',
        depth: 0,
        outcome: 'would-stop',
        why: 'it would run release-pipeline, which is already running above it in this chain: release-pipeline → release-pipeline',
      });
    });

    it('goes no deeper than a run may', async () => {
      // A chain of distinct graphs, each pinning the next: g0 -> g1 -> ... .
      const published = new Map<string, GraphDocument>();
      const names = new Map<string, string>();
      for (let level = 0; level <= SUBGRAPH_DEPTH_LIMIT + 2; level += 1) {
        const graph = `g${String(level)}`;
        names.set(graph, graph);
        published.set(
          `${graph}@1`,
          document({
            nodes: [TRIGGER, { ...LINT_NODE, graph: `g${String(level + 1)}`, version: 1 }],
            edges: [{ from: 'start', to: 'lint' }],
          }),
        );
      }
      const deps: SimulationDependencies = {
        ...dependencies({ published }),
        nameOf: async (graph) => graph,
      };
      const root: LineageEntry = { graph: nodeIdSchema.parse('g0'), name: 'g0' };
      const start = published.get('g0@1');
      if (start === undefined) throw new Error('the chain has no first graph');
      const simulated = await simulate(root, start, {}, deps);
      const deepest = Math.max(...simulated.path.map((step) => step.depth));
      expect(deepest).toBe(SUBGRAPH_DEPTH_LIMIT);
      const refused = simulated.path.find((step) => step.why.startsWith('it would start a run'));
      expect(refused).toEqual({
        nodeId: 'lint',
        kind: 'subgraph',
        depth: SUBGRAPH_DEPTH_LIMIT,
        outcome: 'would-stop',
        why: `it would start a run ${String(SUBGRAPH_DEPTH_LIMIT + 1)} graphs deep, and a chain of SUB-GRAPH nodes goes at most ${String(SUBGRAPH_DEPTH_LIMIT)}`,
      });
    });
  });

  describe('the walk it reuses', () => {
    it('stops on what the walk itself refuses, in the walk’s words', async () => {
      const doc = document({
        nodes: [TRIGGER, AGENT, DOCS],
        edges: [
          { from: 'start', to: 'review' },
          { from: 'start', to: 'docs' },
        ],
      });
      const simulated = await simulate(ROOT, doc, {}, dependencies());
      expect(simulated.path.map((step) => step.nodeId)).toEqual(['start']);
      expect(simulated.reason).toBe(
        'the TRIGGER node PR opened has 2 outgoing edges, and only a ROUTER chooses between them',
      );

      const empty = await simulate(ROOT, document({ nodes: [], edges: [] }), {}, dependencies());
      expect(empty).toEqual({
        path: [],
        reason: 'a run starts at the one TRIGGER node, and this document has 0',
      });
    });

    it('bounds the path, and says it stopped for that', async () => {
      const simulated = await simulate(ROOT, PIPELINE, { language: 'rust' }, dependencies(), {
        limit: 2,
      });
      expect(simulated.path.map((step) => step.nodeId)).toEqual(['start', 'classify']);
      expect(simulated.reason).toBe(
        'the simulation stopped after 2 steps, the most one answer carries',
      );
    });

    it('cuts a why at the bound a step output has', async () => {
      const approvers = Array.from({ length: 16 }, (_, index) =>
        `approver-${String(index)}-`.padEnd(64, 'x'),
      );
      const doc = document({
        nodes: [TRIGGER, { ...GATE, approvers }],
        edges: [{ from: 'start', to: 'gate' }],
      });
      const simulated = await simulate(ROOT, doc, { note: 'y'.repeat(2_000) }, dependencies());
      for (const step of simulated.path) {
        expect(step.why.length).toBeLessThanOrEqual(GRAPH_RUN_OUTPUT_MAX_CHARS);
      }
      expect(simulated.path[1]?.why.endsWith('…')).toBe(true);
    });
  });

  it('has an entry for every kind, so a kind added without one fails the typecheck', () => {
    expect(Object.keys(SIMULATED_STEPS).sort()).toEqual(
      ['action', 'agent', 'human', 'router', 'subgraph', 'trigger'].sort(),
    );
    const { action: _action, ...withoutAction } = SIMULATED_STEPS;
    // @ts-expect-error -- a table missing ACTION is not a SimulatedTable.
    const incomplete: SimulatedTable = withoutAction;
    expect(incomplete).toBeDefined();
  });
});
