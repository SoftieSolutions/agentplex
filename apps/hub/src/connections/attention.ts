import type { StoreId } from '@agentplex/protocol';
import type { ServerConnectionReport } from './server-connection.js';

/**
 * Which servers' sessions may count toward attention, and which stores that
 * leaves reachable.
 *
 * The rule comes straight out of the connectivity design: an unreachable
 * server's sessions leave the attention count, because a badge you cannot
 * clear by looking is worse than none. A session on a machine the hub cannot
 * reach cannot be opened, cannot be answered, and cannot be acknowledged --
 * counting it produces a number that stays wrong until somebody notices the
 * machine is off, and teaches the operator to ignore the number.
 *
 * It is a pure function of the connection reports rather than a column or a
 * query, and that is the whole design decision here. Attention is a claim about
 * *now* -- this hub, this process, this moment -- and the only thing that knows
 * whether a server is reachable now is the thing holding the socket. A column
 * saying so would be read back after a crash as a live connection that does not
 * exist. What is durable is when a server was last up (see migration `0003`),
 * which is a fact about the past and is what the stale label's age comes from.
 *
 * The reducer in the next milestone is what applies this: it has the sessions,
 * and this says which of them are on a machine anybody can still reach.
 */

/**
 * Whether this server's sessions count.
 *
 * Only a connection the hub is actually holding. `connecting` does not count
 * either: a dial in flight is not evidence of anything, and the honest
 * direction to be wrong in is the one that under-counts. A reconnect that takes
 * a few seconds therefore lowers the count for those seconds -- which is a
 * badge that comes back, rather than one that was never true.
 */
export function countsTowardAttention(report: ServerConnectionReport): boolean {
  return report.phase === 'connected';
}

/**
 * The stores reachable through at least one connected server.
 *
 * A store is one store however many servers have it mounted, so one live
 * server is enough for its sessions to count even when another server holding
 * the same volume is stale. That follows from session identity being
 * `{ storeId, sessionId }` and never the machine: the sessions are the same
 * sessions, and if any server can reach them they can be answered.
 */
export function attentionEligibleStores(
  reports: readonly ServerConnectionReport[],
): ReadonlySet<StoreId> {
  const eligible = new Set<StoreId>();
  for (const report of reports) {
    if (!countsTowardAttention(report)) continue;
    for (const storeId of report.stores) eligible.add(storeId);
  }
  return eligible;
}

/**
 * The stores the hub knows of but currently cannot reach: every store on a
 * stale server that no connected server also has mounted.
 *
 * The other half of the same fact, and worth its own name because it is what a
 * listing shows rather than what a count excludes -- these are the stores whose
 * rows are still there and must be labelled with their age instead of being
 * presented as current.
 */
export function unreachableStores(
  reports: readonly ServerConnectionReport[],
): ReadonlySet<StoreId> {
  const eligible = attentionEligibleStores(reports);
  const unreachable = new Set<StoreId>();
  for (const report of reports) {
    if (countsTowardAttention(report)) continue;
    for (const storeId of report.stores) {
      if (!eligible.has(storeId)) unreachable.add(storeId);
    }
  }
  return unreachable;
}
