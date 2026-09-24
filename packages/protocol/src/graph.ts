import { z } from 'zod';
import {
  nodeIdSchema,
  providerSchema,
  serverRegistrationIdSchema,
  storeIdSchema,
} from './identity.js';
import { NODE_NAME_MAX_CHARS } from './layout.js';
import { routeConditionTextSchema } from './route-condition.js';

/**
 * A graph: the document a person draws, and what a version of it is.
 *
 * A graph is a node in the user's tree, like a document is, with a side row
 * the hub owns. Unlike a document its content lives in the hub's database and
 * nowhere else: there is no file on a machine for it to be the index of, and
 * the runtime that walks it (AGX-146) runs in the hub. So the hub holds the
 * document whole, parses it on every read, and this file is the one place its
 * shape is stated.
 *
 * ## Six kinds, closed
 *
 * `graphNodeKindSchema` is a `z.enum` and not an open string, which is the
 * opposite choice from the tree's `nodeKindSchema`, made for the opposite
 * reason. A tree kind is a row in a lookup table so that adding one costs an
 * INSERT; a graph node kind is a branch of the runtime, and a kind the walker
 * has no executor for is a run that cannot proceed. Closing the enum lets the
 * executor table be `Record<GraphNodeKind, Executor>`, so that adding a
 * seventh kind here without teaching the runtime about it is a type error
 * rather than a run that stops on a node nothing can execute.
 *
 * ## Draft and published
 *
 * Every graph has exactly one draft, which is the document the canvas edits,
 * and any number of published versions, which are immutable. Publishing
 * stamps the draft as version `n` and opens draft `n+1` as a copy of it. A run
 * and a SUB-GRAPH pin both name a published version, never the draft, so what
 * ran is always something that can be read back exactly. The hub owns those
 * rules; this file states the document they apply to.
 */

export const graphNodeKindSchema = z.enum([
  'trigger',
  'router',
  'agent',
  'subgraph',
  'human',
  'action',
]);
export type GraphNodeKind = z.infer<typeof graphNodeKindSchema>;

/**
 * A node's id within its document: the canvas mints it, the edges name it.
 *
 * Not a `NodeId`: a graph node is not a node in the user's tree and has no
 * row of its own, so giving it the tree's id type would let an edge be
 * written that points at a project. Short and plain so it can sit in a route
 * without quoting.
 */
export const graphNodeIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'a graph node id is letters, digits, hyphens and underscores')
  .brand<'GraphNodeId'>();
export type GraphNodeId = z.infer<typeof graphNodeIdSchema>;

/** What a graph is called in the tree. The same bound every node name has. */
export const graphNameSchema = z
  .string()
  .max(NODE_NAME_MAX_CHARS)
  .refine((name) => name.trim().length > 0, 'a graph needs a name');

/** A node's label on the canvas: what a person reads on the card. */
export const GRAPH_LABEL_MAX_CHARS = 120;

/**
 * How many nodes one document may hold, and how long an AGENT prompt may be.
 *
 * Both bounds are for the frame a document travels in, which the message
 * socket refuses past a megabyte: sixty-four nodes each carrying a prompt at
 * this cap is the same quarter-million characters `DOC_CONTENT_MAX_CHARS`
 * argues fits. A graph with more nodes than this is one nobody can read on a
 * canvas, and a prompt longer than this is a document, which is what the
 * project's documents are for.
 */
export const GRAPH_NODES_MAX = 64;
export const GRAPH_PROMPT_MAX_CHARS = 4_000;

/** How many routes one router may have, and how many approvers one human node names. */
export const GRAPH_ROUTES_MAX = 16;
export const GRAPH_APPROVERS_MAX = 16;

/**
 * Where a node's work runs.
 *
 * `cheapest` lets the hub choose among the machines that can run it; `pin`
 * names one. The choice is on every node rather than on the graph because the
 * reason to pin is per node -- one reviewer wants the box with the GPU -- and
 * a graph-wide setting would pin every other node with it.
 */
export const graphPlacementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cheapest') }),
  z.object({ kind: z.literal('pin'), server: serverRegistrationIdSchema }),
]);
export type GraphPlacement = z.infer<typeof graphPlacementSchema>;

/**
 * The longest a step waits before a retry: an hour.
 *
 * Bounded above as well as below because a delay is handed to a timer, and
 * Node fires a timer past 2^31 - 1 milliseconds after one millisecond
 * instead -- so an unbounded backoff is the tight loop the minimum exists to
 * prevent, reached from the other side. An hour is long enough that a step
 * waiting on it is waiting on a person, and a person is a HUMAN node.
 */
export const GRAPH_RETRY_BACKOFF_MAX_SECONDS = 3600;

/**
 * How many more times a failed step is tried, and how long to wait first.
 *
 * `max` is bounded because a step that fails ten times in a row is failing for
 * a reason, and `backoff` is in seconds and at least one because a retry with
 * no wait is a tight loop against whatever just refused.
 */
export const GRAPH_RETRY_MAX = 10;
export const graphRetrySchema = z.object({
  max: z.int().min(0).max(GRAPH_RETRY_MAX),
  backoff: z.int().min(1).max(GRAPH_RETRY_BACKOFF_MAX_SECONDS),
});
export type GraphRetry = z.infer<typeof graphRetrySchema>;

