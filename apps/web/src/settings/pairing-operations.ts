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

/**
 * The words a refusal carries, whoever produced them.
 *
 * Both operations refuse the same way — the hub's sentence, or the store's own
 * "there is nothing to send this on" — so the shape is shared and only the
 * "yes" differs between them.
 */
interface PairingRefusal {
  readonly ok: false;
  readonly reason: string;
}

/**
 * Pairing said yes, and names the registration the hub recorded.
 *
 * The id is the answer's one piece of news. Whoever submitted the form has the
 * label, the address and the token already; what they cannot know is which row
 * in the next machine state is theirs, and the wizard has to point at it the
 * moment that state lands rather than matching on an address the user typed.
 */
export type PairingOutcome =
  { readonly ok: true; readonly registrationId: ServerRegistrationId } | PairingRefusal;

/**
 * Unpairing said yes, and carries nothing.
 *
 * Nothing to carry: the caller named the registration, and the row leaving the
 * next machine state is the whole result.
 */
export type UnpairingOutcome = { readonly ok: true } | PairingRefusal;

export interface PairingOperations {
  /** Asks the hub to pair a server: dial this address with this token. */
  pairServer(request: PairingRequest): Promise<PairingOutcome>;
  /** Asks the hub to revoke one pairing — its token dies with it. */
  unpairServer(registrationId: ServerRegistrationId): Promise<UnpairingOutcome>;
}

/**
 * The one implementation, over a live hub store.
 *
 * A refusal collapses to words, which is all the screen draws of one. A
 * pairing's "yes" keeps the registration id the hub replied with, because the
 * row arrives in the next machine state keyed by that id and a caller with no
 * id has nothing to recognise it by: the wizard advances by finding that one
 * row, and the alternative is matching on the address the user typed, which is
 * a guess the moment two servers share one.
 *
 * The store's outcome covers both replies a request can earn, so the "yes"
 * branch still checks which one arrived. No hub answers a pairing with an
 * unpairing, and if one did the honest answer is words rather than a
 * registration id nobody was told.
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
      if (!outcome.ok) return { ok: false, reason: outcome.reason };
      if (outcome.reply.type !== 'server-paired') {
        return { ok: false, reason: 'The hub did not answer the pairing. Nothing was recorded.' };
      }
      return { ok: true, registrationId: outcome.reply.registrationId };
    },

    async unpairServer(registrationId: ServerRegistrationId): Promise<UnpairingOutcome> {
      const outcome = await store.request({ type: 'server-unpair', registrationId });
      return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
    },
  };
}
