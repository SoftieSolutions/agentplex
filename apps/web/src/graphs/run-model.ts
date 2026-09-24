import type { GraphNodeId, GraphRunState, GraphRunStep, RunStatus } from '@agentplex/protocol';
import type { Tone } from '../ui/tokens.js';

/**
 * What the screen reads off a run state: the strip's sentence, the node the
 * canvas marks, and what the inspector shows as LAST OUTPUT.
 *
 * Pure, and all of it derived from one `GraphRunState` on each call, because
 * the state arrives whole and nothing here should remember an earlier one:
 * the hub replaces the running record with its outcome, so a step that is
 * running is exactly a step whose outcome says so in the latest frame.
 */

/** The word the strip uses for each status. `live` is the mock's word for a run in flight. */
export const STATUS_WORDS: Record<RunStatus, string> = {
  running: 'live',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** `run #38 · live · step 3/9`, as mockup 6d letters the strip. */
export function runStripText(run: GraphRunState): string {
  return `run #${String(run.number)} · ${STATUS_WORDS[run.status]} · step ${String(run.step)}/${String(run.of)}`;
}

/**
 * The tone a run's status draws in. A run in flight is `running`; one that
 * failed is `blocked`, because it is the thing on the screen that wants a
 * person; a run that ended any other way is at rest.
 */
export function runTone(status: RunStatus): Tone {
  switch (status) {
    case 'running':
      return 'running';
    case 'failed':
      return 'blocked';
    case 'succeeded':
    case 'cancelled':
      return 'idle';
  }
}

/** The node whose step is in flight, or `null` when no step is. */
export function runningNode(run: GraphRunState | null): GraphNodeId | null {
  if (run === null || run.status !== 'running') return null;
  const inFlight = run.steps.find((step) => step.outcome === 'running');
  return inFlight?.nodeId ?? null;
}

/** What the inspector shows under LAST OUTPUT for one node: the run, and that node's last step in it. */
export interface LastOutput {
  readonly number: number;
  readonly step: GraphRunStep;
}

/** The latest step record for a node in this run, or `null` when the run never reached it. */
export function lastOutputFor(run: GraphRunState | null, nodeId: GraphNodeId): LastOutput | null {
  if (run === null) return null;
  const step = [...run.steps].reverse().find((each) => each.nodeId === nodeId);
  return step === undefined ? null : { number: run.number, step };
}

/** The text drawn in the LAST OUTPUT slot: the output as JSON, or the outcome when there is none. */
export function lastOutputText(last: LastOutput): string {
  if (last.step.output !== null) return JSON.stringify(last.step.output, null, 2);
  return last.step.outcome;
}
