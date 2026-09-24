import {
  assertNever,
  evaluateRouteCondition,
  GRAPH_NODES_MAX,
  parseRouteCondition,
  type GraphDocument,
  type GraphNode,
  type GraphNodeId,
  type GraphNodeKind,
  type GraphRunStep,
  type RouteInput,
} from '@agentplex/protocol';
import type { Timers } from '@agentplex/node-shared';

/**
 * The walk: one node after another, from the TRIGGER to a node with nowhere
 * to go, with each node's work handed to an executor for its kind.
 *
 * ## Pure, and everything injected
 *
 * Nothing here reaches a database, a machine or a clock. The executors are a
 * table this is given, the backoff waits through injected timers, and every
 * step is reported through a callback. That is what makes the traversal, the
 * retry and the cancel a unit test each: the AGENT executor that actually
 * starts a session is `agent-executor.ts`, tested against its own seams, and
 * the walk is tested with one that answers what it is told.
 *
 * ## The table is typed by kind, minus the kinds nothing runs yet
 *
 * `ExecutorTable` is `Record` over every kind but `action`, `human` and
 * `subgraph`. Publish already refuses an ACTION node; HUMAN and SUB-GRAPH are
 * the next two tickets, and each adds its key to `ExecutableKind` when it
 * adds its executor. Until then a run that reaches one fails with a sentence
 * naming the node, from a switch that ends in `assertNever` -- so a seventh
 * kind added to the protocol is a type error here and not a silent fall
 * through.
 *
 * ## A step is one attempt
 *
 * Every attempt at a node is reported twice: once as `running` when it begins
 * and once with what it became. The same `nodeId` and `attempt` on both, so
 * that whoever keeps the list replaces the first record with the second
 * rather than holding a step that is forever running beside the one that
 * ended. Retries are further attempts of the same node, one wait apart.
 *
 * ## Cancel stops before the next step
 *
 * A cancel does not interrupt the step in flight. An agent mid-turn is the
 * case a stop refuses to touch, for the reason `routeStop` gives -- an edit
 * half applied -- and the same reason holds here. What a cancel does is tell
 * the executor (which may stop early if it can), cancel any backoff wait, and
 * end the run `cancelled` the moment the step in flight has ended, before the
 * next node is reached.
 */

/**
 * What one attempt at a node produced.
 *
 * `next` is the node the run goes to, or `null` to follow the node's one
 * outgoing edge. Only a ROUTER ever names one: its routes are the choice, and
 * the walk following an edge on its behalf would be a second reading of the
 * same decision.
 */
export type StepResult =
  | { readonly ok: true; readonly output: RouteInput; readonly next: GraphNodeId | null }
  | { readonly ok: false; readonly problem: string };

/** How a step learns that the run was cancelled under it. */
export interface Cancellation {
  readonly cancelled: boolean;
  /** Calls `listener` once, on cancel, or immediately if already cancelled. Returns the detach. */
  onCancel(listener: () => void): () => void;
}

export interface StepContext {
  readonly document: GraphDocument;
  /** Counts from 0: the first try of a node is attempt 0. */
  readonly attempt: number;
  readonly cancellation: Cancellation;
}

export type Executor<K extends GraphNodeKind> = (
  node: Extract<GraphNode, { kind: K }>,
  input: RouteInput,
  context: StepContext,
) => Promise<StepResult>;

/** The kinds this runtime executes. AGX-264 adds `human`; AGX-265 adds `subgraph`. */
export type ExecutableKind = Exclude<GraphNodeKind, 'action' | 'human' | 'subgraph'>;

export type ExecutorTable = { readonly [K in ExecutableKind]: Executor<K> };

export type WalkOutcome =
  | { readonly status: 'succeeded'; readonly output: RouteInput }
  | { readonly status: 'failed'; readonly reason: string }
  | { readonly status: 'cancelled' };

