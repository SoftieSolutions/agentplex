import type { GraphRunId, GraphRunState, HubFrame } from '@agentplex/protocol';
import type { HubSnapshot } from './views.js';

/**
 * What the hub says about graphs that is filed by something other than the
 * frame that asked: a graph document by its node, a run by its id, and a run
 * history by its graph. The answers a screen reads by its own frame id go into
 * `answers` like any other; this is the rest.
 *
 * The store hands this file the frames already narrowed by the one hub-frame
 * switch, and settles `pending` and `answers` itself.
 */

type Frame<T extends HubFrame['type']> = Extract<HubFrame, { type: T }>;

/** How many runs the store remembers, oldest first. Far above any screen's interest. */
export const MAX_REMEMBERED_RUNS = 64;

export interface GraphRepliesDependencies {
  snapshot(): HubSnapshot;
  update(changes: Partial<Pick<HubSnapshot, 'runs' | 'runHistories' | 'graphDocuments'>>): void;
}

export interface GraphReplies {
  /** A graph as the hub answered an open of it, filed by the node. */
  document(frame: Frame<'graph-document'>): void;
  /** A run's whole state, unsolicited. */
  state(frame: Frame<'graph-run-state'>): void;
  /** The answer to a read or an open of a run: the run in it, if any, is filed. */
  latest(frame: Frame<'graph-run-latest'>): void;
  /** One graph's run history, filed by the graph. */
  history(frame: Frame<'graph-run-history'>): void;
  /** The connection dropped: forgets the runs, and answers whether any were held. */
  dropRuns(): boolean;
  /** Nothing is looking any more: forgets the runs. */
  forget(): void;
}

export function createGraphReplies(dependencies: GraphRepliesDependencies): GraphReplies {
  const { update } = dependencies;
  /**
   * Every run this client has been told about, by run id: what `runs` on
   * the snapshot is a copy of. Bounded, oldest first, for the reason the
   * starts are: a tab watching a graph all day would otherwise keep one
   * entry per run for as long as it is open.
   */
  const runs = new Map<GraphRunId, GraphRunState>();

  /** Files a run whole under its id, the oldest forgotten past the bound. */
  function fileRun(state: GraphRunState): void {
    runs.set(state.runId, state);
    while (runs.size > MAX_REMEMBERED_RUNS) {
      const oldest = runs.keys().next().value;
      if (oldest === undefined) break;
      runs.delete(oldest);
    }
  }

  return {
    document(frame: Frame<'graph-document'>): void {
      const graphs = new Map(dependencies.snapshot().graphDocuments);
      graphs.set(frame.nodeId, {
        replyTo: frame.replyTo,
        nodeId: frame.nodeId,
        name: frame.name,
        draftVersion: frame.draftVersion,
        document: frame.document,
        published: frame.published,
      });
      update({ graphDocuments: graphs });
    },

    state(frame: Frame<'graph-run-state'>): void {
      // Unsolicited and whole: filed by the run, replacing what was there.
      // Nothing is pending for it, because nobody asked for this frame.
      const { type: _type, ...state } = frame;
      fileRun(state);
      update({ runs: new Map(runs) });
    },

    latest(frame: Frame<'graph-run-latest'>): void {
      // A run in the answer is filed like any state, so that a screen
      // reading its graph's newest out of `runs` finds it there too.
      if (frame.run === null) return;
      fileRun(frame.run);
      update({ runs: new Map(runs) });
    },

    history(frame: Frame<'graph-run-history'>): void {
      // Filed by the graph and replacing the list held for it: the answer
      // is whole, newest first, as the hub read it.
      const histories = new Map(dependencies.snapshot().runHistories);
      histories.set(frame.nodeId, {
        replyTo: frame.replyTo,
        nodeId: frame.nodeId,
        runs: frame.runs,
      });
      update({ runHistories: histories });
    },

    dropRuns(): boolean {
      const held = runs.size > 0;
      runs.clear();
      return held;
    },

    forget(): void {
      runs.clear();
    },
  };
}
