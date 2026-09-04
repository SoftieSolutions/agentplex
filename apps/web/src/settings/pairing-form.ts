import type { MachineState } from '@agentplex/protocol';
import { parseServerAddress } from './server-address.js';

/**
 * What the pairing form collects and how it is checked before anything is
 * submitted. Pairing is always the user typing that server's token into the
 * hub: a name for the row, the address the hub will dial, and the token the
 * server printed.
 */

export interface PairingFormInput {
  readonly name: string;
  readonly address: string;
  readonly token: string;
}

/** One problem per field, in words, or absent when the field is fine. */
export interface PairingFormProblems {
  readonly name?: string;
  readonly address?: string;
  readonly token?: string;
}

/** What a checked form submits. The same shape the hub's pairing table takes. */
export interface PairingRequest {
  readonly label: string;
  readonly address: string;
  readonly token: string;
}

export type PairingFormResult =
  | { readonly ok: true; readonly request: PairingRequest }
  | { readonly ok: false; readonly problems: PairingFormProblems };

/** Matches the hub's own bound on a pairing label. */
const MAX_NAME_LENGTH = 200;

/**
 * Checks the whole form at once, so the user is told every problem in one
 * pass rather than fixing them serially against a form that reveals one "no"
 * at a time.
 */
export function parsePairingForm(input: PairingFormInput): PairingFormResult {
  const problems: { name?: string; address?: string; token?: string } = {};

  const name = input.name.trim();
  if (name.length === 0) problems.name = 'expected a name for this server';
  else if (name.length > MAX_NAME_LENGTH) {
    problems.name = `expected a name of at most ${String(MAX_NAME_LENGTH)} characters`;
  }

  const address = parseServerAddress(input.address);
  if (!address.ok) problems.address = address.reason;

  const token = input.token.trim();
  if (token.length === 0) problems.token = 'expected the token this server printed';

  if (!address.ok || problems.name !== undefined || problems.token !== undefined) {
    return { ok: false, problems };
  }
  return { ok: true, request: { label: name, address: address.value, token } };
}

/**
 * A server the hub has heard announce itself on the network: a candidate, not
 * a pairing. The shape deliberately has no token field — a beacon never
 * carries one, and a candidate that could pre-fill a token would be trust
 * arriving from the network instead of from the user.
 */
export interface DiscoveredCandidate {
  readonly address: string;
  /** What the beacon says the machine calls itself. Shown, never trusted. */
  readonly label: string | null;
}

/**
 * What selecting a candidate does to the form: it pre-fills the address and
 * stops. The return type is the rule — there is no token here to hand over,
 * and no name either: the beacon's self-description is a hint on the list,
 * not a value typed into the user's form on their behalf.
 */
export function prefillFromCandidate(candidate: DiscoveredCandidate): { readonly address: string } {
  return { address: candidate.address };
}

/**
 * The candidates the hub has reported, read out of the machine state.
 *
 * The machine-state frame carries no discovery field today — LAN beacon
 * discovery is milestone 7 — so this is always empty, and the settings screen
 * draws no candidates section at all: a control with zero options is not
 * drawn. When the hub starts publishing candidates, this is the one place
 * that learns to read them.
 */
export function discoveredCandidates(_state: MachineState | null): readonly DiscoveredCandidate[] {
  return [];
}
