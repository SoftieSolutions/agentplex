import { describe, expect, it } from 'vitest';
import {
  GRAPH_HUMAN_TIMEOUT_MAX_MINUTES,
  GRAPH_LABEL_MAX_CHARS,
  GRAPH_NODES_MAX,
  GRAPH_PROMPT_MAX_CHARS,
  GRAPH_RETRY_BACKOFF_MAX_SECONDS,
  emptyGraphDocument,
  graphDocumentSchema,
  graphNameSchema,
  graphNodeKindSchema,
  type GraphNodeKind,
} from './graph.js';

/** A node of each kind, so the suite below can assemble documents by hand. */
const NODES = {
  trigger: {
    id: 'start',
    kind: 'trigger',
    label: 'PR opened',
    position: { x: 40, y: 92 },
    placement: { kind: 'cheapest' },
    retry: { max: 0, backoff: 1 },
    source: 'manual',
  },
  router: {
    id: 'classify',
    kind: 'router',
    label: 'Classify diff',
    position: { x: 250, y: 84 },
    placement: { kind: 'cheapest' },
    retry: { max: 1, backoff: 5 },
    model: 'haiku',
    routes: [
      { condition: 'language == rust', to: 'rust' },
      { condition: 'only docs/**', to: 'docs' },
    ],
    otherwise: 'docs',
  },
  agent: {
    id: 'rust',
    kind: 'agent',
    label: 'Rust reviewer',
    position: { x: 500, y: 62 },
    placement: { kind: 'pin', server: 'registration-gpu-box-01' },
    retry: { max: 2, backoff: 30 },
    prompt: 'Review the Rust in this change.',
    provider: 'claude',
    storeId: 'store-universe',
  },
  subgraph: {
    id: 'docs',
    kind: 'subgraph',
    label: 'test-matrix',
    position: { x: 250, y: 312 },
    placement: { kind: 'cheapest' },
    retry: { max: 0, backoff: 1 },
    graph: 'hub-12',
    version: 2,
  },
  human: {
    id: 'approve',
    kind: 'human',
    label: 'Approve merge',
    position: { x: 500, y: 456 },
    placement: { kind: 'cheapest' },
    retry: { max: 0, backoff: 1 },
    approvers: ['robert', 'ana'],
    timeoutMinutes: 1440,
  },
  action: {
    id: 'merge',
    kind: 'action',
    label: 'Merge + tag',
    position: { x: 170, y: 542 },
    placement: { kind: 'cheapest' },
    retry: { max: 0, backoff: 1 },
    name: 'merge-and-tag',
  },
} as const;

const DOCUMENT = {
  nodes: [NODES.trigger, NODES.router, NODES.agent, NODES.subgraph, NODES.human, NODES.action],
  edges: [
    { from: 'start', to: 'classify' },
    { from: 'rust', to: 'approve' },
    { from: 'docs', to: 'approve' },
    { from: 'approve', to: 'merge' },
  ],
};

describe('graphNodeKindSchema', () => {
  it('names the six kinds as a closed enum, so a table keyed on it is exhaustive', () => {
    expect(graphNodeKindSchema.options).toEqual([
      'trigger',
      'router',
      'agent',
      'subgraph',
      'human',
      'action',
    ]);
    // The type is what a later `Record<GraphNodeKind, ...>` leans on: a kind
    // added to the enum with no entry in such a table fails to typecheck.
    const table: Record<GraphNodeKind, number> = {
      trigger: 0,
      router: 1,
      agent: 2,
      subgraph: 3,
      human: 4,
      action: 5,
    };
    expect(Object.keys(table)).toHaveLength(graphNodeKindSchema.options.length);
  });
});