const positionSchema = z.object({ x: z.number(), y: z.number() });

/** What every node carries, whatever its kind. */
const baseNode = {
  id: graphNodeIdSchema,
  label: z.string().max(GRAPH_LABEL_MAX_CHARS),
  position: positionSchema,
  placement: graphPlacementSchema,
  retry: graphRetrySchema,
};

/** One route out of a router: a condition, and the node a match goes to. */
export const graphRouteSchema = z.object({
  condition: routeConditionTextSchema,
  to: graphNodeIdSchema,
});
export type GraphRoute = z.infer<typeof graphRouteSchema>;

export const graphNodeSchema = z.discriminatedUnion('kind', [
  /** Where a run starts. Only a manual start exists yet; the field is on the wire so a second source is a value and not a schema change. */
  z.object({ ...baseNode, kind: z.literal('trigger'), source: z.literal('manual') }),
  /**
   * Decides which node runs next by the first route whose condition holds,
   * or `otherwise` when none does. `otherwise` is `null` rather than absent so
   * that a router with no fallback is a stated choice and not a forgotten
   * field.
   */
  z.object({
    ...baseNode,
    kind: z.literal('router'),
    model: z.string().min(1).max(64),
    routes: z.array(graphRouteSchema).max(GRAPH_ROUTES_MAX),
    otherwise: graphNodeIdSchema.nullable(),
  }),
  /**
   * Starts a session and waits for it to finish.
   *
   * `storeId` is the store the session starts in, and it is on the node
   * because placement needs it: `cheapest` picks among the machines that have
   * that store mounted, and a graph-wide store would make every agent in a
   * graph run in one place.
   */
  z.object({
    ...baseNode,
    kind: z.literal('agent'),
    prompt: z.string().max(GRAPH_PROMPT_MAX_CHARS),
    provider: providerSchema,
    storeId: storeIdSchema,
  }),
  /** Runs another graph at a pinned published version. `graph` is that graph's tree node. */
  z.object({
    ...baseNode,
    kind: z.literal('subgraph'),
    graph: nodeIdSchema,
    version: z.int().positive(),
  }),
  /** Waits for a person. `timeoutMinutes` is `null` for a node that waits as long as it takes. */
  z.object({
    ...baseNode,
    kind: z.literal('human'),
    approvers: z.array(z.string().min(1).max(64)).min(1).max(GRAPH_APPROVERS_MAX),
    timeoutMinutes: z.int().positive().nullable(),
  }),
  /** Names an action this build would perform. No build performs one yet, so publishing a graph with one is refused. */
  z.object({ ...baseNode, kind: z.literal('action'), name: z.string().min(1).max(64) }),
]);
export type GraphNode = z.infer<typeof graphNodeSchema>;

export const graphEdgeSchema = z.object({ from: graphNodeIdSchema, to: graphNodeIdSchema });
export type GraphEdge = z.infer<typeof graphEdgeSchema>;

/**
 * The whole document, with the rules no field can state on its own.
 *
 * Every id an edge, a route or an `otherwise` names must be a node in this
 * document, and no two nodes share an id. Both are checked here rather than
 * left to the runtime, because a document that fails them is not a graph
 * anybody drew: the canvas cannot draw an edge to nothing, so one in a frame
 * is a client that has gone wrong, and the honest answer is a refusal at the
 * wire rather than a run that stops on a missing node.
 */
export const graphDocumentSchema = z
  .object({
    nodes: z.array(graphNodeSchema).max(GRAPH_NODES_MAX),
    edges: z.array(graphEdgeSchema).max(GRAPH_NODES_MAX * 4),
  })
  .superRefine((document, context) => {
    const ids = new Set<string>();
    for (const node of document.nodes) {
      if (ids.has(node.id)) {
        context.addIssue({ code: 'custom', message: `two nodes share the id ${node.id}` });
      }
      ids.add(node.id);
    }
    const mustExist = (id: string, what: string): void => {
      if (!ids.has(id)) {
        context.addIssue({ code: 'custom', message: `${what} names ${id}, which is no node here` });
      }
    };
    for (const edge of document.edges) {
      mustExist(edge.from, 'an edge');
      mustExist(edge.to, 'an edge');
    }
    for (const node of document.nodes) {
      if (node.kind !== 'router') continue;
      for (const route of node.routes) mustExist(route.to, `a route on ${node.id}`);
      if (node.otherwise !== null) mustExist(node.otherwise, `the otherwise on ${node.id}`);
    }
  });
export type GraphDocument = z.infer<typeof graphDocumentSchema>;

/** What a fresh draft holds: nothing yet. */
export function emptyGraphDocument(): GraphDocument {
  return { nodes: [], edges: [] };
}

/** One published version, as a listing names it. */
export const graphPublishedVersionSchema = z.object({
  version: z.int().positive(),
  publishedAt: z.int().nonnegative(),
});
export type GraphPublishedVersion = z.infer<typeof graphPublishedVersionSchema>;
