import {
  graphRunIdSchema,
  type GraphRunId,
  type GraphRunState,
  type NodeId,
  type RouteInput,
  type SessionStartTag,
  type StoreId,
} from '@agentplex/protocol';
import type { GraphRunRefusal, GraphRuns, RunCancelled, RunStarted } from './graph-runs.js';

/**
 * The runtime, driven by hand, for the tests whose subject is the socket.
 *
 * What a client connection has to get right is what it does with an answer
 * -- a run id and a number, a refusal in words -- and what it does with a
 * state that arrives unsolicited. Each of those is a value this hands back or
 * lets a test push. Nothing walks, nothing is numbered per graph and nothing
 * is written; those rules live with the real feature and its own suite.
 */
export interface FakeGraphRuns extends GraphRuns {
  /** Every start asked for, in order. */
  readonly starts: readonly { nodeId: NodeId; input: RouteInput }[];
  /** Every cancel asked for, in order. */
  readonly cancels: readonly GraphRunId[];
  /** What every later start and cancel answers with, in place of the default yes. */
  refuseWith(refusal: Omit<GraphRunRefusal, 'ok'> | null): void;
  /** Publishes a state as the real feature would: through `onState` and to the run's watchers. */
  emit(state: GraphRunState): void;
}

export interface FakeGraphRunsOptions {
  readonly onState?: (state: GraphRunState) => void;
}

export function createFakeGraphRuns(options: FakeGraphRunsOptions = {}): FakeGraphRuns {
  const starts: { nodeId: NodeId; input: RouteInput }[] = [];
  const cancels: GraphRunId[] = [];
  const watchers = new Map<GraphRunId, Set<(state: GraphRunState) => void>>();
  let refusal: Omit<GraphRunRefusal, 'ok'> | null = null;
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

    subscribe(runId: GraphRunId, watcher: (state: GraphRunState) => void): () => void {
      const held = watchers.get(runId) ?? new Set();
      watchers.set(runId, held);
      held.add(watcher);
      return () => void held.delete(watcher);
    },

    noteStarts(_storeId: StoreId, _starts: readonly SessionStartTag[]): void {},

    refuseWith(next: Omit<GraphRunRefusal, 'ok'> | null): void {
      refusal = next;
    },

    emit(state: GraphRunState): void {
      options.onState?.(state);
      for (const watcher of watchers.get(state.runId) ?? []) watcher(state);
    },

    get starts() {
      return starts;
    },
    get cancels() {
      return cancels;
    },
  };
}
