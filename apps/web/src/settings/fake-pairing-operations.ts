import type { ServerRegistrationId } from '@agentplex/protocol';
import type { PairingRequest } from './pairing-form.js';
import type { PairingOperations, PairingOutcome, UnpairingOutcome } from './pairing-operations.js';

/**
 * A `PairingOperations` that answers whatever a test hands it and keeps what
 * it was asked.
 *
 * It is here rather than inside a test file because two screens now submit the
 * same form -- settings and the first-run wizard -- and a fake copied into the
 * second would be free to drift from the first: two tests asserting against
 * two different ideas of what pairing does, neither of them the real one. The
 * recording is the point of the seam. What the panel sends is a
 * `PairingRequest` that has been through the form's parser, and `requests` is
 * how a test says "that, once, with the address branded" rather than "some
 * network traffic happened".
 */
export interface FakePairingOperations extends PairingOperations {
  /** Every request the panel submitted, in order. Empty means nothing was sent. */
  readonly requests: readonly PairingRequest[];
  /** Every registration a caller asked to revoke, in order. */
  readonly revocations: readonly ServerRegistrationId[];
}

export interface FakePairingOperationsOptions {
  /** What `pairServer` answers -- the hub's yes, or a refusal in words. */
  readonly answer: PairingOutcome;
  /** What `unpairServer` answers. A yes unless a test is about a refusal. */
  readonly unpairAnswer?: UnpairingOutcome;
}

export function createFakePairingOperations({
  answer,
  unpairAnswer = { ok: true },
}: FakePairingOperationsOptions): FakePairingOperations {
  const requests: PairingRequest[] = [];
  const revocations: ServerRegistrationId[] = [];
  return {
    pairServer(request: PairingRequest): Promise<PairingOutcome> {
      requests.push(request);
      return Promise.resolve(answer);
    },
    unpairServer(registrationId: ServerRegistrationId): Promise<UnpairingOutcome> {
      revocations.push(registrationId);
      return Promise.resolve(unpairAnswer);
    },
    requests,
    revocations,
  };
}
