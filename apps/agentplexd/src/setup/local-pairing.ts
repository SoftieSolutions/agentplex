import type { ServerId } from '@agentplex/protocol';
import type { Role } from '../config/config.js';
import type { Queryable } from '../hub/db/database.js';
import { loopbackServerAddress, type ServerAddress } from '../hub/pairing/server-address.js';
import {
  listServers,
  registerServer,
  serverTokenSchema,
  type ServerRegistration,
} from '../hub/pairing/server-registrations.js';
import { readServerIdentity } from '../server/server-identity.js';
import type { StoreFileSystem } from '../server/store-identity.js';
import type { Clock } from '../shared/clock.js';
import type { IdGenerator } from '../shared/ids.js';
import { tokenMatches } from '../shared/tokens.js';

/**
 * Pairing the local server: the one pairing nobody types.
 *
 * `2026-09-01` says "pairing is always the user typing that server's token into
 * the hub", and this file is a deliberate, narrow exception to it: **the same
 * operator, on the same host, within a single interactive setup run, for a
 * server reached over the loopback**. In `--role=both` the hub dials its own
 * server over `127.0.0.1`, so a pairing has to exist, and setup writes both ends
 * -- the token into the identity file, the row into the hub's database.
 *
 * The rule exists because a hub that trusts a machine it was not told to trust
 * is a hub anyone on the network can attach to. None of that applies to a
 * process the operator is installing beside the hub at that moment. Making
 * somebody hand-pair their own box would be ceremony with no security value, and
 * ceremony with no value is how a security rule gets a reputation for being
 * worth working around.
 *
 * So the exception has to stop where it says it does, and the code has to be
 * what stops it rather than a comment asking somebody to. Four bounds, each
 * structural:
 *
 * - **Loopback, not an address.** The address comes from
 *   `loopbackServerAddress(port)`, which takes a port and has nowhere to put a
 *   host. `serverAddressSchema` -- the parser every typed address goes through --
 *   still refuses `ws://` outright, so the plaintext loopback address cannot be
 *   reached from a pairing form, a beacon, or a plan.
 * - **One process, not one network.** `localPairingFor` refuses any role but
 *   `both`. A `--role=server` machine is one a hub elsewhere has to be told
 *   about, which is the rule and not the exception.
 * - **Read, never mint.** The token comes off the identity file through
 *   `readServerIdentity`, which cannot write. What the hub is given is exactly
 *   what the operator would have typed, minted once by the apply path from the
 *   injected `TokenMinter` and never printed by anything.
 * - **Interactive, not unattended.** Nothing here is reachable from
 *   `applySetupPlan`: a `SetupPlan` cannot name a hub database, so the replay
 *   path has no database to write a row into and never acquires one. The
 *   unattended tier's sanctioned form is the plan carrying a pre-minted token --
 *   the operator choosing, before the machine existed -- and the hub's end of
 *   that is made by whoever holds the hub.
 *
 * The last one is the one worth being explicit about. Minting a token in an
 * unattended run and then trusting it on the strength of having minted it is the
 * hub choosing rather than the operator, which is the thing the rule is for.
 */

/**
 * What the hub calls the server it shares a process with.
 *
 * A label is what somebody reads in a listing beside the servers they paired by
 * hand, and from the hub's own screen this one really is this machine.
 */
export const LOCAL_SERVER_LABEL = 'this machine';

/**
 * A pairing that may be written without a token being typed.
 *
 * Constructed only by `localPairingFor`, which is where every bound above is
 * checked. A value of this type is therefore the evidence that the exception
 * applies, rather than a request to apply it.
 */
export interface LocalPairing {
  readonly label: string;
  /** Always `ws://127.0.0.1:<port>`: built from a port, never taken from a caller. */
  readonly address: ServerAddress;
  readonly serverId: ServerId;
  /** Read off the identity file. Never logged, never printed, never in an outcome. */
  readonly token: string;
  /** The file it was read from, which is what a report is allowed to name. */
  readonly identityPath: string;
}

/** The run asking, in the terms the bounds are stated in. */
export interface LocalSetupRun {
  /** Only `both` is a hub and a server the operator is installing side by side. */
  readonly role: Role;
  /** The port the server half of this same process will bind. */
  readonly serverPort: number;
  readonly identityPath: string;
}

export type LocalPairingDecision =
  | { readonly ok: true; readonly pairing: LocalPairing }
  /** Why the exception does not apply, in words an operator can act on. */
  | { readonly ok: false; readonly reason: string };

/**
 * Whether this run may pair its own server, and with what.
 *
 * Every refusal is a sentence rather than a silence: an operator who expected
 * their machine to come out paired is entitled to know which of the bounds their
 * run fell outside of.
 */