export interface WalkDependencies {
  readonly executors: ExecutorTable;
  /** What a backoff waits on. Injected so a retry schedule is a value a test reads. */
  readonly timers: Timers;
  /**
   * Called for every step record, with how many nodes the run has reached so
   * far -- the `step` of `step 3/9`.
   */
  readonly onStep: (step: GraphRunStep, reached: number) => void;
}

export interface Walk {
  readonly done: Promise<WalkOutcome>;
  /** Stops the run before its next step. Calling it twice does nothing the second time. */
  cancel(): void;
}

/** What to call a node in a sentence: its label, or its id when it has none. */
export function nameOf(node: GraphNode): string {
  return node.label.trim().length > 0 ? node.label : node.id;
}

/** The kind in the capitals the canvas letters it in. */
const KIND_WORDS: Record<GraphNodeKind, string> = {
  trigger: 'TRIGGER',
  router: 'ROUTER',
  agent: 'AGENT',
  subgraph: 'SUB-GRAPH',
  human: 'HUMAN',
  action: 'ACTION',
};

/** A TRIGGER passes the run input on. Where a run starts, and nothing else. */
export const triggerExecutor: Executor<'trigger'> = async (_node, input) => ({
  ok: true,
  output: input,
  next: null,
});

/**
 * A ROUTER picks the first route whose condition holds against its input,
 * else `otherwise`, else fails naming itself. Its output is its input: a
 * router decides where the run goes and changes nothing on the way.
 */
export const routerExecutor: Executor<'router'> = async (node, input) => {
  for (const route of node.routes) {
    const parsed = parseRouteCondition(route.condition);
    if (!parsed.ok) {
      return {
        ok: false,
        problem: `the condition ${JSON.stringify(route.condition)} on ${nameOf(node)} does not parse: ${parsed.problem}`,
      };
    }
    if (evaluateRouteCondition(parsed.condition, input)) {
      return { ok: true, output: input, next: route.to };
    }
  }
  if (node.otherwise !== null) return { ok: true, output: input, next: node.otherwise };
  return { ok: false, problem: `no route on ${nameOf(node)} matched and it has no otherwise` };
};

/**
 * The executor for a node, or `null` for a kind this runtime does not run.
 *
 * A switch and not an index, so that the kinds with no executor are named
 * here and a kind nobody has heard of is a type error at the `assertNever`.
 */
function executorFor(
  table: ExecutorTable,
  node: GraphNode,
): ((input: RouteInput, context: StepContext) => Promise<StepResult>) | null {
  switch (node.kind) {
    case 'trigger':
      return (input, context) => table.trigger(node, input, context);
    case 'router':
      return (input, context) => table.router(node, input, context);
    case 'agent':
      return (input, context) => table.agent(node, input, context);
    case 'action':
    case 'human':
    case 'subgraph':
      return null;
    default:
      return assertNever(node, 'graph node kind');
  }
}

function createCancellation(): Cancellation & { cancel(): void } {
  const listeners = new Set<() => void>();
  let cancelled = false;
  return {
    get cancelled(): boolean {
      return cancelled;
    },
    onCancel(listener: () => void): () => void {
      if (cancelled) {
        listener();
        return () => {};
      }
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      for (const listener of [...listeners]) listener();
      listeners.clear();
    },
  };
}

