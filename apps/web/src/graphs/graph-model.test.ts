import { describe, expect, it } from 'vitest';
import {
  graphDocumentSchema,
  graphNodeIdSchema,
  nodeIdSchema,
  parseHubFrame,
  parseTextFrame,
  serverRegistrationIdSchema,
  storeIdSchema,
  type GraphDocument,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import {
  addNode,
  addRoute,
  connect,
  KIND_WORDS,
  moveNode,
  newNodeId,
  nodeSubtitle,
  removeNode,
  removeRoute,
  reorderRoute,
  setNodeField,
  setRoute,
  zoomLabel,
  type GraphEdit,
} from './graph-model.js';

/**
 * Every edit the canvas and the inspector can make, as a function of a
 * document. The document under test is the one a real hub answered an open
 * with, read through the client's own parser, so the shape every edit starts
 * from is a shape the hub actually sends.
 */

function fixtureDocument(): GraphDocument {
  const parsed = parseTextFrame(parseHubFrame, hubFrames.graphDocument);
  if (!parsed.ok || parsed.value.type !== 'graph-document') {
    throw new Error('the captured frame is not a graph document');
  }
  return parsed.value.document;
}

const id = (text: string) => graphNodeIdSchema.parse(text);
const STORE = storeIdSchema.parse('store-agentplex');
const SEED = { storeId: STORE, graph: nodeIdSchema.parse('hub-11') } as const;

function accepted(edit: GraphEdit): GraphDocument {
  if (!edit.ok) throw new Error(`the edit was refused: ${edit.problem}`);
  // Every accepted edit is a document the wire would take.
  expect(graphDocumentSchema.safeParse(edit.document).success).toBe(true);
  return edit.document;
}

function refused(edit: GraphEdit): string {
  if (edit.ok) throw new Error('the edit was accepted');
  return edit.problem;
}

describe('newNodeId', () => {
  it('mints the first id of the kind that no node has yet', () => {
    const document = fixtureDocument();
    expect(newNodeId(document, 'agent')).toBe('agent-1');
    expect(newNodeId(document, 'trigger')).toBe('trigger-1');
  });

  it('skips ids already taken', () => {
    const first = accepted(addNode(fixtureDocument(), 'agent', { x: 1, y: 1 }, SEED));
    expect(newNodeId(first, 'agent')).toBe('agent-2');
  });
});

describe('addNode', () => {
  it('adds a node of every kind that parses, at the position asked for', () => {
    let document = fixtureDocument();
    for (const kind of ['trigger', 'router', 'agent', 'subgraph', 'human', 'action'] as const) {
      document = accepted(addNode(document, kind, { x: 10, y: 20 }, SEED));
      const added = document.nodes.at(-1);
      expect(added?.kind).toBe(kind);
      expect(added?.position).toEqual({ x: 10, y: 20 });
    }
    expect(document.nodes).toHaveLength(9);
  });

  it('refuses an AGENT when no store is known to start it in', () => {
    expect(
      refused(addNode(fixtureDocument(), 'agent', { x: 0, y: 0 }, { ...SEED, storeId: null })),
    ).toMatch(/store/);
  });

  it('refuses a SUB-GRAPH when there is no other graph to pin', () => {
    expect(
      refused(addNode(fixtureDocument(), 'subgraph', { x: 0, y: 0 }, { ...SEED, graph: null })),
    ).toMatch(/graph/);
  });

  it('refuses the sixty-fifth node in the schema’s own words', () => {
    let document: GraphDocument = { nodes: [], edges: [] };
    for (let index = 0; index < 64; index += 1) {
      document = accepted(addNode(document, 'action', { x: index, y: 0 }, SEED));
    }
    expect(refused(addNode(document, 'action', { x: 0, y: 0 }, SEED))).toMatch(/64/);
  });

  it('leaves the document it was given alone', () => {
    const before = fixtureDocument();
    accepted(addNode(before, 'action', { x: 0, y: 0 }, SEED));
    expect(before).toEqual(fixtureDocument());
  });
});

describe('removeNode', () => {
  it('drops the node, every edge touching it, and every route pointing at it', () => {
    const document = accepted(removeNode(fixtureDocument(), id('review')));
    expect(document.nodes.map((node) => node.id)).toEqual(['start', 'classify']);
    expect(document.edges).toEqual([{ from: 'start', to: 'classify' }]);
    const router = document.nodes[1];
    expect(router?.kind === 'router' ? router.routes : null).toEqual([]);
  });

  it('clears an otherwise that pointed at it', () => {
    const withOtherwise = accepted(
      setNodeField(fixtureDocument(), id('classify'), 'otherwise', 'review'),
    );
    const document = accepted(removeNode(withOtherwise, id('review')));
    const router = document.nodes.find((node) => node.id === 'classify');
    expect(router?.kind === 'router' ? router.otherwise : 'wrong kind').toBeNull();
  });

  it('refuses a node that is not there', () => {
    expect(refused(removeNode(fixtureDocument(), id('nowhere')))).toContain('nowhere');
  });
});

describe('connect', () => {
  it('adds an edge between two nodes', () => {
    const document = accepted(connect(fixtureDocument(), id('start'), id('review')));
    expect(document.edges).toContainEqual({ from: 'start', to: 'review' });
  });

  it('refuses a node connecting to itself, a duplicate edge, and a missing end', () => {
    expect(refused(connect(fixtureDocument(), id('start'), id('start')))).toMatch(/itself/);
    expect(refused(connect(fixtureDocument(), id('start'), id('classify')))).toMatch(/already/);
    expect(refused(connect(fixtureDocument(), id('start'), id('nowhere')))).toContain('nowhere');
  });
});

describe('moveNode', () => {
  it('replaces the position and nothing else', () => {
    const document = accepted(moveNode(fixtureDocument(), id('start'), { x: 40, y: 92 }));
    const moved = document.nodes.find((node) => node.id === 'start');
    expect(moved?.position).toEqual({ x: 40, y: 92 });
    expect({ ...moved, position: null }).toEqual({
      ...fixtureDocument().nodes.find((node) => node.id === 'start'),
      position: null,
    });
  });

  it('returns the same document when nothing moved', () => {
    const before = fixtureDocument();
    const edit = moveNode(before, id('start'), { x: 0, y: 0 });
    expect(edit.ok && edit.document).toBe(before);
  });
});

describe('setNodeField', () => {
  it('sets a field the kind has, through the node schema', () => {
    const document = accepted(setNodeField(fixtureDocument(), id('classify'), 'model', 'sonnet'));
    const router = document.nodes.find((node) => node.id === 'classify');
    expect(router?.kind === 'router' ? router.model : null).toBe('sonnet');
  });

  it('sets the fields every kind shares', () => {
    const pinned = accepted(
      setNodeField(fixtureDocument(), id('start'), 'placement', {
        kind: 'pin',
        server: serverRegistrationIdSchema.parse('registration-mbp-robert'),
      }),
    );
    expect(pinned.nodes[0]?.placement).toEqual({ kind: 'pin', server: 'registration-mbp-robert' });
    const retried = accepted(setNodeField(pinned, id('start'), 'retry', { max: 3, backoff: 2 }));
    expect(retried.nodes[0]?.retry).toEqual({ max: 3, backoff: 2 });
    const named = accepted(setNodeField(retried, id('start'), 'label', 'PR merged'));
    expect(named.nodes[0]?.label).toBe('PR merged');
  });

  it('refuses a value the schema refuses, in the schema’s words', () => {
    expect(
      refused(setNodeField(fixtureDocument(), id('start'), 'retry', { max: 11, backoff: 1 })),
    ).toMatch(/10/);
    expect(refused(setNodeField(fixtureDocument(), id('review'), 'provider', 'gpt'))).toBeTruthy();
  });

  it('refuses a field the kind does not have, and never changes the kind', () => {
    expect(refused(setNodeField(fixtureDocument(), id('start'), 'model', 'haiku'))).toMatch(
      /model/,
    );
    expect(refused(setNodeField(fixtureDocument(), id('start'), 'kind', 'router'))).toMatch(/kind/);
  });

  it('refuses an otherwise that names no node', () => {
    expect(
      refused(setNodeField(fixtureDocument(), id('classify'), 'otherwise', 'nowhere')),
    ).toContain('nowhere');
  });
});

describe('routes', () => {
  it('adds a route to the end of a router’s list', () => {
    const document = accepted(
      addRoute(fixtureDocument(), id('classify'), 'language == ts', id('start')),
    );
    const router = document.nodes.find((node) => node.id === 'classify');
    expect(router?.kind === 'router' ? router.routes : null).toEqual([
      { condition: 'language == rust', to: 'review' },
      { condition: 'language == ts', to: 'start' },
    ]);
  });

  it('refuses a condition the grammar refuses, with its position', () => {
    expect(
      refused(addRoute(fixtureDocument(), id('classify'), 'language is rust', id('start'))),
    ).toBeTruthy();
  });

  it('refuses a route on a node that is not a router', () => {
    expect(
      refused(addRoute(fixtureDocument(), id('start'), 'language == ts', id('review'))),
    ).toMatch(/router/i);
  });

  it('reorders by moving one route to another index', () => {
    const three = accepted(
      addRoute(
        accepted(addRoute(fixtureDocument(), id('classify'), 'language == ts', id('start'))),
        id('classify'),
        'only *.md',
        id('review'),
      ),
    );
    const document = accepted(reorderRoute(three, id('classify'), 2, 0));
    const router = document.nodes.find((node) => node.id === 'classify');
    expect(
      router?.kind === 'router' ? router.routes.map((route) => route.condition) : null,
    ).toEqual(['only *.md', 'language == rust', 'language == ts']);
  });

  it('refuses a reorder off the end of the list', () => {
    expect(refused(reorderRoute(fixtureDocument(), id('classify'), 0, 5))).toMatch(/route/);
  });

  it('removes a route by index and edits one in place', () => {
    const edited = accepted(
      setRoute(fixtureDocument(), id('classify'), 0, { condition: 'language != rust' }),
    );
    let router = edited.nodes.find((node) => node.id === 'classify');
    expect(router?.kind === 'router' ? router.routes[0]?.condition : null).toBe('language != rust');
    const removed = accepted(removeRoute(edited, id('classify'), 0));
    router = removed.nodes.find((node) => node.id === 'classify');
    expect(router?.kind === 'router' ? router.routes : null).toEqual([]);
  });
});

describe('words', () => {
  it('formats a zoom as a whole percentage', () => {
    expect(zoomLabel(0.86)).toBe('86%');
    expect(zoomLabel(1)).toBe('100%');
    expect(zoomLabel(1.2549)).toBe('125%');
  });

  it('names every kind the way the mock’s cards do', () => {
    expect(KIND_WORDS).toEqual({
      trigger: 'TRIGGER',
      router: 'ROUTER',
      agent: 'AGENT',
      subgraph: 'SUB-GRAPH',
      human: 'HUMAN',
      action: 'ACTION',
    });
  });

  it('gives each card its third line', () => {
    const labels = new Map([
      [serverRegistrationIdSchema.parse('registration-mbp-robert'), 'mbp-robert'],
    ]);
    const [trigger, router, agent] = fixtureDocument().nodes;
    if (!trigger || !router || !agent) throw new Error('the fixture lost a node');
    expect(nodeSubtitle(trigger, labels)).toBe('manual');
    expect(nodeSubtitle(router, labels)).toBe('haiku · 1 route');
    expect(nodeSubtitle(agent, labels)).toBe('claude · mbp-robert');
    expect(nodeSubtitle({ ...agent, placement: { kind: 'cheapest' } }, labels)).toBe(
      'claude · any machine',
    );
  });
});
