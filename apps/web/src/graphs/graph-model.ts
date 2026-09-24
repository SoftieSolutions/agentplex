import {
  graphDocumentSchema,
  graphNodeIdSchema,
  graphNodeSchema,
  type GraphDocument,
  type GraphNode,
  type GraphNodeId,
  type GraphNodeKind,
  type GraphPlacement,
  type GraphRoute,
  type NodeId,
  type ServerRegistrationId,
  type StoreId,
} from '@agentplex/protocol';

/**
 * Every edit the canvas and the inspector can make to a graph, as a function
 * of a document.
 *
 * Pure, and that is the point rather than tidiness. A graph document has
 * rules no single field can state -- every edge names two nodes that exist,
 * no two nodes share an id, a route's condition parses -- and the wire refuses
 * a document that breaks one. So every edit here returns either a document
 * that still parses or the sentence saying why it would not, and the store
 * beside this file never sends a document that this file did not say yes to.
 *
 * ## Parse, never cast
 *
 * `setNodeField` is the whole inspector in one function, and it works by
 * re-parsing the patched node through the protocol's own node schema rather
 * than by knowing which fields a kind has. A retry of eleven, a provider this
 * build has never heard of, a `model` on a TRIGGER: each is refused in the
 * schema's words, one round trip earlier than the hub would refuse it, and
 * this file has no second list of what a node is.
 */

export type GraphEdit =
  | { readonly ok: true; readonly document: GraphDocument }
  | { readonly ok: false; readonly problem: string };

/** The card's first line for each kind, as the mock letters them. */
export const KIND_WORDS: Record<GraphNodeKind, string> = {
  trigger: 'TRIGGER',
  router: 'ROUTER',
  agent: 'AGENT',
  subgraph: 'SUB-GRAPH',
  human: 'HUMAN',
  action: 'ACTION',
};

/** Every kind, in the order the palette offers them. */
export const KINDS: readonly GraphNodeKind[] = [
  'trigger',
  'router',
  'agent',
  'subgraph',
  'human',
  'action',
];

/**
 * The models a ROUTER may classify with. A short list rather than free text,
 * because a router's model is a hub-side call and not a session, and the
 * fixture the hub captured names the first of these.
 */
export const ROUTER_MODELS: readonly string[] = ['haiku', 'sonnet', 'opus'];

/**
 * What a blank node needs from outside the document.
 *
 * An AGENT starts a session in a store, and a SUB-GRAPH pins another graph:
 * neither is a value this file can invent, so both arrive from the screen,
 * which reads the fleet and the tree. `null` for either means the kind cannot
 * honestly be added yet, and `addNode` says so instead of writing an id
 * nothing will resolve.
 */
export interface NodeSeed {
  readonly storeId: StoreId | null;
  readonly graph: NodeId | null;
}

export interface Position {
  readonly x: number;
  readonly y: number;
}

function accepted(document: GraphDocument): GraphEdit {
  const parsed = graphDocumentSchema.safeParse(document);
  if (parsed.success) return { ok: true, document: parsed.data };
  return { ok: false, problem: firstIssue(parsed.error) };
}

function refusal(problem: string): GraphEdit {
  return { ok: false, problem };
}

function firstIssue(error: {
  issues: readonly { message: string; path: PropertyKey[] }[];
}): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'the document does not parse';
  const path = issue.path
    .map(String)
    .filter((segment) => segment !== '')
    .join('.');
  return path === '' ? issue.message : `${path}: ${issue.message}`;
}

function nodeAt(document: GraphDocument, id: GraphNodeId): GraphNode | null {
  return document.nodes.find((node) => node.id === id) ?? null;
}

function replaceNode(document: GraphDocument, next: GraphNode): GraphDocument {
  return {
    ...document,
    nodes: document.nodes.map((node) => (node.id === next.id ? next : node)),
  };
}

/** The first `<kind>-<n>` no node in the document carries. */
export function newNodeId(document: GraphDocument, kind: GraphNodeKind): GraphNodeId {
  const taken = new Set<string>(document.nodes.map((node) => node.id));
  let index = 1;
  while (taken.has(`${kind}-${String(index)}`)) index += 1;
  return graphNodeIdSchema.parse(`${kind}-${String(index)}`);
}

