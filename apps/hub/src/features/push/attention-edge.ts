import { wantsAttention, type ApprovalId, type StoreId } from '@agentplex/protocol';
import type { Logger } from '@agentplex/node-shared';
import type { HubStateSnapshot, SessionRow } from '../fleet-state/fleet-state.js';
import type { PushEvent } from './push.js';

/**
 * The needs-you edge: the moment a session starts wanting a human.
 *
 * ## Why this is a listener and not a method on the fleet state
 *
 * The reducer already tells everything that cares when the state changed --
 * that is the seam the client broadcast stands on -- and an edge is a
 * comparison of two of those snapshots. Adding a `onNeedsYou` callback to the
 * reducer would put push's rule inside the one feature that must not know push
 * exists: the fleet state is what every other feature reads, and an import in
 * that direction is what turns a merge into something you cannot change
 * without thinking about notifications. So this is an ordinary subscriber, and
 * the reducer is unchanged.
 *
 * ## Why it remembers, and what it remembers
 *
 * `wantsAttention` is a fact about a snapshot, and a fact is true in every
 * snapshot that follows until something changes it. Sending on the fact rather
 * than on the change would push on every report a server makes -- once every
 * few seconds, for as long as somebody leaves a prompt unanswered.
 *
 * What is remembered is `{ storeId, sessionId, descriptor.updatedAt }`, and
 * the third part is the whole of why this is not a set of session ids. The
 * rule reads `reachable`, so a machine flapping in and out of reach takes a
 * session out of the rule and puts it back unchanged: keyed on the session
 * alone, a laptop closing its lid would ring somebody's phone about a prompt
 * they already saw. `updatedAt` is what the provider wrote into the
 * transcript, so it moves for a new prompt and for nothing else. One prompt is
 * one push.
 *
 * The same key is what makes a mute reversible without being noisy: unmuting a
 * session whose prompt has not changed is not news, so nothing is sent.
 *
 * ## The boot storm
 *
 * A hub restarts and everything replays at once. `attention.load()` puts every
 * mute and acknowledgement back before a single server has been dialled, and
 * then `servers.sync()` dials them all and their first reports arrive; every
 * one of those publishes a snapshot. A detector that subscribed cold would
 * read a dozen sessions that had been waiting for hours as a dozen edges, and
 * push all of them, to every browser, on every restart -- which is the failure
 * that makes people turn notifications off and never turn them back on.
 *
 * So a store is *seeded*: the first snapshot that says what is in it is taken
 * as the starting position and nothing in it is news. What comes after is.
 *
 * Seeded on the first snapshot carrying sessions rather than on the first
 * mentioning the store, because those are not the same moment: a connection
 * lands first and creates the store view with an empty session list, and the
 * report that fills it is the snapshot after. Seeding on the earlier one would
 * seed nothing and then read the whole store as news, which is the storm this
 * exists to stop.
 *
 * The cost is the one case in the other direction: the very first session ever
 * reported in a store is seeded rather than sent, even if it arrives already
 * waiting. That is a silence where a notification might have been welcome, and
 * it is the direction to be wrong in -- the in-page floor still shows it, and
 * the alternative is a hub that shouts every time it starts.
 *
 * ## The other edge: a run waiting on a person
 *
 * A graph run reaching a HUMAN node is the second thing worth a lock screen,
 * and it is read off `graphRunApprovals` rather than any row. Its rule is
 * simpler. A request is news exactly once, when its id first appears, and
 * there is no seeding: a hub restart ends every run it had, so nothing can be
 * waiting before the detector watches, and the first list that carries a
 * request carries a new one. What leaves is the run number and the node's
 * label; the request's proposal, which names who was asked, stays here.
 */
export interface AttentionEdgeDependencies {
  /**
   * Where an edge goes. Injected rather than the push feature itself, because
   * what this file decides is *when*, and everything about *who* and *what is
   * said* is the other half's -- which is also what lets this be tested
   * without a database, a key pair or a push service.
   */
  readonly notify: (event: PushEvent) => void;
  readonly logger: Logger;
}