describe('graphDocumentSchema', () => {
  it('parses a document with one node of every kind and the edges between them', () => {
    const parsed = graphDocumentSchema.safeParse(DOCUMENT);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.nodes.map((node) => node.kind)).toEqual(graphNodeKindSchema.options);
    expect(parsed.data.edges).toHaveLength(4);
  });

  it('parses the empty document a fresh draft starts as', () => {
    expect(graphDocumentSchema.safeParse(emptyGraphDocument()).success).toBe(true);
    expect(emptyGraphDocument()).toEqual({ nodes: [], edges: [] });
  });

  it('refuses a kind it has never heard of', () => {
    const document = {
      nodes: [{ ...NODES.action, kind: 'webhook' }],
      edges: [],
    };
    expect(graphDocumentSchema.safeParse(document).success).toBe(false);
  });

  it('refuses two nodes with one id, naming the id', () => {
    const document = { nodes: [NODES.trigger, { ...NODES.action, id: 'start' }], edges: [] };
    const parsed = graphDocumentSchema.safeParse(document);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.message).join('\n')).toContain('start');
  });

  it('refuses an edge to a node that is not in the document', () => {
    const document = { nodes: [NODES.trigger], edges: [{ from: 'start', to: 'nowhere' }] };
    const parsed = graphDocumentSchema.safeParse(document);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.message).join('\n')).toContain('nowhere');
  });

  it('refuses an edge from a node that is not in the document', () => {
    const document = { nodes: [NODES.trigger], edges: [{ from: 'ghost', to: 'start' }] };
    expect(graphDocumentSchema.safeParse(document).success).toBe(false);
  });

  it('refuses a route to a node that is not in the document, and an otherwise that is not', () => {
    const routed = {
      nodes: [NODES.trigger, { ...NODES.router, routes: [{ condition: 'a == b', to: 'gone' }] }],
      edges: [],
    };
    expect(graphDocumentSchema.safeParse(routed).success).toBe(false);
    const fallen = {
      nodes: [NODES.trigger, { ...NODES.router, routes: [], otherwise: 'gone' }],
      edges: [],
    };
    expect(graphDocumentSchema.safeParse(fallen).success).toBe(false);
  });

  it('refuses a route whose condition does not parse, with the parser’s words', () => {
    const document = {
      nodes: [{ ...NODES.router, routes: [{ condition: 'language <> rust', to: 'classify' }] }],
      edges: [],
    };
    const parsed = graphDocumentSchema.safeParse(document);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.message).join('\n')).toContain('position 9');
  });

  it('takes a router with no otherwise, as null and never as an absent field', () => {
    const document = { nodes: [{ ...NODES.router, routes: [], otherwise: null }], edges: [] };
    expect(graphDocumentSchema.safeParse(document).success).toBe(true);
    const { otherwise: _dropped, ...withoutOtherwise } = NODES.router;
    expect(
      graphDocumentSchema.safeParse({ nodes: [{ ...withoutOtherwise, routes: [] }], edges: [] })
        .success,
    ).toBe(false);
  });

  it('bounds the retry policy: at most ten attempts, a backoff of at least one', () => {
    const tooMany = { nodes: [{ ...NODES.agent, retry: { max: 11, backoff: 1 } }], edges: [] };
    expect(graphDocumentSchema.safeParse(tooMany).success).toBe(false);
    const noWait = { nodes: [{ ...NODES.agent, retry: { max: 1, backoff: 0 } }], edges: [] };
    expect(graphDocumentSchema.safeParse(noWait).success).toBe(false);
    const ten = { nodes: [{ ...NODES.agent, retry: { max: 10, backoff: 1 } }], edges: [] };
    expect(graphDocumentSchema.safeParse(ten).success).toBe(true);
  });

  it('bounds the backoff at an hour, so a wait is one a timer can keep', () => {
    const anHour = {
      nodes: [{ ...NODES.agent, retry: { max: 1, backoff: GRAPH_RETRY_BACKOFF_MAX_SECONDS } }],
      edges: [],
    };
    expect(graphDocumentSchema.safeParse(anHour).success).toBe(true);
    const longer = {
      nodes: [{ ...NODES.agent, retry: { max: 1, backoff: GRAPH_RETRY_BACKOFF_MAX_SECONDS + 1 } }],
      edges: [],
    };
    expect(graphDocumentSchema.safeParse(longer).success).toBe(false);
    // Past 2^31 - 1 milliseconds Node fires a timer after one millisecond
    // instead, which is the tight loop the minimum exists to prevent.
    expect(GRAPH_RETRY_BACKOFF_MAX_SECONDS * 1000).toBeLessThan(2 ** 31);
  });

  it('takes both placements and refuses a third', () => {
    const pinned = { nodes: [NODES.agent], edges: [] };
    expect(graphDocumentSchema.safeParse(pinned).success).toBe(true);
    const anywhere = {
      nodes: [{ ...NODES.agent, placement: { kind: 'anywhere' } }],
      edges: [],
    };
    expect(graphDocumentSchema.safeParse(anywhere).success).toBe(false);
    const pinNowhere = {
      nodes: [{ ...NODES.agent, placement: { kind: 'pin' } }],
      edges: [],
    };
    expect(graphDocumentSchema.safeParse(pinNowhere).success).toBe(false);
  });

  it('takes only a manual trigger for now', () => {
    const github = { nodes: [{ ...NODES.trigger, source: 'github' }], edges: [] };
    expect(graphDocumentSchema.safeParse(github).success).toBe(false);
  });

  it('needs an agent to say which store its session starts in', () => {
    const { storeId: _dropped, ...homeless } = NODES.agent;
    expect(graphDocumentSchema.safeParse({ nodes: [homeless], edges: [] }).success).toBe(false);
  });

  it('bounds the prompt and the node count', () => {
    const longPrompt = {
      nodes: [{ ...NODES.agent, prompt: 'x'.repeat(GRAPH_PROMPT_MAX_CHARS + 1) }],
      edges: [],
    };
    expect(graphDocumentSchema.safeParse(longPrompt).success).toBe(false);
    const crowd = {
      nodes: Array.from({ length: GRAPH_NODES_MAX + 1 }, (_, index) => ({
        ...NODES.action,
        id: `node-${String(index)}`,
      })),
      edges: [],
    };
    expect(graphDocumentSchema.safeParse(crowd).success).toBe(false);
  });

  it('pins a sub-graph to a whole positive version', () => {
    const draft = { nodes: [{ ...NODES.subgraph, version: 0 }], edges: [] };
    expect(graphDocumentSchema.safeParse(draft).success).toBe(false);
    const half = { nodes: [{ ...NODES.subgraph, version: 1.5 }], edges: [] };
    expect(graphDocumentSchema.safeParse(half).success).toBe(false);
  });

  it("bounds a human node's timeout at fourteen days, so the wait is one a timer can keep", () => {
    const longest = {
      nodes: [{ ...NODES.human, timeoutMinutes: GRAPH_HUMAN_TIMEOUT_MAX_MINUTES }],
      edges: [],
    };
    expect(graphDocumentSchema.safeParse(longest).success).toBe(true);
    const past = {
      nodes: [{ ...NODES.human, timeoutMinutes: GRAPH_HUMAN_TIMEOUT_MAX_MINUTES + 1 }],
      edges: [],
    };
    expect(graphDocumentSchema.safeParse(past).success).toBe(false);
    // 35792 minutes is the first value whose milliseconds overflow a 32-bit
    // timer, which Node then fires after one millisecond.
    const overflowing = { nodes: [{ ...NODES.human, timeoutMinutes: 35_792 }], edges: [] };
    expect(graphDocumentSchema.safeParse(overflowing).success).toBe(false);
    expect(GRAPH_HUMAN_TIMEOUT_MAX_MINUTES).toBe(14 * 24 * 60);
    expect(GRAPH_HUMAN_TIMEOUT_MAX_MINUTES * 60_000).toBeLessThan(2 ** 31);
  });

  it('bounds a node label, since the label is what a push and the bell say', () => {
    const longest = {
      nodes: [{ ...NODES.human, label: 'x'.repeat(GRAPH_LABEL_MAX_CHARS) }],
      edges: [],
    };
    expect(graphDocumentSchema.safeParse(longest).success).toBe(true);
    const past = {
      nodes: [{ ...NODES.human, label: 'x'.repeat(GRAPH_LABEL_MAX_CHARS + 1) }],
      edges: [],
    };
    expect(graphDocumentSchema.safeParse(past).success).toBe(false);
    expect(GRAPH_LABEL_MAX_CHARS).toBe(120);
  });

  it('takes a human node with no timeout as null', () => {
    const patient = { nodes: [{ ...NODES.human, timeoutMinutes: null }], edges: [] };
    expect(graphDocumentSchema.safeParse(patient).success).toBe(true);
    const nobody = { nodes: [{ ...NODES.human, approvers: [] }], edges: [] };
    expect(graphDocumentSchema.safeParse(nobody).success).toBe(false);
  });
});

describe('graphNameSchema', () => {
  it('is a short line of text with something in it', () => {
    expect(graphNameSchema.safeParse('release-pipeline').success).toBe(true);
    expect(graphNameSchema.safeParse('   ').success).toBe(false);
    expect(graphNameSchema.safeParse('').success).toBe(false);
    expect(graphNameSchema.safeParse('x'.repeat(201)).success).toBe(false);
  });
});
