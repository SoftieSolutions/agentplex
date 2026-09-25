import {
  GRAPH_RUN_OUTPUT_MAX_CHARS,
  GRAPH_RUN_STEPS_MAX,
  assertNever,
  parseRouteCondition,
  evaluateRouteCondition,
  type GraphDocument,
  type GraphNode,
  type GraphNodeId,
  type GraphNodeKind,
  type GraphSimulatedStep,
  type NodeId,
  type RouteCondition,
  type RouteInput,
  type SimulatedOutcome,
} from '@agentplex/protocol';
import type { Timers } from '@agentplex/node-shared';
import type { StartPlacement } from '../sessions/sessions.js';
import { chainRefusal, type LineageEntry } from './subgraph-executor.js';
import {
  KIND_WORDS,
  nameOf,
  walk,
  type Executor,
  type WalkOutcome,
  type WalkTable,
} from './walker.js';

/**
 * Simulate: the walk a run of a graph would take, with nothing done.
 *
 * ## One traversal, a second table
 *
 * The walk is `walker.ts`'s, the same function a run goes through, so a
 * simulation follows edges, refuses a node with two, and stops a loop exactly
 * where a run would. What differs is the table: every node is answered by an
 * entry of `SIMULATED_STEPS`, which says what the node would do and does
 * none of it. A second traversal written for simulation would be a second
 * reading of the graph, free to disagree with the first about the one thing
 * a simulation is for.
 *
 * ## Every kind has an answer, by type
 *
 * `SimulatedTable` is keyed by every `GraphNodeKind`, ACTION and HUMAN
 * included, so a seventh kind added to the protocol is a type error here
 * rather than a simulation that falls back to executing it. The risk a
 * simulation carries is quietly doing something real, and the table is the
 * only place a node is answered: it is handed three reads -- where an AGENT
 * would be placed, a published version's document, a graph's name -- and
 * nothing that starts a session, sets a timer, writes a row, asks a person
 * or sends a notification. There is no way to reach any of those from here.
 *
 * ## What each kind says
 *
 * A TRIGGER would start the run with the input. A ROUTER evaluates its
 * conditions against the input and names the route that held and why, or
 * the fallback, or that it would stop. An AGENT names the provider and the
 * machine placement would choose, through the placement a run uses, or that
 * no machine could take it. A HUMAN says how long it would wait and for
 * whom. A SUB-GRAPH names the graph and version it pins and walks that
 * published document one depth down, with the chain limits a run has. An
 * ACTION names itself and stops, since no build performs one.
 *
 * Nothing an AGENT would produce can be known without running it, so every
 * step hands on the input it was given: a ROUTER after an AGENT reads the
 * run's input. A node's retry policy is said on its step, and a HUMAN's is
 * not, because a person's answer is never asked again.
 *
 * ## Where it would stop
 *
 * A step that would stop a run is reported `would-stop` and ends the walk at
 * its depth, as the run would end there: the path is what a run would do,
 * not the whole graph. The node is not tried again -- a simulation has no
 * reason to believe a second try says otherwise, and no timer to wait on --
 * so every stop is final to the walk, and the walk is given timers that
 * refuse to be used.
 */

type NodeOf<K extends GraphNodeKind> = Extract<GraphNode, { kind: K }>;

/** What a simulation may read. Nothing here starts, schedules or writes anything. */
export interface SimulationDependencies {
  /** Where an AGENT's session would start, or why nowhere would take it. */
  readonly place: (node: NodeOf<'agent'>) => StartPlacement;
  /** A published version's document, or `null` when the pin resolves to nothing. */
  readonly publishedVersion: (graph: NodeId, version: number) => Promise<GraphDocument | null>;
  /** What a graph is called, for the sentences a person reads. */
  readonly nameOf: (graph: NodeId) => Promise<string>;
}

/**
 * What a simulated node answers. `next` is the node the walk goes to, or
 * `null` to follow the one outgoing edge; only a ROUTER names one. A stop
 * has no next: it is the last step at its depth.
 */
export type SimulatedAnswer =
  | {
      readonly outcome: Exclude<SimulatedOutcome, 'would-stop'>;
      readonly why: string;
      readonly next: GraphNodeId | null;
    }
  | { readonly outcome: 'would-stop'; readonly why: string };

export interface SimulateContext {
  /** The document the node is in: its own graph's, or a child's one depth down. */
  readonly document: GraphDocument;
  /** Every graph above and including this one, root first. */
  readonly lineage: readonly LineageEntry[];
  readonly dependencies: SimulationDependencies;
  /** Walks a child graph one depth down; its steps land in the path after this one. */
  walkChild(child: LineageEntry, document: GraphDocument): Promise<SimulatedEnd>;
}

