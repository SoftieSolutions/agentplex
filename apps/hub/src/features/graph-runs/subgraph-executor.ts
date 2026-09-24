import {
  assertNever,
  type GraphDocument,
  type GraphNodeId,
  type GraphRunId,
  type NodeId,
  type RouteInput,
} from '@agentplex/protocol';
import type { Logger } from '@agentplex/node-shared';
import type { Graphs } from '../graphs/graphs.js';
import type { Executor, WalkOutcome } from './walker.js';

/**
 * A SUB-GRAPH step: run another graph at the version the node pins, as a run
 * of that graph, and answer when it ends.
 *
 * ## A child is a run, made where every run is made
 *
 * The child is not walked here. It is started through `launch`, which is the
 * feature's own way of starting a run -- the same row numbered in its own
 * graph, the same caps, the same executor table, the same states published to
 * whoever watches that graph -- with the parent's run and step on the row.
 * What is decided here is only what is particular to a step that recurses:
 * which document, whether the chain may go that deep, whether it reaches
 * itself, and what the child's end means for the step.
 *
 * ## The pin is resolved, never the newest
 *
 * The node names a graph and a published version, and that version is what
 * runs, read through `Graphs.publishedVersion`. Publish refused a pin to a
 * version that did not exist, and a published version never changes, so the
 * child runs exactly what the parent's author pointed at even after the
 * child graph has moved on. A pin that no longer resolves -- the child graph
 * removed since -- fails the step in words rather than running something else.
 *
 * ## The cycle check is a stack, keyed by graph
 *
 * `lineage` is every graph above this step, root first, ending with this
 * run's own. A SUB-GRAPH whose graph is already on that stack is refused
 * before anything is read or started, with the chain in the sentence. Keyed
 * by graph and not by graph and version: a pin must name a version published
 * before the one pinning it, so versions alone can never form a loop, but
 * v2 of a graph running v1 of itself is still a graph running inside itself
 * -- and at run time it would be refused anyway by the one-run-per-graph cap,
 * with a sentence about a run in flight instead of about the chain. So a
 * child of a graph already on the stack is a cycle, said as one.
 *
 * `SUBGRAPH_DEPTH_LIMIT` bounds the chain of distinct graphs. The root is
 * depth 0, and a child deeper than the limit is refused the same way. In
 * practice `GRAPH_RUNS_MAX_ACTIVE` is reached first on a hub with other runs
 * in flight, since every level of a chain is a run in flight; the depth
 * limit is the bound that holds whatever that cap is set to.
 *
 * ## Cancel goes down the chain
 *
 * A cancel of the parent tells the child, which stops before its own next
 * step and tells its own children, and the step ends when the child has. The
 * walk above reads its own cancellation and ends the run `cancelled`. A
 * child cancelled on its own, from its graph's screen, is a child that did
 * not succeed: the step fails, and the node's retry policy decides whether
 * another child is started -- unless the child failed on a decision, a HUMAN
 * node's Deny or timeout, which the step passes up as final rather than ask
 * the same person again through a new child.
 */

/** How deep a chain of SUB-GRAPH nodes may go below the run a person started. */
export const SUBGRAPH_DEPTH_LIMIT = 8;

/** One graph on the stack: the node the cycle check compares, and the name the sentence uses. */
export interface LineageEntry {
  readonly graph: NodeId;
  readonly name: string;
}

/** The run a SUB-GRAPH step belongs to, as this executor needs it. */
export interface SubgraphRun {
  readonly runId: GraphRunId;
  /** Every graph above and including this run's own, root first. */
  readonly lineage: readonly LineageEntry[];
}

/** What a step asks the feature to start. */
export interface ChildLaunch {
  readonly graph: NodeId;
  readonly version: number;
  readonly document: GraphDocument;
  readonly input: RouteInput;
  readonly parent: { readonly runId: GraphRunId; readonly nodeId: GraphNodeId };
  /** The parent's lineage; the child's own graph is added by whoever starts it. */
  readonly lineage: readonly LineageEntry[];
}