const BLANK_BASE = {
  placement: { kind: 'cheapest' } as GraphPlacement,
  retry: { max: 0, backoff: 1 },
} as const;

/**
 * A node of the kind with every field at its plainest value.
 *
 * The labels are what the card says until somebody names it; the HUMAN's one
 * approver is a placeholder the schema demands rather than a person this
 * build knows of, and the inspector is where it becomes one.
 */
function blankNode(
  kind: GraphNodeKind,
  id: GraphNodeId,
  position: Position,
  seed: NodeSeed,
): GraphNode | string {
  const base = { ...BLANK_BASE, id, position };
  switch (kind) {
    case 'trigger':
      return { ...base, kind, label: 'Trigger', source: 'manual' };
    case 'router':
      return {
        ...base,
        kind,
        label: 'Router',
        model: ROUTER_MODELS[0] ?? 'haiku',
        routes: [],
        otherwise: null,
      };
    case 'agent':
      if (seed.storeId === null) {
        return 'an AGENT starts a session in a store, and no connected server reports one';
      }
      return {
        ...base,
        kind,
        label: 'Agent',
        prompt: '',
        provider: 'claude',
        storeId: seed.storeId,
      };
    case 'subgraph':
      if (seed.graph === null) {
        return 'a SUB-GRAPH pins another graph, and this tree has no other graph to pin';
      }
      return { ...base, kind, label: 'Sub-graph', graph: seed.graph, version: 1 };
    case 'human':
      return { ...base, kind, label: 'Approval', approvers: ['approver'], timeoutMinutes: null };
    case 'action':
      return { ...base, kind, label: 'Action', name: 'action' };
  }
}

export function addNode(
  document: GraphDocument,
  kind: GraphNodeKind,
  position: Position,
  seed: NodeSeed,
): GraphEdit {
  const node = blankNode(kind, newNodeId(document, kind), position, seed);
  if (typeof node === 'string') return refusal(node);
  return accepted({ ...document, nodes: [...document.nodes, node] });
}

/**
 * Drops the node and everything that named it: its edges, the routes that
 * pointed at it, and an `otherwise` that did. Leaving any of those would be
 * a document the wire refuses, so the pointers go with the node.
 */
export function removeNode(document: GraphDocument, id: GraphNodeId): GraphEdit {
  if (nodeAt(document, id) === null) return refusal(`there is no node ${id} to remove`);
  const nodes = document.nodes
    .filter((node) => node.id !== id)
    .map((node) =>
      node.kind === 'router'
        ? {
            ...node,
            routes: node.routes.filter((route) => route.to !== id),
            otherwise: node.otherwise === id ? null : node.otherwise,
          }
        : node,
    );
  const edges = document.edges.filter((edge) => edge.from !== id && edge.to !== id);
  return accepted({ nodes, edges });
}

export function connect(document: GraphDocument, from: GraphNodeId, to: GraphNodeId): GraphEdit {
  if (from === to) return refusal('a node cannot connect to itself');
  for (const end of [from, to]) {
    if (nodeAt(document, end) === null) return refusal(`there is no node ${end} to connect`);
  }
  if (document.edges.some((edge) => edge.from === from && edge.to === to)) {
    return refusal(`${from} already connects to ${to}`);
  }
  return accepted({ ...document, edges: [...document.edges, { from, to }] });
}

/** The same document back when nothing moved, so a store can tell a no-op from an edit. */
export function moveNode(document: GraphDocument, id: GraphNodeId, position: Position): GraphEdit {
  const node = nodeAt(document, id);
  if (node === null) return refusal(`there is no node ${id} to move`);
  if (node.position.x === position.x && node.position.y === position.y) {
    return { ok: true, document };
  }
  return accepted(replaceNode(document, { ...node, position: { x: position.x, y: position.y } }));
}

/**
 * Sets one field of one node, through the node schema.
 *
 * The kind is the one field no edit may change: a node's kind decides which
 * other fields it has, so changing it would be a different node wearing the
 * same id, and the honest edit for that is remove and add.
 */