export type SimulatedStep<K extends GraphNodeKind> = (
  node: NodeOf<K>,
  input: RouteInput,
  context: SimulateContext,
) => Promise<SimulatedAnswer>;

/** One answer per kind, every kind. A kind without an entry is a type error. */
export type SimulatedTable = { readonly [K in GraphNodeKind]: SimulatedStep<K> };

/** How a walk at one depth ended: at a node with nowhere to go, or with the sentence it stopped on. */
export type SimulatedEnd =
  { readonly stopped: false } | { readonly stopped: true; readonly reason: string };

export interface Simulation {
  readonly path: readonly GraphSimulatedStep[];
  /** The sentence the walk stopped on, or `null` when it reached the end. */
  readonly reason: string | null;
}

export interface SimulateOptions {
  /** The most steps one answer carries. A run's step bound unless a test says less. */
  readonly limit?: number;
}

/** A sentence cut at the bound a step's free text has, marked where it was cut. */
function bounded(text: string): string {
  return text.length <= GRAPH_RUN_OUTPUT_MAX_CHARS
    ? text
    : `${text.slice(0, GRAPH_RUN_OUTPUT_MAX_CHARS - 1)}…`;
}

/** Why a condition that held, held: said of the input, never of the parser. */
function whyHeld(condition: RouteCondition): string {
  switch (condition.kind) {
    case 'equals':
      return `${condition.field} is ${JSON.stringify(condition.literal)}`;
    case 'not-equals':
      return `${condition.field} is not ${JSON.stringify(condition.literal)}`;
    case 'only':
      return `every entry of files fits ${condition.glob}`;
    default:
      return assertNever(condition, 'route condition');
  }
}

/** What a node in this document is called, or its id when it is not here. */
function called(document: GraphDocument, id: GraphNodeId): string {
  const node = document.nodes.find((candidate) => candidate.id === id);
  return node === undefined ? id : nameOf(node);
}

const trigger: SimulatedStep<'trigger'> = async (_node, input) => ({
  outcome: 'would-run',
  why: `would start the run with ${JSON.stringify(input)}`,
  next: null,
});

const router: SimulatedStep<'router'> = async (node, input, { document }) => {
  for (const [index, route] of node.routes.entries()) {
    const parsed = parseRouteCondition(route.condition);
    if (!parsed.ok) {
      return {
        outcome: 'would-stop',
        why: `the condition ${JSON.stringify(route.condition)} does not parse: ${parsed.problem}`,
      };
    }
    if (evaluateRouteCondition(parsed.condition, input)) {
      return {
        outcome: 'would-run',
        why: `route ${String(index + 1)}, ${route.condition}, would send it to ${called(document, route.to)}: ${whyHeld(parsed.condition)}`,
        next: route.to,
      };
    }
  }
  if (node.otherwise !== null) {
    return {
      outcome: 'would-run',
      why: `no route holds, so otherwise would send it to ${called(document, node.otherwise)}`,
      next: node.otherwise,
    };
  }
  return {
    outcome: 'would-stop',
    why: 'no route holds for this input and there is no otherwise',
  };
};

const agent: SimulatedStep<'agent'> = async (node, _input, { dependencies }) => {
  const placed = dependencies.place(node);
  if (!placed.ok) {
    return { outcome: 'would-stop', why: `no machine could take this node: ${placed.problem}` };
  }
  return { outcome: 'would-run', why: `would run ${node.provider} on ${placed.label}`, next: null };
};

const human: SimulatedStep<'human'> = async (node) => {
  const whom = node.approvers.join(', ');
  return {
    outcome: 'would-wait',
    why:
      node.timeoutMinutes === null
        ? `would wait on a person for as long as it takes, for ${whom}`
        : `would wait on a person up to ${String(node.timeoutMinutes)} minutes for ${whom}`,
    next: null,
  };
};

const subgraph: SimulatedStep<'subgraph'> = async (node, _input, context) => {
  const refusal = chainRefusal(context.lineage, node.graph);
  if (refusal !== null) return { outcome: 'would-stop', why: refusal };

  const document = await context.dependencies.publishedVersion(node.graph, node.version);
  if (document === null) {
    return {
      outcome: 'would-stop',
      why: `it pins ${node.graph} at v${String(node.version)}, which is not a published version of any graph this hub has`,
    };
  }
  const name = await context.dependencies.nameOf(node.graph);
  const pinned = `would run ${name} v${String(node.version)}`;
  const ended = await context.walkChild({ graph: node.graph, name }, document);
  if (ended.stopped)
    return { outcome: 'would-stop', why: `${pinned}, and it would stop: ${ended.reason}` };
  return { outcome: 'would-run', why: pinned, next: null };
};

