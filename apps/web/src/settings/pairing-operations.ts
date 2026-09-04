import type { ServerRegistrationId } from '@agentplex/protocol';
import type { PairingRequest } from './pairing-form.js';

/**
 * The seam between the settings screen and whatever will one day carry a
 * pairing to the hub.
 *
 * The hub has the whole pairing surface server-side — registerServer,
 * revokeServer, the handshake — but as of protocol version 4 nothing
 * client-reachable drives it: the client frame union has no pair or unpair
 * frame and the HTTP surface is the health check and the ticket exchange.
 * Inventing a frame the protocol does not define is exactly what this
 * codebase's rules forbid, so the screen talks to this interface instead,
 * and the one implementation below refuses honestly, in words the screen
 * shows verbatim.
 *
 * When the hub grows the operation (its own ticket), the real implementation
 * replaces `createBrowserPairingOperations` and nothing in the screen moves.
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
 * Refusal in words, not silence: a button that does nothing reads as broken,
 * and a button that pretends the pairing happened over-claims. The reason
 * names what is missing so the words stay true when a user reads them off a
 * released build.
 */
const NOT_YET =
  'this hub build has no client-reachable pairing operation yet; ' +
  'nothing was sent, and the pairing must be made on the hub itself';

export function createBrowserPairingOperations(): PairingOperations {
  return {
    pairServer: () => Promise.resolve({ ok: false, reason: NOT_YET }),
    unpairServer: () => Promise.resolve({ ok: false, reason: NOT_YET }),
  };
}
