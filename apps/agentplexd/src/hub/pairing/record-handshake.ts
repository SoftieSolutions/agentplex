import type { ServerId, StoreDescriptor } from '@agentplex/protocol';
import type { Database } from '../db/database.js';
import type { Clock } from '../../shared/clock.js';
import {
  findServer,
  recordServerIdentity,
  type ServerRegistrationId,
} from './server-registrations.js';
import { recordStores, type StoreRecord } from './store-records.js';

/**
 * What a successful handshake changes in the database.
 *
 * The two writes belong together and in one transaction: a pairing that learned
 * a serverId but not its stores, or stores anchored to a pairing that no longer
 * exists, are both states nothing else in the hub knows how to read.
 */

export interface AcceptedHandshake {
  readonly serverId: ServerId;
  readonly stores: readonly StoreDescriptor[];
}

export type RecordHandshakeOutcome =
  | { readonly kind: 'recorded'; readonly stores: readonly StoreRecord[] }
  /**
   * The pairing was revoked while the handshake was in flight. The connection
   * is not one to keep: the user said this server may no longer be dialled,
   * and the fact that it answered does not undo that.
   */
  | { readonly kind: 'revoked' }
  /**
   * The token was presented by a different server than the one this pairing
   * was completed with.
   *
   * Refused rather than recorded, because the alternative is worse in a way
   * nobody would see: silently re-pointing a pairing at a new serverId leaves
   * every placement the hub filed under the old one belonging to nothing, and
   * the user is never told that the box they paired was replaced. A
   * re-provisioned machine is a new pairing, which is a token the user types
   * once and an entry they can see.
   */
  | {
      readonly kind: 'identity-changed';
      readonly paired: ServerId;
      readonly presented: ServerId;
    };

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

    const stores = await recordStores(
      tx,
      clock,
      accepted.stores.map((store) => store.storeId),
    );
    return { kind: 'recorded', stores };
  });
}