const action: SimulatedStep<'action'> = async (node) => ({
  outcome: 'would-stop',
  why: `would perform ${node.name}, and no action of that name exists on this build`,
});

/** The table every simulation answers with. */
export const SIMULATED_STEPS: SimulatedTable = {
  trigger,
  router,
  agent,
  subgraph,
  human,
  action,
};

/**
 * Timers a simulation's walk is handed and never uses: every stop is final,
 * so no backoff is ever scheduled. One that was would be a simulation
 * waiting, which is a bug to hear about rather than a timer to set.
 */
const NO_TIMERS: Timers = {
  schedule() {
    throw new Error('a simulation never waits');
  },
};

/** The retry policy, said on a step, or nothing for a node that is never tried again. */
function retryWords(node: GraphNode): string {
  if (node.kind === 'human' || node.retry.max === 0) return '';
  return `; a failure would be tried again up to ${String(node.retry.max)} more time${node.retry.max === 1 ? '' : 's'}, ${String(node.retry.backoff)} s apart`;
}

export async function simulate(
  root: LineageEntry,
  document: GraphDocument,
  input: RouteInput,
  dependencies: SimulationDependencies,
  options: SimulateOptions = {},
  table: SimulatedTable = SIMULATED_STEPS,
): Promise<Simulation> {
  const limit = options.limit ?? GRAPH_RUN_STEPS_MAX;
  const path: GraphSimulatedStep[] = [];
  /** Set when the path reached its bound; the answer then says that and nothing else. */
  let truncated = false;
  const cap = `the simulation stopped after ${String(limit)} steps, the most one answer carries`;

  async function walkAt(
    doc: GraphDocument,
    lineage: readonly LineageEntry[],
  ): Promise<SimulatedEnd> {
    const depth = lineage.length - 1;
    /** The node whose answer stopped this depth's walk, and why; set from inside an executor. */
    const halted: { at: { readonly node: GraphNode; readonly why: string } | null } = { at: null };

    const context: SimulateContext = {
      document: doc,
      lineage,
      dependencies,
      walkChild: (child, childDocument) => walkAt(childDocument, [...lineage, child]),
    };

    /**
     * One kind's entry as a walker executor: a slot in the path taken before
     * the answer, so a SUB-GRAPH's own step comes before its child's, and
     * every stop final so the walk never schedules a retry.
     */
    function adapt<K extends GraphNodeKind>(step: SimulatedStep<K>): Executor<K> {
      return async (node, carried) => {
        if (path.length >= limit) {
          truncated = true;
          return { ok: false, problem: cap, retryable: false };
        }
        const slot = path.length;
        path.push({ nodeId: node.id, kind: node.kind, depth, outcome: 'would-run', why: '…' });
        let answer: SimulatedAnswer;
        try {
          answer = await step(node, carried, context);
        } catch (error) {
          answer = {
            outcome: 'would-stop',
            why: `the simulation could not answer: ${String(error)}`,
          };
        }
        const why = bounded(`${answer.why}${retryWords(node)}`);
        path[slot] = { nodeId: node.id, kind: node.kind, depth, outcome: answer.outcome, why };
        if (answer.outcome === 'would-stop') {
          halted.at = { node, why: answer.why };
          return { ok: false, problem: answer.why, retryable: false };
        }
        return { ok: true, carried, output: null, next: answer.next };
      };
    }

    const executors: WalkTable = {
      trigger: adapt(table.trigger),
      router: adapt(table.router),
      agent: adapt(table.agent),
      human: adapt(table.human),
      subgraph: adapt(table.subgraph),
      action: adapt(table.action),
    };

    const outcome: WalkOutcome = await walk(doc, input, {
      executors,
      timers: NO_TIMERS,
      onStep: () => {},
      onEnd: () => {},
    }).done;

    switch (outcome.status) {
      case 'succeeded':
        return { stopped: false };
      case 'failed': {
        if (truncated) return { stopped: true, reason: cap };
        const stop = halted.at;
        if (stop === null) return { stopped: true, reason: outcome.reason };
        return {
          stopped: true,
          reason: `a run would stop at the ${KIND_WORDS[stop.node.kind]} node ${nameOf(stop.node)}: ${stop.why}`,
        };
      }
      case 'cancelled':
        // Nothing cancels a simulation's walk; said rather than thrown.
        return { stopped: true, reason: 'the simulation was cancelled' };
      default:
        return assertNever(outcome, 'how a simulated walk ended');
    }
  }

  const ended = await walkAt(document, [root]);
  return { path, reason: ended.stopped ? bounded(ended.reason) : null };
}
