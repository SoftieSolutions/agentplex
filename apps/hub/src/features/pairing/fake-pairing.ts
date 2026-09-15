import type { ServerRegistrationId } from '@agentplex/protocol';
import type {
  AcceptedHandshake,
  LiveServerRegistration,
  LocalServerEntry,
  NewServerRegistration,
  Pairing,
  RecordHandshakeOutcome,
} from './pairing.js';
import type { RevokedServerRegistration } from './server-registrations.js';

/**
 * The pairing table, in memory, for a suite whose subject is not the table.
 *
 * A real implementation of the seam rather than a mock: what a client
 * connection has to get right is what it does with an outcome -- a registration
 * that now exists, a revocation that found nothing to revoke, a hub that broke
 * on its own side -- and each of those is a value this hands back. The rows
 * themselves are tested where they live, against a migrated schema.
 *
 * Nothing here parses. `newServerRegistrationSchema` is the boundary and it has
 * already run by the time a caller reaches this, which is the property the
 * suites using this are asserting: a fake that re-checked the address would let
 * a connection that skipped the parser pass its own tests.
 */
export interface FakePairing extends Pairing {
  /** What has been registered, in the order it was, tokens included. */
  readonly registered: readonly NewServerRegistration[];
  /** Every id `revoke` was called with, whether or not one was found. */
  readonly revoked: readonly ServerRegistrationId[];
  /** Makes the next call of either throw, as a database under a busy lock does. */
  failWith(error: Error | null): void;
}

export interface FakePairingOptions {
  /** Rows this hub already has. Empty is a fresh hub, which is most of them. */
  readonly servers?: readonly LiveServerRegistration[];
  readonly ids?: () => ServerRegistrationId;
}

export function createFakePairing(options: FakePairingOptions = {}): FakePairing {
  const rows = new Map<ServerRegistrationId, LiveServerRegistration>(
    (options.servers ?? []).map((registration) => [registration.id, registration]),
  );
  const registered: NewServerRegistration[] = [];
  const revoked: ServerRegistrationId[] = [];
  let minted = 0;
  let failure: Error | null = null;

  const nextId =
    options.ids ??
    ((): ServerRegistrationId => `registration-${(minted += 1)}` as ServerRegistrationId);

  function refuseIfFailing(): void {
    if (failure !== null) throw failure;
  }

  return {
    async registerLocalServer(_entry: LocalServerEntry | null): Promise<void> {
      // The one pairing nobody types, and not this fake's subject.
    },

    async listServers(): Promise<readonly LiveServerRegistration[]> {
      refuseIfFailing();
      return [...rows.values()];
    },

    async register(registration: NewServerRegistration): Promise<LiveServerRegistration> {
      refuseIfFailing();
      registered.push(registration);
      const recorded: LiveServerRegistration = {
        id: nextId(),
        label: registration.label,
        address: registration.address,
        serverId: null,
        createdAt: 0,
        lastConnectedAt: null,
        token: registration.token,
        revokedAt: null,
      };
      rows.set(recorded.id, recorded);
      return recorded;
    },

    async revoke(registrationId: ServerRegistrationId): Promise<RevokedServerRegistration | null> {
      refuseIfFailing();
      revoked.push(registrationId);
      const row = rows.get(registrationId);
      if (row === undefined) return null;
      rows.delete(registrationId);
      // The token goes with the revocation, here as in the table: a secret that
      // can no longer authenticate anything should not still be readable.
      return { ...row, token: null, revokedAt: 1 };
    },

    async recordHandshake(
      _registrationId: ServerRegistrationId,
      _accepted: AcceptedHandshake,
    ): Promise<RecordHandshakeOutcome> {
      return { kind: 'recorded', stores: [] };
    },

    failWith(error: Error | null): void {
      failure = error;
    },

    get registered(): readonly NewServerRegistration[] {
      return registered;
    },

    get revoked(): readonly ServerRegistrationId[] {
      return revoked;
    },
  };
}
