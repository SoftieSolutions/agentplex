import type { ProviderReadiness, SessionDescriptor, SessionHold } from '@agentplex/protocol';
import type { DiscoveredServer } from '../discovery/discovery.js';
import type { ServerConnectionReport } from '../servers/servers.js';

/**
 * When two readings of the same thing are the same reading.
 *
 * The state publishes a version, and every bump is a frame to every attached
 * client. What decides whether to bump is these comparisons, so each one is a
 * statement about what a person can see: a field compared here is a field that
 * wakes every screen when it moves, and a field left out is one that moves
 * without anybody being told. Both mistakes are real -- `heardAt` compared
 * would make a silent network a stream of frames, and a hold left out would
 * leave a stop button on a session that has already ended -- which is why the
 * argument sits beside each function rather than in the reducer that calls it.
 *
 * Field by field rather than by identity, because every one of these values is
 * built fresh on each read.
 */

/**
 * Whether two connectivity reports say the same thing.
 *
 * Field by field rather than by identity, because the supervisor builds a
 * fresh value on every read. The mounted list is compared in order, which is
 * the database's order and stable for the same set of stores.
 */
export function sameConnection(
  left: ServerConnectionReport,
  right: ServerConnectionReport,
): boolean {
  return (
    left.serverId === right.serverId &&
    left.label === right.label &&
    left.address === right.address &&
    left.phase === right.phase &&
    left.connectedSince === right.connectedSince &&
    left.staleSince === right.staleSince &&
    left.lastConnectedAt === right.lastConnectedAt &&
    left.failedAttempts === right.failedAttempts &&
    left.problem === right.problem &&
    left.staleReason === right.staleReason &&
    sameProviders(left.providers, right.providers) &&
    left.stores.length === right.stores.length &&
    left.stores.every((storeId, index) => storeId === right.stores[index])
  );
}

/**
 * Whether a machine is reporting the same providers, in the same states.
 *
 * Compared at all because a provider installed between two connections is a
 * change a client has to see: the settings screen draws these words, and a row
 * that went on saying "claude is missing" after somebody installed it would be
 * exactly the stale claim the age labels exist to prevent.
 */
export function sameProviders(
  left: readonly ProviderReadiness[],
  right: readonly ProviderReadiness[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((readiness, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      readiness.provider === other.provider &&
      readiness.state === other.state &&
      readiness.version === other.version &&
      readiness.directory === other.directory &&
      readiness.problem === other.problem
    );
  });
}

/**
 * Whether the network is saying exactly what it was saying last time.
 *
 * Only the fields a client is shown. `heardAt` moves every five seconds for a
 * machine that has done nothing but still be there, and comparing it would
 * make every announcement a new version and a frame to every attached client.
 * Both lists arrive sorted by server id, so position is comparable.
 */
export function sameCandidates(
  left: readonly DiscoveredServer[],
  right: readonly DiscoveredServer[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((candidate, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      candidate.serverId === other.serverId &&
      candidate.address === other.address &&
      candidate.port === other.port &&
      candidate.protocolVersion === other.protocolVersion
    );
  });
}

/**
 * Whether a server is running exactly what it was running last time.
 *
 * Compared alongside the sessions rather than folded into them, because a hold
 * changing is a change a client must see even when every transcript reads the
 * same: a session that has just been stopped looks identical on disk for as
 * long as it takes the provider to write again, and the stop button has to go
 * away the moment the process does.
 */
export function sameHolds(left: readonly SessionHold[], right: readonly SessionHold[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((hold, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      hold.sessionId === other.sessionId &&
      hold.stoppable === other.stoppable
    );
  });
}

/** Whether a scan found exactly what the previous one did, row for row. */
export function sameSessions(
  left: readonly SessionDescriptor[],
  right: readonly SessionDescriptor[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((descriptor, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      descriptor.sessionId === other.sessionId &&
      descriptor.storeId === other.storeId &&
      descriptor.provider === other.provider &&
      descriptor.status === other.status &&
      descriptor.updatedAt === other.updatedAt &&
      descriptor.cwd === other.cwd &&
      descriptor.title === other.title
    );
  });
}
