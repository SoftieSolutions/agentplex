import type { ServerRegistrationId } from '@agentplex/protocol';
import type { HubStore } from '../store/hub-store.js';
import type { PairingRequest } from './pairing-form.js';

/**
 * Pairing and unpairing, over the socket this page already holds.
 *
 * The screen talks to this interface rather than to the store directly, and
 * the interface is narrower than what it is built on for one reason: what the
 * settings screen does is pair a server and revoke a pairing, and a screen
 * holding the whole store could also start a session or close the connection.
 *
 * Both go out on the store's request path, which never queues. The pairing
 * frame carries the token that server printed -- the one credential a client
 * frame ever carries -- and a queued one would be that secret sitting in this
 * tab's memory waiting for a connection that may never come back, with nobody
 * watching it. So a disconnected page refuses in words the user can read, and
 * the words say that nothing was sent.
 */

export type PairingOutcome =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface PairingOperations {
  /** Asks the hub to pair a server: dial this address with this token. */
  pairServer(request: PairingRequest): Promise<PairingOutcome>;
  /** Asks the hub to revoke one pairing — its token dies with it. */
  unpairServer(registrationId: ServerRegistrationId): Promise<PairingOutcome>;
}

/**
 * The one implementation, over a live hub store.
 *
 * The outcomes collapse to "yes" or "words", which is all the screen draws.
 * The hub's answer to a pairing names the registration it recorded, and this
 * deliberately drops it: the row arrives in the next machine state keyed by
 * that same id, so a screen holding the id would be holding a second copy of
 * something already on its way.
 */
export function createBrowserPairingOperations(store: HubStore): PairingOperations {
  return {
    async pairServer(request: PairingRequest): Promise<PairingOutcome> {
      const outcome = await store.request({
        type: 'server-pair',
        label: request.label,
        address: request.address,
        token: request.token,
      });
      return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
    },

    async unpairServer(registrationId: ServerRegistrationId): Promise<PairingOutcome> {
      const outcome = await store.request({ type: 'server-unpair', registrationId });
      return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
    },
  };
}
