import {
  GRAPH_RUN_HISTORY_MAX,
  type GraphRunId,
  type GraphRunState,
  type GraphRunSummary,
  type NodeId,
} from '@agentplex/protocol';
import type { Tone } from '../ui/tokens.js';
import { isRunOpen, runTone, STATUS_WORDS } from './run-model.js';

/**
 * What the history list reads off the hub's answer.
 *
 * Pure, like `run-model.ts`: the hub sends a graph's runs newest first as
 * summaries, and a row is derived from one summary on each call. The order is
 * the hub's and is never re-sorted here -- the hub numbers runs and knows
 * which is newest; a client sorting by a clock would be a second opinion on a
 * fact it does not own.
 *
 * ## When the list has fallen behind
 *
 * The list is a reply, not a stream: nothing sends a new one when a run
 * starts or ends. What does arrive unasked is each run's state, whole, to
 * every screen watching the graph. So the list is behind exactly when a state
 * this screen holds disagrees with it -- a run it does not list, or a listed
 * run whose status has moved -- and the store asks again then, and only
 * then. A run older than the oldest row of a full list is not a disagreement:
 * the list stops at its bound by design, and treating that run as missing
 * would ask again for ever.
 */

/** One row of the list, as drawn. */
export interface HistoryRow {
  readonly runId: GraphRunId;
  readonly number: number;
  /** `run #38 · failed · 12s`: the number, the strip's word, and how long it took once it has ended. */
  readonly text: string;
  /** The sentence a failed run ended with, drawn beside it, or `null`. */
  readonly reason: string | null;
  readonly tone: Tone;
  /** Whether this is the run the strip and LAST OUTPUT are showing. */
  readonly selected: boolean;
}

/** How long a run took, in the largest two units; `null` while it has not ended. */
export function durationText(startedAt: number, endedAt: number | null): string | null {
  if (endedAt === null) return null;
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1_000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}

/** The rows, in the hub's order, with the selected run marked. */
export function historyRows(
  runs: readonly GraphRunSummary[],
  selected: GraphRunId | null,
): HistoryRow[] {
  return runs.map((run) => {
    const took = isRunOpen(run.status) ? null : durationText(run.startedAt, run.endedAt);
    const words = [`run #${String(run.number)}`, STATUS_WORDS[run.status]];
    if (took !== null) words.push(took);
    return {
      runId: run.runId,
      number: run.number,
      text: words.join(' · '),
      reason: run.reason,
      tone: runTone(run.status),
      selected: run.runId === selected,
    };
  });
}

/**
 * Whether the list disagrees with the run states this screen has been told
 * about since, so that it should be asked for again. `null` -- never answered
 * -- is behind by definition.
 */
export function historyIsBehind(
  history: readonly GraphRunSummary[] | null,
  runs: Iterable<GraphRunState>,
  nodeId: NodeId,
): boolean {
  if (history === null) return true;
  const listed = new Map(history.map((run) => [run.runId, run]));
  const full = history.length >= GRAPH_RUN_HISTORY_MAX;
  const oldest = history.at(-1)?.number ?? 0;
  for (const run of runs) {
    if (run.nodeId !== nodeId) continue;
    const row = listed.get(run.runId);
    if (row === undefined) {
      if (!full || run.number > oldest) return true;
      continue;
    }
    if (row.status !== run.status) return true;
  }
  return false;
}