export function walk(
  document: GraphDocument,
  input: RouteInput,
  dependencies: WalkDependencies,
): Walk {
  const { executors, timers, onStep } = dependencies;
  const cancellation = createCancellation();
  const byId = new Map(document.nodes.map((node) => [node.id, node]));

  /** Waits `ms`, or returns early with `false` when the run is cancelled meanwhile. */
  const wait = (ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (waited: boolean): void => {
        if (settled) return;
        settled = true;
        detach();
        cancelTimer();
        resolve(waited);
      };
      const cancelTimer = timers.schedule(ms, () => finish(true));
      const detach = cancellation.onCancel(() => finish(false));
    });

  /** The one node an edge leads to, or the reason there is not exactly one. */
  const followEdge = (
    node: GraphNode,
  ): { readonly next: GraphNode | null } | { readonly problem: string } => {
    const outgoing = document.edges.filter((edge) => edge.from === node.id);
    if (outgoing.length === 0) return { next: null };
    if (outgoing.length > 1) {
      return {
        problem: `the ${KIND_WORDS[node.kind]} node ${nameOf(node)} has ${String(outgoing.length)} outgoing edges, and only a ROUTER chooses between them`,
      };
    }
    // The schema refused any edge to a node that is not there.
    return { next: byId.get(outgoing[0]?.to ?? node.id) ?? null };
  };

  async function run(): Promise<WalkOutcome> {
    const triggers = document.nodes.filter((node) => node.kind === 'trigger');
    const trigger = triggers[0];
    if (trigger === undefined || triggers.length !== 1) {
      return {
        status: 'failed',
        reason: `a run starts at the one TRIGGER node, and this document has ${String(triggers.length)}`,
      };
    }

    let node: GraphNode = trigger;
    let carried: RouteInput = input;
    let reached = 0;

    for (;;) {
      if (cancellation.cancelled) return { status: 'cancelled' };
      reached += 1;
      if (reached > GRAPH_NODES_MAX) {
        return {
          status: 'failed',
          reason: `the run reached ${nameOf(node)} as its ${String(reached)}th step, more nodes than a graph holds, so it is looping`,
        };
      }

      const execute = executorFor(executors, node);
      if (execute === null) {
        return {
          status: 'failed',
          reason: `the ${KIND_WORDS[node.kind]} node ${nameOf(node)} is a kind this runtime cannot execute yet`,
        };
      }

      let result: StepResult | null = null;
      for (let attempt = 0; attempt <= node.retry.max; attempt += 1) {
        onStep({ nodeId: node.id, attempt, outcome: 'running', output: null }, reached);
        let attempted: StepResult;
        try {
          attempted = await execute(carried, { document, attempt, cancellation });
        } catch (error) {
          attempted = { ok: false, problem: String(error) };
        }

        if (attempted.ok) {
          onStep(
            { nodeId: node.id, attempt, outcome: 'succeeded', output: attempted.output },
            reached,
          );
          result = attempted;
          break;
        }

        // A failure while cancelled is the cancel arriving, not the node
        // failing: the step is marked as what happened to it, and the run
        // ends without another try.
        if (cancellation.cancelled) {
          onStep({ nodeId: node.id, attempt, outcome: 'cancelled', output: null }, reached);
          return { status: 'cancelled' };
        }

        onStep({ nodeId: node.id, attempt, outcome: 'failed', output: null }, reached);
        if (attempt === node.retry.max) {
          const tries = node.retry.max + 1;
          return {
            status: 'failed',
            reason:
              tries === 1
                ? `the ${KIND_WORDS[node.kind]} node ${nameOf(node)} failed: ${attempted.problem}`
                : `the ${KIND_WORDS[node.kind]} node ${nameOf(node)} failed on all ${String(tries)} attempts; the last said: ${attempted.problem}`,
          };
        }
        const waited = await wait(node.retry.backoff * 1_000);
        if (!waited) return { status: 'cancelled' };
      }

      // Unreachable by construction -- the loop either broke with a result or
      // returned -- and said as a failure rather than a throw so the run ends
      // in words if it ever is reached.
      if (result === null || !result.ok) {
        return { status: 'failed', reason: `the node ${nameOf(node)} ended with no result` };
      }

      carried = result.output;
      if (cancellation.cancelled) return { status: 'cancelled' };

      let next: GraphNode | null;
      if (result.next !== null) {
        next = byId.get(result.next) ?? null;
        if (next === null) {
          return {
            status: 'failed',
            reason: `${nameOf(node)} routed to ${result.next}, which is no node here`,
          };
        }
      } else {
        const followed = followEdge(node);
        if ('problem' in followed) return { status: 'failed', reason: followed.problem };
        next = followed.next;
      }
      if (next === null) return { status: 'succeeded', output: carried };
      node = next;
    }
  }

  return { done: run(), cancel: () => cancellation.cancel() };
}