export interface AttentionEdge {
  /** One snapshot. Safe to hand straight to `FleetState.subscribe`. */
  observe(snapshot: HubStateSnapshot): void;
}

/** One session's key in the remembered map. Two ids that are already strings. */
function sessionKey(row: SessionRow): string {
  return `${row.ref.storeId}\u0000${row.ref.sessionId}`;
}

export function createAttentionEdge({
  notify,
  logger: parent,
}: AttentionEdgeDependencies): AttentionEdge {
  const logger = parent.child({ part: 'push-edge' });

  /** The stores whose starting position has been taken. */
  const seeded = new Set<StoreId>();
  /**
   * Per session, the `updatedAt` this hub has already had its say about --
   * either because it pushed for it, or because it was the reading in the
   * snapshot that seeded the store.
   */
  const spokenFor = new Map<string, number>();
  /** The requests runs have raised that this hub has already said something about. */
  const runsSpokenFor = new Set<ApprovalId>();

  return {
    observe(snapshot: HubStateSnapshot): void {
      const present = new Set<string>();
      const stores = new Set<StoreId>();

      const waitingNow = new Set<ApprovalId>();
      for (const waiting of snapshot.graphRunApprovals) {
        const approvalId = waiting.approval.approvalId;
        waitingNow.add(approvalId);
        if (runsSpokenFor.has(approvalId)) continue;
        runsSpokenFor.add(approvalId);
        logger.debug('a run newly waits on a human', {
          graph: waiting.graph,
          number: waiting.number,
        });
        // The number and the label, assembled here: the proposal names the
        // approvers and may quote more, and this is the boundary it stops at.
        notify({
          kind: 'graphRun',
          graph: waiting.graph,
          number: waiting.number,
          node: waiting.nodeLabel,
        });
      }
      for (const approvalId of runsSpokenFor) {
        if (!waitingNow.has(approvalId)) runsSpokenFor.delete(approvalId);
      }

      for (const store of snapshot.stores) {
        stores.add(store.storeId);
        // An empty store is not a starting position, it is a store nobody has
        // reported on yet. See the header for why the difference matters.
        const seeding = store.sessions.length > 0 && !seeded.has(store.storeId);
        if (seeding) seeded.add(store.storeId);

        for (const row of store.sessions) {
          const key = sessionKey(row);
          present.add(key);
          const updatedAt = row.descriptor.updatedAt;

          if (seeding) {
            // Every session, not only the waiting ones: what is being recorded
            // is the reading this hub came up on, and a session that is
            // working now will move `updatedAt` before it can ask for
            // anything.
            spokenFor.set(key, updatedAt);
            continue;
          }

          if (
            !wantsAttention({
              descriptor: row.descriptor,
              reachable: row.reachable,
              acknowledgedThrough: row.attention.acknowledgedThrough,
              mutedAt: row.attention.mutedAt,
            })
          ) {
            continue;
          }
          if (spokenFor.get(key) === updatedAt) continue;

          spokenFor.set(key, updatedAt);
          logger.debug('a session newly wants a human', {
            storeId: row.ref.storeId,
            sessionId: row.ref.sessionId,
          });
          // Four fields, assembled here rather than a row passed along. The
          // descriptor carries a title, a working directory and a branch, and
          // this is the boundary past which none of them may travel: what
          // leaves here is what a lock screen may show.
          notify({
            kind: 'session',
            storeId: row.ref.storeId,
            sessionId: row.ref.sessionId,
            provider: row.descriptor.provider,
            status: row.descriptor.status,
          });
        }
      }

      // Bounded by what the hub currently believes, rather than growing for
      // the life of the process. A session the reducer has forgotten is one a
      // revoked pairing took with it; if it ever comes back it comes back
      // through a store that has to be seeded again, which is the same
      // starting position it would have had at a restart.
      for (const key of spokenFor.keys()) if (!present.has(key)) spokenFor.delete(key);
      for (const storeId of seeded) if (!stores.has(storeId)) seeded.delete(storeId);
    },
  };
}
