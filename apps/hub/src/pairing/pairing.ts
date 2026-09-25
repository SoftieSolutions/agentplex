import { z } from 'zod';
import {
  serverAddressSchema,
  serverLabelSchema,
  serverTokenSchema,
  type ServerId,
  type ServerRegistrationId,
  type StoreDescriptor,
} from '@agentplex/protocol';
import type { Clock, IdGenerator, Logger } from '@agentplex/node-shared';
import type { StoreFileSystem } from '@agentplex/providers';
import type { Database } from '../db/database.js';
import { registerLocalServer } from './local-server.js';
import { recordHandshake } from './record-handshake.js';
import {
  listServers,
  registerServer,
  revokeServer,
  type RevokedServerRegistration,
  type liveServerRegistrationSchema,
} from './server-registrations.js';
import type { StoreRecord } from './store-records.js';

/**
 * Pairing: which servers this hub may dial, and with what.
 *
 * The feature owns the `servers` and `stores` tables and everything that
 * writes them -- a pairing the user typed, the one pairing nobody types (the
 * server on this machine), and what a completed handshake records. This file
 * is what the rest of the hub sees of it: the vocabulary below and the
 * `Pairing` seam. The rows themselves are `server-registrations.ts` and
 * `store-records.ts`, and nothing outside this folder reads them directly.
 *
 * What a pairing is made of -- a label, an address, a token -- is
 * `@agentplex/protocol`'s and not this file's, because those words are on the
 * wire in both directions now: they arrive on a `server-pair` frame and the
 * address is published on every `machine-state` row. What stays here is what
 * this feature does with them.
 */

/**
 * What a pairing form submits, as this feature will accept it.
 *
 * Each field goes through the protocol's own parser rather than being taken on
 * trust: the frame that carries a pairing bounds its three fields and rules on
 * nothing else, deliberately, so that a typed address that is not an address
 * comes back as a refusal a person can read rather than as a closed socket.
 * This is where that "no" is decided, and the brand on `address` is the proof
 * it was: nothing can be registered or dialled without having come through
 * here.
 */
export const newServerRegistrationSchema = z.object({
  label: serverLabelSchema,
  address: serverAddressSchema,
  token: serverTokenSchema,
});
export type NewServerRegistration = z.infer<typeof newServerRegistrationSchema>;

/**
 * A pairing the hub may dial: it has a token and has not been revoked. The
 * row parser in `server-registrations.ts` is what guarantees both.
 */
export type LiveServerRegistration = z.infer<typeof liveServerRegistrationSchema>;

/**
 * The local server, as the hub's settings name it.
 *
 * Two facts and no more: where the identity file is, and which port the server
 * binds. Produced by the config parser from the two settings setup wrote, and
 * by nothing else; `local-server.ts` says why that bound matters.
 */
export interface LocalServerEntry {
  readonly identityPath: string;
  readonly port: number;
}

/** What a server said about itself in a handshake the hub accepted. */
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

export interface PairingDependencies {
  readonly database: Database;
  /**
   * The disk the local server's identity file is read from, through the same
   * seam the server reads it with. A test pairs a local server from a file it
   * wrote down.
   */
  readonly files: StoreFileSystem;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface Pairing {
  /**
   * The boot step for the server on this machine, if the settings name one.
   * `null` is most hubs: nothing is registered and nothing is said.
   */
  registerLocalServer(entry: LocalServerEntry | null): Promise<void>;
  /**
   * Every pairing the hub may dial, oldest first. Revoked ones are not here:
   * a revoked registration has no token, which is exactly the shape that
   * cannot be dialled, and a caller asking about history is asking a different
   * question.
   */
  listServers(): Promise<readonly LiveServerRegistration[]>;
  /**
   * Records a pairing somebody submitted: this address, this token, called
   * this.
   *
   * It records and nothing more. Whether the machine answers is the dial's to
   * find out, and a register that waited for a handshake before admitting the
   * row would leave a person who typed a correct address for a laptop that is
   * asleep with no pairing and no explanation -- when what they have is a
   * pairing that is fine and a machine that is off.
   */
  register(registration: NewServerRegistration): Promise<LiveServerRegistration>;
  /**
   * Revokes one pairing: its token is cleared and it stops being dialable.
   *
   * `null` when there is no live pairing with that id, which covers both a
   * registration this hub never had and one that was already revoked. Neither
   * is a pairing to end, and a caller that has to tell them apart is asking a
   * question about history rather than making a change.
   */
  revoke(registrationId: ServerRegistrationId): Promise<RevokedServerRegistration | null>;
  /**
   * What a successful handshake changes: the server's identity, when it was
   * last reached, and the stores it reported, in one transaction.
   */
  recordHandshake(
    registrationId: ServerRegistrationId,
    accepted: AcceptedHandshake,
  ): Promise<RecordHandshakeOutcome>;
}

export function createPairing(dependencies: PairingDependencies): Pairing {
  const { database, files, ids, clock, logger } = dependencies;

  return {
    async registerLocalServer(entry: LocalServerEntry | null): Promise<void> {
      await registerLocalServer(entry, { database, files, ids, clock, logger });
    },

    async listServers(): Promise<readonly LiveServerRegistration[]> {
      const registrations = await listServers(database);
      // `listServers` already excludes revoked rows; this narrows the union
      // rather than asserting past it.
      return registrations.filter(
        (registration): registration is LiveServerRegistration => registration.revokedAt === null,
      );
    },

    async register(registration: NewServerRegistration): Promise<LiveServerRegistration> {
      const recorded = await registerServer(database, ids, clock, registration);
      // The label and the hub's own id for the row. Not the token, which is
      // the one credential a client frame carries and is written to exactly
      // one place; not the address either, because a log line about a pairing
      // is read beside one about a dial, and the dial's is the address that
      // matters.
      logger.info('server paired', { registrationId: recorded.id, server: recorded.label });
      return recorded;
    },

    async revoke(registrationId: ServerRegistrationId): Promise<RevokedServerRegistration | null> {
      const revoked = await revokeServer(database, clock, registrationId);
      if (revoked === null) {
        logger.info('nothing to revoke', { registrationId });
        return null;
      }
      logger.info('server unpaired', { registrationId, server: revoked.label });
      return revoked;
    },

    recordHandshake(
      registrationId: ServerRegistrationId,
      accepted: AcceptedHandshake,
    ): Promise<RecordHandshakeOutcome> {
      return recordHandshake(database, clock, registrationId, accepted);
    },
  };
}