/** A child in flight: its name, and the handles that wait on it and stop it. */
export interface LaunchedChild {
  readonly runId: GraphRunId;
  readonly number: number;
  /** What the child graph is called, for the sentence a failure says. */
  readonly name: string;
  /** Resolves once the child's walk has ended, with how. */
  readonly done: Promise<WalkOutcome>;
  cancel(): void;
}

export type ChildLaunched =
  | { readonly ok: true; readonly child: LaunchedChild }
  | { readonly ok: false; readonly problem: string };

export interface SubgraphExecutorDependencies {
  /** The one read of the graphs feature a pin needs. */
  readonly graphs: Pick<Graphs, 'publishedVersion'>;
  /** Starts a child run, or says why not: the feature's caps, in their words. */
  readonly launch: (request: ChildLaunch) => Promise<ChildLaunched>;
  readonly logger: Logger;
}

export interface SubgraphExecutor {
  /** The executor for one run: its id is the parent every child names, its lineage the stack. */
  forRun(run: SubgraphRun): Executor<'subgraph'>;
}

export function createSubgraphExecutor(
  dependencies: SubgraphExecutorDependencies,
): SubgraphExecutor {
  const { graphs, launch } = dependencies;
  const logger = dependencies.logger.child({ part: 'graph-runs/subgraph' });

  return {
    forRun(run: SubgraphRun): Executor<'subgraph'> {
      return async (node, input, context) => {
        const above = run.lineage.findIndex((entry) => entry.graph === node.graph);
        if (above !== -1) {
          const chain = [...run.lineage.slice(above), run.lineage[above]]
            .map((entry) => entry?.name ?? node.graph)
            .join(' → ');
          return {
            ok: false,
            problem: `it would run ${run.lineage[above]?.name ?? node.graph}, which is already running above it in this chain: ${chain}`,
          };
        }
        const depth = run.lineage.length;
        if (depth > SUBGRAPH_DEPTH_LIMIT) {
          return {
            ok: false,
            problem: `it would start a run ${String(depth)} graphs deep, and a chain of SUB-GRAPH nodes goes at most ${String(SUBGRAPH_DEPTH_LIMIT)}`,
          };
        }

        const document = await graphs.publishedVersion(node.graph, node.version);
        if (document === null) {
          return {
            ok: false,
            problem: `it pins ${node.graph} at v${String(node.version)}, which is not a published version of any graph this hub has`,
          };
        }
        if (context.cancellation.cancelled) {
          return { ok: false, problem: 'the run was cancelled before this step started its child' };
        }

        const launched = await launch({
          graph: node.graph,
          version: node.version,
          document,
          input,
          parent: { runId: run.runId, nodeId: node.id },
          lineage: run.lineage,
        });
        if (!launched.ok) return { ok: false, problem: launched.problem };

        const { child } = launched;
        context.child({ runId: child.runId, number: child.number });
        logger.info('a SUB-GRAPH step started its child', {
          runId: run.runId,
          node: node.id,
          child: child.runId,
          number: child.number,
        });

        const detach = context.cancellation.onCancel(() => child.cancel());
        let outcome: WalkOutcome;
        try {
          outcome = await child.done;
        } finally {
          detach();
        }

        const named = `run #${String(child.number)} of ${child.name}`;
        switch (outcome.status) {
          case 'succeeded':
            // What the child ended with is what this step hands on: a
            // SUB-GRAPH is one node from the outside, and its output is the
            // last thing its own walk carried.
            return { ok: true, carried: outcome.output, output: null, next: null };
          case 'failed': {
            const problem = `${named} failed: ${outcome.reason}`;
            // A child that ended on a decision -- a Deny, a timeout nobody
            // answered -- would be asked the same question by another child.
            return outcome.retryable === false
              ? { ok: false, problem, retryable: false }
              : { ok: false, problem };
          }
          case 'cancelled':
            return { ok: false, problem: `${named} was cancelled` };
          default:
            return assertNever(outcome, 'how a child run ended');
        }
      };
    },
  };
}
