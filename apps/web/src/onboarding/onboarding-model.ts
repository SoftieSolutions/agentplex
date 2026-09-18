import type { MachineState } from '@agentplex/protocol';
import type { ConnectionPhase } from '../store/hub-store.js';
import { serverRows } from '../settings/server-rows.js';

/**
 * Whether the first-run wizard is drawn, and which of its steps is live, as
 * pure functions. The screen owns the dismissal and the address; every rule
 * about what those two facts plus the hub's own answer add up to lives here,
 * where a test can hold a captured machine state against it.
 *
 * The auto-show is deliberately narrow: it fires for a hub that is paired with
 * no server at all, and that is a state only a hub installed on its own can be
 * in. A machine set up with `--role=both` records its own loopback server
 * during setup and the hub pairs it at boot (see the sentence setup prints at
 * apps/cli/src/commands/setup/setup-wizard.ts:887), so that hub answers its
 * very first machine-state frame with one server already in it and the wizard
 * never appears unasked. That is the intended outcome rather than a gap: there
 * is nothing to walk such an operator through, and a wizard that opens over a
 * working fleet is noise. `#/onboarding` is how it is reached afterwards, and
 * a request from the address bar outranks everything below -- a person who
 * typed the route is asking for the wizard whatever the fleet looks like, and
 * an earlier dismissal is not an answer to a later question.
 */

/** What the app does with the wizard this render. */
export type OnboardingVerdict =
  /**
   * Draw nothing yet. The hub has not answered, and `serverRows` reads an
   * unanswered state and a genuinely empty fleet as the same empty list
   * (src/settings/server-rows.ts:162 returns `[]` for `null`), so deciding
   * from it before the first frame arrives would flash the wizard at every
   * operator on every load. Not knowing is its own answer.
   */
  'wait' | 'show' | 'hide';

/** Which step of the wizard is the live one. */
export type OnboardingStep =
  /** Get a connection to the hub first; nothing else can be done without one. */
  | 'connect'
  /** Connected, so the outstanding work is pairing a server. */
  | 'pair';

export interface OnboardingInputs {
  /** The hub's latest whole state, or `null` before the first one arrives. */
  readonly machineState: MachineState | null;
  /** Whether this browser has already closed the wizard. */
  readonly dismissed: boolean;
  /** Whether the address bar asked for it: `#/onboarding`. */
  readonly requested: boolean;
}

/**
 * The gate, in the order the three facts can be trusted.
 *
 * The request is read first because it is the one fact that is certainly
 * true -- somebody typed it. The unanswered state comes next, before anything
 * counts servers, for the reason spelled out on `wait`. Only then does a
 * dismissal apply, and only then is the fleet counted.
 */
export function onboardingVerdict({
  machineState,
  dismissed,
  requested,
}: OnboardingInputs): OnboardingVerdict {
  if (requested) return 'show';
  if (machineState === null) return 'wait';
  if (dismissed) return 'hide';
  return serverRows(machineState).length === 0 ? 'show' : 'hide';
}

/**
 * The live step for a connection phase.
 *
 * Only `connected` reaches the pairing step, because pairing is a command and
 * every other phase means no command can be sent. `reconnecting` is treated
 * as `connecting` rather than as a connection with a hiccup: from the wizard's
 * point of view they are the same instruction to the reader, which is to wait
 * for the hub rather than to start typing an address and a token.
 */
export function activeStep(phase: ConnectionPhase): OnboardingStep {
  return phase === 'connected' ? 'pair' : 'connect';
}
