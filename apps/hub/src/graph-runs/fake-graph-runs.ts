import {
  graphRunIdSchema,
  type GraphRunId,
  type GraphRunState,
  type GraphRunSummary,
  type NodeId,
  type RouteInput,
  type SessionStartTag,
  type StoreId,
} from '@agentplex/protocol';
import type {
  GraphRunRefusal,
  GraphRuns,
  RunCancelled,
  RunStarted,
  Simulated,
} from './graph-runs.js';

/**
 * The runtime, driven by hand, for the tests whose subject is the socket.
 *
 * What a client connection has to get right is what it does with an answer
 * -- a run id and a number, a refusal in words, a state or nothing for a read
 * -- and what it does with a state that arrives unsolicited. Each of those is
 * a value this hands back or lets a test push. Nothing walks, nothing is
 * numbered per graph and nothing is written; those rules live with the real
 * feature and its own suite.
 */
export interface FakeGraphRuns extends GraphRuns {
  /** Every start asked for, in order. */
  readonly starts: readonly { nodeId: NodeId; input: RouteInput }[];
  /** Every cancel asked for, in order. */
  readonly cancels: readonly GraphRunId[];
  /** Every read asked for, in order. */
  readonly reads: readonly NodeId[];
  /** Every history asked for, in order. */
  readonly histories: readonly NodeId[];
  /** Every open of one run asked for, in order. */
  readonly opens: readonly { nodeId: NodeId; runId: GraphRunId }[];
  /** Every simulation asked for, in order. */
  readonly simulations: readonly { nodeId: NodeId; input: RouteInput }[];
  /** What every later simulation answers with. The default is an empty path that reached its end. */
  answerSimulationsWith(simulated: Simulated): void;
  /** What every later start and cancel answers with, in place of the default yes. */
  refuseWith(refusal: Omit<GraphRunRefusal, 'ok'> | null): void;
  /** What every later read answers with. `null`, the default, is a graph that has never run. */
  answerReadsWith(state: GraphRunState | null): void;
  /** What every later history answers with. Empty, the default, is a graph never run. */
  answerHistoryWith(runs: readonly GraphRunSummary[]): void;
  /** What every later open answers with. `null`, the default, is a run the graph does not have. */
  answerOpensWith(state: GraphRunState | null): void;
  /** Publishes a state as the real feature would, through `onState`. */
  emit(state: GraphRunState): void;
}

export interface FakeGraphRunsOptions {
  readonly onState?: (state: GraphRunState) => void;
}

export function createFakeGraphRuns(options: FakeGraphRunsOptions = {}): FakeGraphRuns {
  const starts: { nodeId: NodeId; input: RouteInput }[] = [];
  const cancels: GraphRunId[] = [];
  const reads: NodeId[] = [];
  const histories: NodeId[] = [];
  const opens: { nodeId: NodeId; runId: GraphRunId }[] = [];
  const simulations: { nodeId: NodeId; input: RouteInput }[] = [];
  let simulation: Simulated = { ok: true, path: [], reason: null };
  let history: readonly GraphRunSummary[] = [];
  let opened: GraphRunState | null = null;
  let refusal: Omit<GraphRunRefusal, 'ok'> | null = null;
  let latest: GraphRunState | null = null;
  let minted = 0;

  return {
    async load(): Promise<void> {},

    async start(nodeId: NodeId, input: RouteInput): Promise<RunStarted> {
      starts.push({ nodeId, input });
      if (refusal !== null) return { ok: false, ...refusal };
      minted += 1;
      return { ok: true, runId: graphRunIdSchema.parse(`run-${String(minted)}`), number: minted };
    },

    async cancel(runId: GraphRunId): Promise<RunCancelled> {
      cancels.push(runId);
      if (refusal !== null) return { ok: false, ...refusal };
      return { ok: true };
    },

    async latest(nodeId: NodeId): Promise<GraphRunState | null> {
      reads.push(nodeId);
      return latest;
    },

    async history(nodeId: NodeId): Promise<readonly GraphRunSummary[]> {
      histories.push(nodeId);
      return history;
    },

    async open(nodeId: NodeId, runId: GraphRunId): Promise<GraphRunState | null> {
      opens.push({ nodeId, runId });
      return opened;
    },

    async simulate(nodeId: NodeId, input: RouteInput): Promise<Simulated> {
      simulations.push({ nodeId, input });
      return simulation;
    },

    answerSimulationsWith(next: Simulated): void {
      simulation = next;
    },

    noteStarts(_storeId: StoreId, _starts: readonly SessionStartTag[]): void {},

    stop(): void {},

    refuseWith(next: Omit<GraphRunRefusal, 'ok'> | null): void {
      refusal = next;
    },

    answerReadsWith(state: GraphRunState | null): void {
      latest = state;
    },

    answerHistoryWith(runs: readonly GraphRunSummary[]): void {
      history = runs;
    },

    answerOpensWith(state: GraphRunState | null): void {
      opened = state;
    },

    emit(state: GraphRunState): void {
      options.onState?.(state);
    },

    get starts() {
      return starts;
    },
    get cancels() {
      return cancels;
    },
    get reads() {
      return reads;
    },
    get histories() {
      return histories;
    },
    get opens() {
      return opens;
    },
    get simulations() {
      return simulations;
    },
  };
}