export function setNodeField(
  document: GraphDocument,
  id: GraphNodeId,
  field: string,
  value: unknown,
): GraphEdit {
  const node = nodeAt(document, id);
  if (node === null) return refusal(`there is no node ${id} to edit`);
  if (field === 'kind') return refusal('a node’s kind cannot change; remove it and add another');
  if (field === 'id') return refusal('a node’s id cannot change; the edges name it');
  if (!(field in node)) return refusal(`a ${KIND_WORDS[node.kind]} node has no field ${field}`);
  const parsed = graphNodeSchema.safeParse({ ...node, [field]: value });
  if (!parsed.success) return refusal(firstIssue(parsed.error));
  return accepted(replaceNode(document, parsed.data));
}

function routerAt(
  document: GraphDocument,
  id: GraphNodeId,
): Extract<GraphNode, { kind: 'router' }> | string {
  const node = nodeAt(document, id);
  if (node === null) return `there is no node ${id}`;
  if (node.kind !== 'router')
    return `${id} is a ${KIND_WORDS[node.kind]} node, and only a router has routes`;
  return node;
}

function withRoutes(
  document: GraphDocument,
  id: GraphNodeId,
  change: (routes: readonly GraphRoute[]) => readonly GraphRoute[] | string,
): GraphEdit {
  const router = routerAt(document, id);
  if (typeof router === 'string') return refusal(router);
  const routes = change(router.routes);
  if (typeof routes === 'string') return refusal(routes);
  const parsed = graphNodeSchema.safeParse({ ...router, routes });
  if (!parsed.success) return refusal(firstIssue(parsed.error));
  return accepted(replaceNode(document, parsed.data));
}

export function addRoute(
  document: GraphDocument,
  router: GraphNodeId,
  condition: string,
  to: GraphNodeId,
): GraphEdit {
  return withRoutes(document, router, (routes) => [...routes, { condition, to }]);
}

export function setRoute(
  document: GraphDocument,
  router: GraphNodeId,
  index: number,
  patch: Partial<GraphRoute>,
): GraphEdit {
  return withRoutes(document, router, (routes) => {
    const route = routes[index];
    if (route === undefined) return `there is no route ${String(index + 1)} on ${router}`;
    return routes.map((each, at) => (at === index ? { ...each, ...patch } : each));
  });
}

export function removeRoute(
  document: GraphDocument,
  router: GraphNodeId,
  index: number,
): GraphEdit {
  return withRoutes(document, router, (routes) => {
    if (routes[index] === undefined) return `there is no route ${String(index + 1)} on ${router}`;
    return routes.filter((_route, at) => at !== index);
  });
}

/** Moves the route at `from` so that it sits at `to`; the others keep their order. */
export function reorderRoute(
  document: GraphDocument,
  router: GraphNodeId,
  from: number,
  to: number,
): GraphEdit {
  return withRoutes(document, router, (routes) => {
    if (routes[from] === undefined || routes[to] === undefined) {
      return `there is no route ${String(Math.max(from, to) + 1)} on ${router}`;
    }
    const moved = [...routes];
    const [route] = moved.splice(from, 1);
    if (route === undefined) return `there is no route ${String(from + 1)} on ${router}`;
    moved.splice(to, 0, route);
    return moved;
  });
}

/** `0.86` reads `86%`: the control's label, rounded to the whole. */
export function zoomLabel(zoom: number): string {
  return `${String(Math.round(zoom * 100))}%`;
}

/** Where a node runs, in words: the machine's label, or that any will do. */
export function placementWords(
  placement: GraphPlacement,
  labels: ReadonlyMap<ServerRegistrationId, string>,
): string {
  if (placement.kind === 'cheapest') return 'any machine';
  return labels.get(placement.server) ?? placement.server;
}

/** The card's third line: the one fact per kind worth reading at a glance. */
export function nodeSubtitle(
  node: GraphNode,
  labels: ReadonlyMap<ServerRegistrationId, string>,
): string {
  switch (node.kind) {
    case 'trigger':
      return node.source;
    case 'router': {
      const count = node.routes.length;
      return `${node.model} · ${String(count)} ${count === 1 ? 'route' : 'routes'}`;
    }
    case 'agent':
      return `${node.provider} · ${placementWords(node.placement, labels)}`;
    case 'subgraph':
      return `v${String(node.version)}`;
    case 'human': {
      const wait = node.timeoutMinutes === null ? 'no timeout' : `${String(node.timeoutMinutes)}m`;
      return `${node.approvers.join(', ')} · ${wait}`;
    }
    case 'action':
      return node.name;
  }
}
