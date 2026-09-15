import { z } from 'zod';
import type { ServerId, ServerRegistrationId, StoreDescriptor } from '@agentplex/protocol';
import type { Clock, IdGenerator, Logger } from '@agentplex/node-shared';
import type { StoreFileSystem } from '@agentplex/providers';
import type { Database } from '../../db/database.js';
import { registerLocalServer } from './local-server.js';
import { recordHandshake } from './record-handshake.js';
import { addressProblem } from './server-address.js';
import {
  listServers,
  serverTokenSchema,
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
 * The address parser lives here rather than beside the column parser because
 * it is the feature's input: an address is a word a person typed into a form,
 * and what the feature accepts is the entry file's to say. The column's own
 * parser, with its loopback allowance, stays internal in `server-address.ts`.
 */

/**
 * The address the hub dials a paired server at.
 *
 * This is a word typed by a person into a form, so it goes through a parser
 * that can say no rather than being carried around as a string that everything
 * downstream hopes is a URL. The brand is what makes that unskippable: nothing
 * can be registered or dialled without having come through here.
 *
 * The protocol is transport-agnostic on purpose -- public DNS, a Tailscale
 * name, an SSH-tunnelled port are all the same to it -- so the rules are about
 * the URL and never about the route. `server-address.ts` holds them.
 */
export const serverAddressSchema = z
  .string()
  .trim()
  .superRefine((text, context) => {
    const problem = addressProblem(text, false);
    if (problem !== null) context.addIssue({ code: 'custom', message: problem });
  })
  .brand<'ServerAddress'>();

export type ServerAddress = z.infer<typeof serverAddressSchema>;

/** What a pairing form submits. The address is parsed, never taken on trust. */
export const newServerRegistrationSchema = z.object({
  label: z.string().trim().min(1).max(200),
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

    recordHandshake(
      registrationId: ServerRegistrationId,
      accepted: AcceptedHandshake,
    ): Promise<RecordHandshakeOutcome> {
      return recordHandshake(database, clock, registrationId, accepted);
    },
  };
}
