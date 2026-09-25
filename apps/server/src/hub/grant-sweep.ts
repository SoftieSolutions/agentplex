import type { Logger, Timers } from '@agentplex/node-shared';
import type { GrantRefusal, ServerGrantStore } from '@agentplex/providers';
import type { HubAudience } from './hub-audience.js';

/**
 * The half of revocation a handshake cannot do.
 *
 * A revoked hub has to be disconnected rather than left running until it
 * happens to reconnect, and a connection that authenticated an hour ago holds
 * no token to re-present: there is nothing to check it against on the next
 * frame. So the grants are re-read on a timer and every connection whose grant
 * has stopped being usable is closed.
 *
 * **A timer rather than a signal, and rather than a watch on the file.** The
 * operator revokes on this machine, and the mechanism has to work whatever
 * wrote the file -- a command, a configuration manager, an operator with an
 * editor. A filesystem watch would be a fourth thing to get right per platform
 * for a file that changes a handful of times in a server's life, and would still
 * need this loop as its fallback on the platforms where it silently does not
 * fire. What a timer costs is latency, and the latency is bounded and named.
 *
 * **It is not what makes a revocation take effect.** The handshake is: it
 * re-reads the grants file every time, so a hub revoked while disconnected is
 * refused the instant it comes back, with no sweep involved. This closes the
 * connection that is already up, which is the case a handshake cannot reach.
 *
 * The same pass enforces expiry on live connections, for the same reason and at
 * no extra cost: an `expiresAt` that only applied at the handshake would mean a
 * grant minted for a support session outlives the session for as long as the
 * socket stays open.
 */

/**
 * How long a revoked hub may stay connected, at worst.
 *
 * Short enough that "I revoked it" and "it is gone" are the same sentence in a
 * conversation, and long enough that a server with two hubs is not re-reading a
 * small file continuously for years to catch an event that may never happen.
 */
export const GRANT_SWEEP_INTERVAL_MS = 15_000;

export interface GrantSweepDependencies {
  readonly grants: ServerGrantStore;
  readonly audience: HubAudience;
  readonly timers: Timers;
  readonly logger: Logger;
  readonly intervalMs?: number;
}

export interface GrantSweep {
  stop(): void;
}

/**
 * What an authenticated peer is told on its way out.
 *
 * Plainer than `handshake-rejected`, and deliberately so: that frame says
 * nothing because a peer that failed to authenticate must not learn whether its
 * credential was real. This one reaches a connection that already proved it
 * holds the grant, so there is no secret left to keep, and a hub told only that
 * it was closed would retry forever against a server that will never take it.
 */
function departure(refusal: GrantRefusal): string {
  switch (refusal) {
    case 'revoked':
      return 'this grant was revoked';
    case 'expired':
      return 'this grant has expired';
    case 'no-grant':
      return 'this grant no longer exists';
  }
}

/**
 * Starts the sweep. Returns the thing that stops it, which shutdown calls: a
 * timer nobody cancels is a process that will not exit.
 */
export function sweepGrants({
  grants,
  audience,
  timers,
  logger,
  intervalMs = GRANT_SWEEP_INTERVAL_MS,
}: GrantSweepDependencies): GrantSweep {
  let cancel: (() => void) | null = null;
  let stopped = false;

  const schedule = (): void => {
    if (stopped) return;
    cancel = timers.schedule(intervalMs, () => void pass());
  };

  const pass = async (): Promise<void> => {
    const live = audience.grants;
    // Nothing connected is the ordinary state of a server between sessions, and
    // reading a file to learn that would be the one cost this could avoid.
    if (live.length === 0) {
      schedule();
      return;
    }

    try {
      for (const { grantId, refusal } of await grants.refused(live)) {
        const closed = audience.disconnect(grantId, departure(refusal));
        // Loud, because it is a person's decision arriving somewhere: the
        // operator who revoked a grant is entitled to see it take effect, and
        // the one reading the log afterwards is entitled to know why a hub
        // stopped connecting.
        logger.warn('hub connections closed', { grantId, refusal, closed });
      }
    } catch (error) {
      // A sweep that failed costs this pass. Refusing every hub because one
      // read threw would be the outage revocation exists to avoid, and the next
      // pass is fifteen seconds away.
      logger.warn('could not sweep the grants', { problem: String(error) });
    }
    schedule();
  };

  schedule();
  return {
    stop(): void {
      stopped = true;
      cancel?.();
      cancel = null;
    },
  };
}