export async function localPairingFor(
  run: LocalSetupRun,
  files: StoreFileSystem,
): Promise<LocalPairingDecision> {
  if (run.role !== 'both') {
    return {
      ok: false,
      reason:
        `a pairing is written without being typed only where the hub and the server are one ` +
        `process on one host, and this run is --role=${run.role}`,
    };
  }

  const address = loopbackServerAddress(run.serverPort);
  if (address === null) {
    return { ok: false, reason: `${run.serverPort} is not a port a hub could dial` };
  }

  const identity = await readServerIdentity(run.identityPath, files);
  if (identity === null) {
    return {
      ok: false,
      reason: `there is no server identity at ${run.identityPath}: this machine has no token to pair with`,
    };
  }
  if (!identity.ok) return { ok: false, reason: identity.problem };

  // The hub's own parser for the word it will hold as a credential, applied
  // before the word becomes one. The file has already been through the identity
  // parser; this is the boundary the *hub* stops trusting claims at, and a
  // pairing that skipped it would be the one place a token reached a row
  // unparsed.
  const token = serverTokenSchema.safeParse(identity.identity.token);
  if (!token.success) {
    return { ok: false, reason: `the token in ${run.identityPath} is not one a hub could present` };
  }

  return {
    ok: true,
    pairing: {
      label: LOCAL_SERVER_LABEL,
      address,
      serverId: identity.identity.serverId,
      token: token.data,
      identityPath: run.identityPath,
    },
  };
}

/**
 * What recording one did.
 *
 * No branch carries the token, for the reason `ServerIdentityReport` does not:
 * these are printed to a terminal, and a terminal is a scrollback.
 */
export type LocalPairingOutcome =
  | { readonly kind: 'paired'; readonly address: ServerAddress; readonly identityPath: string }
  | {
      readonly kind: 'already-paired';
      readonly address: ServerAddress;
      readonly identityPath: string;
    }
  /** A pairing for this server was already there and was not this one. */
  | { readonly kind: 'left-alone'; readonly problem: string };

/**
 * Writes the hub's end, unless the hub already has one for this server.
 *
 * Reconciling rather than duplicating, like every other step of setup: running
 * setup twice must leave one machine on the operator's screen and not two.
 *
 * Anything that is already there is left exactly as it is, including a pairing
 * whose token disagrees and a pairing that was revoked. Both mean somebody
 * decided something about this machine that this run does not know about --
 * a re-pair after a token was rotated, a machine deliberately taken off the hub
 * -- and quietly overwriting either would be the hub choosing, which is the one
 * thing the exception does not extend to.
 */
export async function recordLocalPairing(
  database: Queryable,
  ids: IdGenerator,
  clock: Clock,
  pairing: LocalPairing,
): Promise<LocalPairingOutcome> {
  // Revoked ones included on purpose: a revocation is a person having said no,
  // and a listing that hid it would have setup say yes again on their behalf.
  const registrations = await listServers(database, { includeRevoked: true });
  const existing = registrations.find((registration) => isThisServer(registration, pairing));

  if (existing === undefined) {
    await registerServer(database, ids, clock, {
      label: pairing.label,
      address: pairing.address,
      token: pairing.token,
    });
    return { kind: 'paired', address: pairing.address, identityPath: pairing.identityPath };
  }

  if (existing.revokedAt !== null) {
    return {
      kind: 'left-alone',
      problem:
        `the hub holds a revoked pairing for the server on this machine, and setup did not ` +
        `write it back. Pair it again from the hub if that is what you want.`,
    };
  }

  // `tokenMatches` rather than `===`, though nothing is being authenticated
  // here. There is one way two secrets are compared in this codebase, and a
  // second spelling of it is how that stops being true.
  if (existing.address === pairing.address && tokenMatches(existing.token, pairing.token)) {
    return { kind: 'already-paired', address: pairing.address, identityPath: pairing.identityPath };
  }

  return {
    kind: 'left-alone',
    problem:
      `the hub already holds a pairing for the server on this machine, at ${existing.address}, ` +
      `and it was left alone: it may be one somebody made deliberately. It does not match the ` +
      `identity in ${pairing.identityPath}; revoke it in the hub and run setup again to replace it.`,
  };
}

/**
 * Whether a row is this machine's server.
 *
 * By id once the hub has met it, because an address can change -- the operator
 * moved the server port -- and the machine is still the machine. By address
 * before that, which is all a pairing nobody has dialled yet has to go on.
 */
function isThisServer(registration: ServerRegistration, pairing: LocalPairing): boolean {
  return registration.serverId === null
    ? registration.address === pairing.address
    : registration.serverId === pairing.serverId;
}

/**
 * The pairing step as lines a person reads.
 *
 * Beside the decision rather than in the wizard, because what setup is allowed
 * to say about a pairing is part of the same argument as what it is allowed to
 * do: the file is named, the address is named, and the token is neither printed
 * nor asked for.
 */
export function describeLocalPairing(
  outcome: LocalPairingOutcome,
  databasePath: string,
): readonly string[] {
  if (outcome.kind === 'left-alone') return [`This machine was not paired: ${outcome.problem}`];

  const paired =
    outcome.kind === 'paired'
      ? `Paired the server on this machine with the hub on this machine: the hub will dial ` +
        `${outcome.address} with the token in ${outcome.identityPath}. No token was typed, and ` +
        `none was printed.`
      : `The hub on this machine is already paired with the server on it: ${outcome.address}.`;

  return [
    paired,
    // The one way this arrangement fails silently: a row in a database the hub
    // is never started against reads, from the hub, as a machine that is not
    // there. Naming the setting costs a line and is the whole of the fix.
    `Start the hub against that database: --database-file ${databasePath} ` +
      `(AGENTPLEX_DATABASE_FILE).`,
  ];
}
