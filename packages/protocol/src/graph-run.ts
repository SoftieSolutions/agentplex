import { z } from 'zod';
import { GRAPH_NODES_MAX, GRAPH_RETRY_MAX, graphNodeIdSchema } from './graph.js';
import { routeInputSchema } from './route-condition.js';

/**
 * A run of a graph: what it is called, where it has got to, and what each
 * step made.
 *
 * ## One state, whole, every time
 *
 * A run is reported as `graph-run-state`, and the frame carries the whole run
 * each time: every step so far, the status, the step count. Not a delta, for
 * the reason the machine state is not one -- two clients holding different
 * subsets of an edit stream disagree, and a client that attaches mid-run has
 * nothing to catch up on because the next frame is everything. A run is at
 * most a few hundred step records (`GRAPH_RUN_STEPS_MAX`), so the whole of it
 * fits a frame comfortably.
 *
 * ## No money
 *
 * The mock draws a dollar figure beside the step count. There is no cost
 * field here and none is planned: a dollar figure is a conversion through a
 * price table this program does not control, and `session.ts` makes the
 * argument at length for why token counts travel and dollars do not.
 *
 * ## Steps are attempts
 *
 * A step record is one attempt at one node. A node retried twice is three
 * records with the same `nodeId` and attempts 0, 1 and 2, because what a
 * person reading the strip wants to know is that the node was tried again and
 * what each try said -- collapsing the attempts into one record would lose the
 * first failure's sentence the moment the second try began.
 */

/** The hub's name for one run. Opaque, minted by the hub, unique across every graph. */
export const graphRunIdSchema = z.string().min(1).max(200).brand<'GraphRunId'>();
export type GraphRunId = z.infer<typeof graphRunIdSchema>;

/**
 * Where a run is. `running` is the only open state; the other three are
 * final, and a run in one of them never moves again.
 */
export const runStatusSchema = z.enum(['running', 'succeeded', 'failed', 'cancelled']);
export type RunStatus = z.infer<typeof runStatusSchema>;

/**
 * What one attempt at one node became. `running` is the attempt in flight,
 * and there is at most one of those in a run at a time.
 */
export const stepOutcomeSchema = z.enum(['running', 'succeeded', 'failed', 'cancelled']);
export type StepOutcome = z.infer<typeof stepOutcomeSchema>;

/**
 * The most step records one run may carry: every node tried the most times
 * the retry schema allows, which is the worst a published graph can do.
 */
export const GRAPH_RUN_STEPS_MAX = GRAPH_NODES_MAX * (GRAPH_RETRY_MAX + 1);

/**
 * One attempt at one node.
 *
 * `output` is what the step produced and what the next step is handed: a
 * TRIGGER's is the run input, a ROUTER's is what it was given, an AGENT's
 * names the session it ran. Bounded by the same schema a route input is,
 * because that is what it is -- the object the next ROUTER's conditions read.
 * `null` while the attempt is running and for an attempt that made nothing.
 */
export const graphRunStepSchema = z.object({
  nodeId: graphNodeIdSchema,
  attempt: z.int().nonnegative(),
  outcome: stepOutcomeSchema,
  output: routeInputSchema.nullable(),
});
export type GraphRunStep = z.infer<typeof graphRunStepSchema>;

/**
 * A run, whole, as every client is told it.
 *
 * `step` counts the nodes the run has reached and `of` is how many nodes the
 * document has, which is what the strip's `step 3/9` reads. `of` is a bound
 * and not a prophecy -- a ROUTER skips whole branches -- so the strip says
 * where a run is in the graph rather than how long it has left.
 *
 * `reason` is the sentence a run ended with, and it is `null` for a run that
 * is still going or that succeeded. A failed run always has one, and it names
 * the node: "no route on classify matched" is a thing to go and fix, and a
 * bare `failed` is not.
 */
export const graphRunStateSchema = z.object({
  runId: graphRunIdSchema,
  /** Counts from 1 per graph, so a person can say "run 38 broke". */
  number: z.int().positive(),
  status: runStatusSchema,
  reason: z.string().nullable(),
  step: z.int().nonnegative(),
  of: z.int().nonnegative(),
  steps: z.array(graphRunStepSchema).max(GRAPH_RUN_STEPS_MAX),
});
export type GraphRunState = z.infer<typeof graphRunStateSchema>;
