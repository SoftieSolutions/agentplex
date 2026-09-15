import type { ServerRegistrationId } from '@agentplex/protocol';
import type { Database } from '../../db/database.js';
import type { Clock } from '@agentplex/node-shared';
import { findServer, recordServerConnected, recordServerIdentity } from './server-registrations.js';
import type { AcceptedHandshake, RecordHandshakeOutcome } from './pairing.js';
import { recordStores } from './store-records.js';

/**
 * What a successful handshake changes in the database.
 *
 * The two writes belong together and in one transaction: a pairing that learned
 * a serverId but not its stores, or stores anchored to a pairing that no longer
 * exists, are both states nothing else in the hub knows how to read.
 */

export async function recordHandshake(
  database: Database,
  clock: Clock,
  registrationId: ServerRegistrationId,
  accepted: AcceptedHandshake,
): Promise<RecordHandshakeOutcome> {
  return database.transaction(async (tx) => {
    const existing = await findServer(tx, registrationId);
    if (existing === null || existing.revokedAt !== null) return { kind: 'revoked' };
    if (existing.serverId !== null && existing.serverId !== accepted.serverId) {
      return {
        kind: 'identity-changed',
        paired: existing.serverId,
        presented: accepted.serverId,
      };
    }

    // Recording the identity first is what makes the revoked case above more
    // than a read: this update refuses a row that was revoked between the two
    // statements, so the check and the write cannot disagree.
    const recorded = await recordServerIdentity(tx, registrationId, accepted.serverId);
    if (recorded === null) return { kind: 'revoked' };

    // A handshake that was accepted is a connection that exists, and this is
    // the one moment the hub can say so truthfully. It commits with the
    // identity and the stores because a hub that learned a server's stores but
    // not that it had reached the server would show those stores with no age
    // on them, which is the over-claim the whole stale rule exists to prevent.
    await recordServerConnected(tx, clock, registrationId);

    const stores = await recordStores(
      tx,
      clock,
      accepted.stores.map((store) => store.storeId),
    );
    return { kind: 'recorded', stores };
  });
}
