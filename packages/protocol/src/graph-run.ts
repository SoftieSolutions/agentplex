import { z } from 'zod';
import { GRAPH_NODES_MAX, GRAPH_RETRY_MAX, graphNodeIdSchema } from './graph.js';
import { nodeIdSchema, sessionIdSchema, storeIdSchema } from './identity.js';
import { sessionStatusSchema } from './session.js';

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
 * first failure's sentence the moment the second try began. A node a cycle
 * reaches twice is two runs of records, in the order the walk made them.
 *
 * ## What a step records is not what it hands on
 *
 * The object one node hands the next -- what a ROUTER's conditions read -- is
 * a route input of up to `ROUTE_INPUT_MAX_CHARS`, and a run may have hundreds
 * of steps. Recording it on every step would make one state frame megabytes
 * wide, sent to every client on every change. So a step records a summary of
 * a fixed shape per kind of node instead: an AGENT step names the session it
 * ran and how it stopped, a ROUTER step says which route matched, and a
 * TRIGGER records the run input as text cut at `GRAPH_RUN_OUTPUT_MAX_CHARS`.
 * The one free text there is has that bound and the schema enforces it, so no
 * step can grow a frame past what every client is sent.
 */

/** The hub's name for one run. Opaque, minted by the hub, unique across every graph. */
export const graphRunIdSchema = z.string().min(1).max(200).brand<'GraphRunId'>();
export type GraphRunId = z.infer<typeof graphRunIdSchema>;

/**
 * Where a run is. `running` and `waiting` are the two open states; the other
 * three are final, and a run in one of them never moves again.
 *
 * `waiting` is a run parked at a HUMAN node until a person answers. Its own
 * word rather than a `running` the strip reads as `live`, because nothing is
 * running: no session is working, no machine is busy, and a person looking at
 * `live` would wait for something that is waiting for them.
 */
export const runStatusSchema = z.enum(['running', 'waiting', 'succeeded', 'failed', 'cancelled']);
export type RunStatus = z.infer<typeof runStatusSchema>;

/**
 * What one attempt at one node became. `running` and `waiting` are the
 * attempt in flight, and there is at most one of those in a run at a time.
 */
export const stepOutcomeSchema = z.enum(['running', 'waiting', 'succeeded', 'failed', 'cancelled']);
export type StepOutcome = z.infer<typeof stepOutcomeSchema>;

/**
 * The most step records one run may carry: every node tried the most times
 * the retry schema allows, which is the worst a published graph can do.
 */
export const GRAPH_RUN_STEPS_MAX = GRAPH_NODES_MAX * (GRAPH_RETRY_MAX + 1);

/** The most characters the one free-text output a step may record can hold. */
export const GRAPH_RUN_OUTPUT_MAX_CHARS = 1_000;

/**
 * What one attempt recorded, by the kind of node that made it.
 *
 * `text` is a TRIGGER's: the run input as JSON, cut at the bound. `route` is
 * a ROUTER's: the index of the route that matched, or `null` when it fell to
 * `otherwise`, and the node it sent the run to. `session` is an AGENT's: the
 * session it ran and the status it stopped on, and nothing of what the agent
 * said -- that is the session's transcript, read on demand.
 */
export const graphRunStepOutputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text: z.string().max(GRAPH_RUN_OUTPUT_MAX_CHARS) }),
  z.strictObject({
    kind: z.literal('route'),
    route: z.int().nonnegative().nullable(),
    to: graphNodeIdSchema,
  }),
  z.strictObject({
    kind: z.literal('session'),
    storeId: storeIdSchema,
    sessionId: sessionIdSchema,
    status: sessionStatusSchema,
  }),
]);
export type GraphRunStepOutput = z.infer<typeof graphRunStepOutputSchema>;

/**
 * The run a SUB-GRAPH step started, named and never carried.
 *
 * A child is a run of another graph, with its own row, its own number in that
 * graph and its own states sent to whoever watches that graph. The parent's
 * step names it -- the id every frame files it under, and the number a person
 * says -- so that a person reading the parent can follow the link to the
 * child, and the parent's state stays the size of the parent's own steps
 * however deep the chain beneath it goes.
 */
export const graphRunChildSchema = z.strictObject({
  runId: graphRunIdSchema,
  number: z.int().positive(),
});
export type GraphRunChild = z.infer<typeof graphRunChildSchema>;

/**
 * One attempt at one node.
 *
 * `output` is what the attempt recorded, in the bounded shape above; `null`
 * while the attempt is running and for an attempt that made nothing.
 *
 * `child` is the run a SUB-GRAPH attempt started, from the moment it was
 * numbered, and `null` on every other step. Required rather than optional: a
 * record that is silent about a child and one that says there was none would
 * otherwise be two shapes for one fact. A retried SUB-GRAPH node is a new
 * child per attempt, so each attempt names its own.
 */
export const graphRunStepSchema = z.object({
  nodeId: graphNodeIdSchema,
  attempt: z.int().nonnegative(),
  outcome: stepOutcomeSchema,
  output: graphRunStepOutputSchema.nullable(),
  child: graphRunChildSchema.nullable(),
});
export type GraphRunStep = z.infer<typeof graphRunStepSchema>;

/**
 * A run, whole, as a client watching its graph is told it.
 *
 * `nodeId` is the graph the run is of. It is on the state and not only on the
 * frame that started the run, because a client that attaches mid-run, or asks
 * `graph-run-read` after a reconnection, has no started reply to join it to:
 * the graph it is watching is the whole of what it knows.
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
  nodeId: nodeIdSchema,
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

/**
 * The most runs one history answer lists: the graph's newest, and no more.
 *
 * A graph run every few minutes for a year is a hundred thousand rows, and a
 * list nobody scrolls to the bottom of is bytes sent to every screen that
 * opens it. Fifty is more than a person reads before they would rather ask a
 * question of the history than scroll it.
 */
export const GRAPH_RUN_HISTORY_MAX = 50;

/**
 * One run as the history list draws it: its name, its number, how it ended
 * and when, and the sentence it ended with.
 *
 * No steps. A history of fifty runs each carrying its step list would be the
 * frame `graph-run-state` is careful not to be, fifty times over; a person
 * who wants a run's steps picks the row, and that one run is read whole.
 * `endedAt` is `null` while the run is still going, and `reason` is `null`
 * for one that is going or that succeeded, as on the state.
 */
export const graphRunSummarySchema = z.strictObject({
  runId: graphRunIdSchema,
  number: z.int().positive(),
  status: runStatusSchema,
  startedAt: z.int().nonnegative(),
  endedAt: z.int().nonnegative().nullable(),
  reason: z.string().nullable(),
});
export type GraphRunSummary = z.infer<typeof graphRunSummarySchema>;
