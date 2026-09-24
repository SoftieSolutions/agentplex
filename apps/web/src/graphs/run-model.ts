import {
  assertNever,
  type GraphNodeId,
  type GraphRunState,
  type GraphRunStep,
  type RunStatus,
} from '@agentplex/protocol';
import type { Tone } from '../ui/tokens.js';

/**
 * What the screen reads off a run state: the strip's sentence, the node the
 * canvas marks, and what the inspector shows as LAST OUTPUT.
 *
 * Pure, and all of it derived from one `GraphRunState` on each call, because
 * the state arrives whole and nothing here should remember an earlier one:
 * the hub replaces the running record with its outcome, so a step that is
 * running is exactly a step whose outcome says so in the latest frame.
 *
 * `stale` is the store's word that the state it holds was true of a
 * connection that is gone: the hub sends nothing about a run while the socket
 * is down, so a run that read `running` then may have ended since. A stale
 * run is drawn as what it is -- a run being asked about -- and never as live.
 */

/**
 * The word the strip uses for each status. `live` is the mock's word for a
 * run in flight; a run parked at a HUMAN node says who it is waiting for,
 * because `live` would promise work that is not happening.
 */
export const STATUS_WORDS: Record<RunStatus, string> = {
  running: 'live',
  waiting: 'waiting on a person',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
};

/** `run #38 · live · step 3/9`, as mockup 6d letters the strip; `reconnecting` in place of the open word for a stale run. */
export function runStripText(run: GraphRunState, stale = false): string {
  const word = stale && isRunOpen(run.status) ? 'reconnecting' : STATUS_WORDS[run.status];
  return `run #${String(run.number)} · ${word} · step ${String(run.step)}/${String(run.of)}`;
}

/**
 * Whether a run is still going: in flight, or parked for a person. The two
 * open states share everything a screen decides on them -- Cancel is offered,
 * Run is not -- so the question is asked here once.
 */
export function isRunOpen(status: RunStatus): boolean {
  return status === 'running' || status === 'waiting';
}

/**
 * The tone a run's status draws in. A run in flight is `running`; one waiting
 * on a person is `needs-you`, which is the tone of everything else on the
 * screen that wants somebody; one that failed is `blocked`, because it is a
 * thing to go and fix; a run that ended any other way is at rest -- and so is
 * a stale run that read open, because nothing here can vouch that it still is.
 */
export function runTone(status: RunStatus, stale = false): Tone {
  switch (status) {
    case 'running':
      return stale ? 'idle' : 'running';
    case 'waiting':
      return stale ? 'idle' : 'needs-you';
    case 'failed':
      return 'blocked';
    case 'succeeded':
    case 'cancelled':
      return 'idle';
  }
}

/** The node whose step is in flight or waiting, or `null` when no step is, or when the run is stale. */
export function runningNode(run: GraphRunState | null, stale = false): GraphNodeId | null {
  if (run === null || stale || !isRunOpen(run.status)) return null;
  const inFlight = run.steps.find(
    (step) => step.outcome === 'running' || step.outcome === 'waiting',
  );
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

/**
 * The text drawn in the LAST OUTPUT slot: what the step recorded, in words
 * per kind, or the outcome when it recorded nothing. Route indexes are
 * counted from 1 here because that is how the inspector numbers them.
 */
export function lastOutputText(last: LastOutput): string {
  const output = last.step.output;
  if (output === null) return last.step.outcome;
  switch (output.kind) {
    case 'text':
      return output.text;
    case 'route':
      return output.route === null
        ? `otherwise to ${output.to}`
        : `route ${String(output.route + 1)} to ${output.to}`;
    case 'session':
      return `session ${output.sessionId} · ${output.status}`;
    default:
      return assertNever(output, 'step output');
  }
}
