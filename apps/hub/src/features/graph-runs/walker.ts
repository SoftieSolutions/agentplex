import {
  assertNever,
  evaluateRouteCondition,
  GRAPH_NODES_MAX,
  GRAPH_RUN_OUTPUT_MAX_CHARS,
  parseRouteCondition,
  type GraphDocument,
  type GraphNode,
  type GraphNodeId,
  type GraphNodeKind,
  type GraphRunChild,
  type GraphRunStep,
  type GraphRunStepOutput,
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
 * ## The table is typed by kind, minus the one kind nothing runs
 *
 * `ExecutorTable` is `Record` over every kind but `action`. Publish refuses
 * an ACTION node, since no build performs one, so a run reaching one is a
 * document that bypassed publish; it fails with a sentence naming the node,
 * from a switch that ends in `assertNever` -- so a seventh kind added to the
 * protocol is a type error here and not a silent fall through.
 *
 * A SUB-GRAPH is an executor like any other: it runs a whole walk of another
 * graph and answers when that walk ends. The walk here knows nothing of
 * that except the child's name, which the executor hands over through
 * `StepContext.child` the moment the child is numbered, and which every
 * record of that attempt then carries -- the running one re-reported with it,
 * and the outcome. A retry is a new attempt and so a new child, which is what
 * lets a person see which try of the lint suite broke and open that one.
 *
 * ## A step is one attempt
 *
 * Every attempt at a node is reported twice: once as `running` when it begins
 * and once with what it became. The same `nodeId` and `attempt` on both, and
 * the second always directly after the first, so that whoever keeps the list
 * replaces a running record with its outcome rather than holding a step that
 * is forever running beside the one that ended. Retries are further attempts
 * of the same node, one wait apart. A node reached twice, through a cycle,
 * is two runs of records: the list is the walk in order, not a table by node.
 *
 * ## What a step hands on is not what it records
 *
 * A result has two outputs. `carried` is the route input the next node is
 * given -- what a ROUTER's conditions read -- and it may be as wide as a route
 * input is allowed to be. `output` is what the step record says about it, in
 * the bounded shape the protocol fixes per kind of node, and it is the only
 * one of the two that leaves this process. The end of the run is reported
 * through `onEnd` synchronously, before `done` resolves, so that whoever
 * publishes the steps can fold the end into the same change as the last
 * step's outcome instead of sending the list twice.
 *
 * A step that stops to ask a person is reported a third time, as `waiting`,
 * between those two. The executor says when, through `StepContext.waiting`,
 * because only it knows the moment the request left; the walk records it, so
 * that the run's status can say `waiting` off the same list everything else
 * is read from rather than off a second flag.
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
 * `carried` is handed to the next node; `output` is recorded on the step, or
 * `null` when the step has nothing worth a record. `next` is the node the run
 * goes to, or `null` to follow the node's one outgoing edge. Only a ROUTER
 * ever names one: its routes are the choice, and the walk following an edge
 * on its behalf would be a second reading of the same decision.
 *
 * A failure is retried by the node's policy unless it says `retryable:
 * false`: a failure that is a decision rather than a fault -- a person's Deny,
 * a timeout nobody answered -- ends the run at that node, because asking
 * again is overruling the answer. Absent means retryable, which is what every
 * fault an executor meets is.
 */
export type StepResult =
  | {
      readonly ok: true;
      readonly carried: RouteInput;
      readonly output: GraphRunStepOutput | null;
      readonly next: GraphNodeId | null;
    }
  | { readonly ok: false; readonly problem: string; readonly retryable?: false };

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
  /**
   * Says this attempt is now waiting on a person. The walk records a
   * `waiting` step for it; calling it twice records it twice, which whoever
   * keeps the list collapses.
   */
  waiting(): void;
  /**
   * Names the run this attempt started, for a SUB-GRAPH. The walk records
   * the running step again with the child on it, and every later record of
   * this attempt carries it too.
   */
  child(child: GraphRunChild): void;
}

export type Executor<K extends GraphNodeKind> = (
  node: Extract<GraphNode, { kind: K }>,
  input: RouteInput,
  context: StepContext,
) => Promise<StepResult>;

/** The kinds this runtime executes: every one but ACTION, which publish refuses. */
export type ExecutableKind = Exclude<GraphNodeKind, 'action'>;

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
  /**
   * Called once, synchronously, with how the run ended, after the last
   * `onStep` and before `done` resolves.
   */
  readonly onEnd: (outcome: WalkOutcome) => void;
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

/**
 * A TRIGGER passes the run input on, and records it as text cut at the
 * output bound. Where a run starts, and nothing else.
 */
export const triggerExecutor: Executor<'trigger'> = async (_node, input) => ({
  ok: true,
  carried: input,
  output: { kind: 'text', text: JSON.stringify(input).slice(0, GRAPH_RUN_OUTPUT_MAX_CHARS) },
  next: null,
});

/**
 * A ROUTER picks the first route whose condition holds against its input,
 * else `otherwise`, else fails naming itself. It hands its input on unchanged
 * -- a router decides where the run goes and changes nothing on the way -- and
 * records the choice: the index of the route that held, or `null` for
 * `otherwise`, and the node it led to.
 */
export const routerExecutor: Executor<'router'> = async (node, input) => {
  for (const [index, route] of node.routes.entries()) {
    const parsed = parseRouteCondition(route.condition);
    if (!parsed.ok) {
      return {
        ok: false,
        problem: `the condition ${JSON.stringify(route.condition)} on ${nameOf(node)} does not parse: ${parsed.problem}`,
      };
    }
    if (evaluateRouteCondition(parsed.condition, input)) {
      return {
        ok: true,
        carried: input,
        output: { kind: 'route', route: index, to: route.to },
        next: route.to,
      };
    }
  }
  if (node.otherwise !== null) {
    return {
      ok: true,
      carried: input,
      output: { kind: 'route', route: null, to: node.otherwise },
      next: node.otherwise,
    };
  }
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
    case 'human':
      return (input, context) => table.human(node, input, context);
    case 'subgraph':
      return (input, context) => table.subgraph(node, input, context);
    case 'action':
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
  const { executors, timers, onStep, onEnd } = dependencies;
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

  /**
   * Every exit of `run` goes through here, so the end is said in the same
   * synchronous stretch as the last step -- an `await` between them would be
   * a microtask in which the list is published without its end.
   */
  const end = (outcome: WalkOutcome): WalkOutcome => {
    onEnd(outcome);
    return outcome;
  };

  async function run(): Promise<WalkOutcome> {
    const triggers = document.nodes.filter((node) => node.kind === 'trigger');
    const trigger = triggers[0];
    if (trigger === undefined || triggers.length !== 1) {
      return end({
        status: 'failed',
        reason: `a run starts at the one TRIGGER node, and this document has ${String(triggers.length)}`,
      });
    }

    let node: GraphNode = trigger;
    let carried: RouteInput = input;
    let reached = 0;

    for (;;) {
      if (cancellation.cancelled) return end({ status: 'cancelled' });
      reached += 1;
      if (reached > GRAPH_NODES_MAX) {
        return end({
          status: 'failed',
          reason: `the run reached ${nameOf(node)} as its ${String(reached)}th step, more nodes than a graph holds, so it is looping`,
        });
      }

      const execute = executorFor(executors, node);
      if (execute === null) {
        return end({
          status: 'failed',
          reason: `the ${KIND_WORDS[node.kind]} node ${nameOf(node)} is a kind this runtime cannot execute yet`,
        });
      }

      let result: StepResult | null = null;
      for (let attempt = 0; attempt <= node.retry.max; attempt += 1) {
        // The child this attempt started, once the executor names one.
        let child: GraphRunChild | null = null;
        const record = (outcome: GraphRunStep['outcome'], output: GraphRunStepOutput | null) =>
          onStep({ nodeId: node.id, attempt, outcome, output, child }, reached);
        record('running', null);
        let attempted: StepResult;
        try {
          attempted = await execute(carried, {
            document,
            attempt,
            cancellation,
            waiting: () => record('waiting', null),
            child: (named) => {
              child = named;
              record('running', null);
            },
          });
        } catch (error) {
          attempted = { ok: false, problem: String(error) };
        }

        if (attempted.ok) {
          record('succeeded', attempted.output);
          result = attempted;
          break;
        }

        // A failure while cancelled is the cancel arriving, not the node
        // failing: the step is marked as what happened to it, and the run
        // ends without another try.
        if (cancellation.cancelled) {
          record('cancelled', null);
          return end({ status: 'cancelled' });
        }

        record('failed', null);
        if (attempt === node.retry.max || attempted.retryable === false) {
          const named = `the ${KIND_WORDS[node.kind]} node ${nameOf(node)}`;
          let reason: string;
          if (attempt === 0) reason = `${named} failed: ${attempted.problem}`;
          else if (attempted.retryable === false)
            reason = `${named} failed on attempt ${String(attempt + 1)}, and not for a reason another try changes: ${attempted.problem}`;
          else
            reason = `${named} failed on all ${String(attempt + 1)} attempts; the last said: ${attempted.problem}`;
          return end({ status: 'failed', reason });
        }
        const waited = await wait(node.retry.backoff * 1_000);
        if (!waited) return end({ status: 'cancelled' });
      }

      // Unreachable by construction -- the loop either broke with a result or
      // returned -- and said as a failure rather than a throw so the run ends
      // in words if it ever is reached.
      if (result === null || !result.ok) {
        return end({ status: 'failed', reason: `the node ${nameOf(node)} ended with no result` });
      }

      carried = result.carried;
      if (cancellation.cancelled) return end({ status: 'cancelled' });

      let next: GraphNode | null;
      if (result.next !== null) {
        next = byId.get(result.next) ?? null;
        if (next === null) {
          return end({
            status: 'failed',
            reason: `${nameOf(node)} routed to ${result.next}, which is no node here`,
          });
        }
      } else {
        const followed = followEdge(node);
        if ('problem' in followed) return end({ status: 'failed', reason: followed.problem });
        next = followed.next;
      }
      if (next === null) return end({ status: 'succeeded', output: carried });
      node = next;
    }
  }

  return { done: run(), cancel: () => cancellation.cancel() };
}
