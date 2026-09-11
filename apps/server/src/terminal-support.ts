import { NODE_PTY_REMEDY, type PtyAvailability } from '@agentplex/pty';

/**
 * Whether this installation can open a pseudoterminal, asked before the server
 * claims to be starting.
 *
 * A server exists to run sessions through a pty. node-pty is an optional
 * dependency of the published package -- a hub never opens one and should not
 * need a C++ toolchain to install a program it does not run -- and npm exits 0
 * when an optional dependency's build is skipped or fails. So the machine this
 * runs on may have everything else and not that, and the failure has to be a
 * sentence rather than a resolver stack out of the middle of a native addon.
 *
 * Pure, and separate from `main`, so that what an operator reads is a value a
 * test can assert on. `main` decides when to ask; this decides what the answer
 * means.
 */

/**
 * The addon is not there and restarting will not put it there.
 *
 * The same code `main` uses for a configuration it cannot accept, because it is
 * the same statement to a supervisor: the operator must act. `install.sh`
 * writes `RestartPreventExitStatus=2` into the unit, so this is what stops
 * systemd retrying a machine that cannot be fixed by trying again.
 */
export const EXIT_UNUSABLE_INSTALLATION = 2;

/** What to print and what to exit with, or `null` when there is nothing to refuse. */
export interface StartupRefusal {
  readonly lines: readonly string[];
  readonly exitCode: number;
}

export function refuseWithoutTerminals(availability: PtyAvailability): StartupRefusal | null {
  if (availability.usable) return null;

  return {
    lines: [
      `agentplex server: ${availability.problem}`,
      'agentplex server: every session this server runs is driven through a pseudoterminal, ' +
        'so it will not start without one.',
      `agentplex server: ${NODE_PTY_REMEDY}`,
    ],
    exitCode: EXIT_UNUSABLE_INSTALLATION,
  };
}
