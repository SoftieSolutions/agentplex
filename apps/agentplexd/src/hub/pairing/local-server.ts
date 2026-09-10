import type { ServerId } from '@agentplex/protocol';
import { type Clock, type IdGenerator, type Logger, tokenMatches } from '@agentplex/node-shared';
import { readServerIdentity, type StoreFileSystem } from '@agentplex/providers';
import type { Queryable } from '../db/database.js';
import { loopbackServerAddress, type ServerAddress } from './server-address.js';
import {
  listServers,
  reconcileServerRegistration,
  recordServerIdentity,
  registerServer,
  serverTokenSchema,
  type ServerRegistration,
} from './server-registrations.js';

/**
 * Pairing the local server: the one pairing nobody types.
 *
 * `2026-09-01` says "pairing is always the user typing that server's token into
 * the hub", and this file is a deliberate, narrow exception to it: **a server on
 * the same host, reached over the loopback, named in the hub's own settings**.
 * When a hub and a server share a machine the hub dials its own server over
 * `127.0.0.1`, so a pairing has to exist, and the hub writes its own end at
 * boot from the token setup already wrote into the server's identity file.
 *
 * The rule exists because a hub that trusts a machine it was not told to trust
 * is a hub anyone on the network can attach to. None of that applies to a
 * server the operator installed beside the hub and then named in the hub's
 * settings. Making somebody hand-pair their own box would be ceremony with no
 * security value, and ceremony with no value is how a security rule gets a
 * reputation for being worth working around.
 *
 * So the exception has to stop where it says it does, and the code has to be
 * what stops it rather than a comment asking somebody to. Four bounds, each
 * structural (AGX-75, moved here from setup by AGX-95):
 *
 * - **Loopback, not an address.** The hub takes a port, and the address comes
 *   from `loopbackServerAddress(port)`, which has nowhere to put a host.
 *   `serverAddressSchema` -- the parser every typed address goes through --
 *   still refuses `ws://` outright, so the plaintext loopback address cannot be
 *   reached from a pairing form, a beacon, or a plan.
 * - **A file, not a claim.** The token comes off the identity file through
 *   `readServerIdentity`, the same parser the server reads it with, and one
 *   that cannot write. Nothing arrives over a socket, and what the hub is
 *   given is exactly what the operator would have typed.
 * - **Configuration, not discovery.** The entry is a setting the operator's
 *   setup run wrote: `LocalServerEntry` is a field of the hub's parsed
 *   configuration and nothing else constructs one. A hub with no such setting
 *   registers nothing, and no other path can add one.
 * - **Idempotent.** A second boot finds the row and leaves it. A re-run of
 *   setup that minted a new token is reconciled at the next boot, and the
 *   reconciliation is logged. A pairing the operator revoked is left revoked:
 *   a revocation is a person having said no, and a boot that undid it would be
 *   the hub choosing.
 */

/**
 * The local server, as the hub's settings name it.
 *
 * Two facts and no more: where the identity file is, and which port the server
 * binds. Produced by the config parser from the two settings setup wrote, and
 * by nothing else; see the third bound above.
 */
export interface LocalServerEntry {
  readonly identityPath: string;
  readonly port: number;
}

/**
 * What the hub calls the server it shares a machine with.
 *
 * A label is what somebody reads in a listing beside the servers they paired by
 * hand, and from the hub's own screen this one really is this machine.
 */
export const LOCAL_SERVER_LABEL = 'this machine';

/**
 * A pairing that may be written without a token being typed.
 *
 * Constructed only by `localServerPairing`, which is where every bound above is
 * checked. A value of this type is therefore the evidence that the exception
 * applies, rather than a request to apply it.
 */
export interface LocalServerPairing {
  readonly label: string;
  /** Always `ws://127.0.0.1:<port>`: built from a port, never taken from a caller. */
  readonly address: ServerAddress;
  readonly serverId: ServerId;
  /** Read off the identity file. Never logged, never printed, never in an outcome. */
  readonly token: string;
  /** The file it was read from, which is what a log line is allowed to name. */
  readonly identityPath: string;
}

export type LocalServerDecision =
  | { readonly ok: true; readonly pairing: LocalServerPairing }
  /** Why the exception does not apply, in words an operator can act on. */
  | { readonly ok: false; readonly reason: string };

/**
 * Whether this entry names a server the hub may pair without a token being
 * typed, and with what.
 *
 * Every refusal is a sentence rather than a silence: an operator whose settings
 * name a local server is entitled to know which of the bounds their entry fell
 * outside of.
 */
export async function localServerPairing(
  entry: LocalServerEntry,
  files: StoreFileSystem,
): Promise<LocalServerDecision> {
  const address = loopbackServerAddress(entry.port);
  if (address === null) {
    return { ok: false, reason: `${entry.port} is not a port a hub could dial` };
  }

  const identity = await readServerIdentity(entry.identityPath, files);
  if (identity === null) {
    return {
      ok: false,
      reason: `there is no server identity at ${entry.identityPath}: this machine has no token to pair with`,
    };
  }
  if (!identity.ok) return { ok: false, reason: identity.problem };

  // The hub's own parser for the word it will hold as a credential, applied
  // before the word becomes one. The file has already been through the identity
  // parser; this is the boundary the hub stops trusting claims at, and a
  // pairing that skipped it would be the one place a token reached a row
  // unparsed.
  const token = serverTokenSchema.safeParse(identity.identity.token);
  if (!token.success) {
    return {
      ok: false,
      reason: `the token in ${entry.identityPath} is not one a hub could present`,
    };
  }

  return {
    ok: true,
    pairing: {
      label: LOCAL_SERVER_LABEL,
      address,
      serverId: identity.identity.serverId,
      token: token.data,
      identityPath: entry.identityPath,
    },
  };
}

/** Which of a row's three facts a reconciliation had to change. */
export type ReconciledFact = 'address' | 'token' | 'serverId';

/**
 * What a boot did about the local server.
 *
 * No branch carries the token, for the reason `ServerIdentityResult` does not:
 * these are logged, and a log is a scrollback.
 */
export type LocalServerOutcome =
  | { readonly kind: 'registered'; readonly address: ServerAddress; readonly identityPath: string }
  | { readonly kind: 'unchanged'; readonly address: ServerAddress; readonly identityPath: string }
  | {
      readonly kind: 'reconciled';
      readonly address: ServerAddress;
      readonly identityPath: string;
      readonly changed: readonly ReconciledFact[];
    }
  /** A pairing for this server was there, and this boot was not allowed to touch it. */
  | {
      readonly kind: 'left-alone';
      readonly address: ServerAddress;
      readonly identityPath: string;
      readonly problem: string;
    };

/**
 * Writes the hub's end, or brings the one that is there up to date.
 *
 * Reconciling rather than duplicating: a hub that restarts must leave one
 * machine on the operator's screen and not two, and a hub whose setup was run
 * again must dial with the token the server now holds rather than the one it
 * held last month. Three facts can drift -- the port setup was given, the token
 * a re-minted identity file holds, and the server id that came with it -- and
 * each is brought to what the file and the settings say.
 *
 * A revoked pairing is the one thing left exactly as it is. Somebody decided
 * something about this machine that this boot does not know about, and quietly
 * writing it back would be the hub choosing, which is the one thing the
 * exception does not extend to. The fix is named in the outcome: remove the
 * setting, or revoke nothing and let the next boot pair it again.
 */
export async function reconcileLocalServer(
  database: Queryable,
  ids: IdGenerator,
  clock: Clock,
  pairing: LocalServerPairing,
): Promise<LocalServerOutcome> {
  const { address, identityPath } = pairing;

  // Revoked ones included on purpose: a revocation is a person having said no,
  // and a listing that hid it would have this boot say yes again on their
  // behalf.
  const registrations = await listServers(database, { includeRevoked: true });
  const existing = findThisServer(registrations, pairing);

  if (existing === undefined) {
    const registered = await registerServer(database, ids, clock, {
      label: pairing.label,
      address,
      token: pairing.token,
    });
    // The id is written now rather than learned at the first handshake: the
    // file says who this server is with the same authority it says what its
    // token is, and a row that knows the id is found by it on the next boot
    // even if the operator moves the port in between.
    await recordServerIdentity(database, registered.id, pairing.serverId);
    return { kind: 'registered', address, identityPath };
  }

  if (existing.token === null) {
    return {
      kind: 'left-alone',
      address,
      identityPath,
      problem:
        'the pairing for the server on this machine was revoked, and a boot does not restore ' +
        'one: remove the local-server setting, or pair it again from the hub',
    };
  }

  const changed: ReconciledFact[] = [];
  if (existing.address !== address) changed.push('address');
  // `tokenMatches` rather than `===`, though nothing is being authenticated
  // here. There is one way two secrets are compared in this codebase, and a
  // second spelling of it is how that stops being true.
  if (!tokenMatches(existing.token, pairing.token)) changed.push('token');
  // A row that has not learned an id yet is not a disagreement about it: the
  // handshake will record one, and this boot has nothing to correct.
  if (existing.serverId !== null && existing.serverId !== pairing.serverId)
    changed.push('serverId');

  if (changed.length === 0) return { kind: 'unchanged', address, identityPath };

  await reconcileServerRegistration(database, existing.id, {
    address,
    token: pairing.token,
    serverId: pairing.serverId,
  });
  return { kind: 'reconciled', address, identityPath, changed };
}

/**
 * The row that is this machine's server, if there is one.
 *
 * By id first, because an address can change -- the operator moved the server
 * port -- and the machine is still the machine. By the loopback address second:
 * there is one `127.0.0.1:<port>` on this host, so a row holding it is this
 * machine's even when the identity file was minted again and the id moved. A
 * live row wins over a revoked one, because a machine revoked and then paired
 * again is paired.
 */
function findThisServer(
  registrations: readonly ServerRegistration[],
  pairing: LocalServerPairing,
): ServerRegistration | undefined {
  const matches = (registration: ServerRegistration): boolean =>
    registration.serverId === pairing.serverId || registration.address === pairing.address;
  return (
    registrations.find((registration) => registration.token !== null && matches(registration)) ??
    registrations.find(matches)
  );
}

export interface LocalServerDependencies {
  readonly database: Queryable;
  readonly files: StoreFileSystem;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * The boot step: the decision, the row, and a line in the log saying which.
 *
 * `null` for a hub with no local-server setting, which registers nothing and
 * says nothing, because most hubs are that hub. A decision that refuses, and a
 * database that will not take the row, are each one log line and never a
 * failed boot: a hub that is up without its local server is a hub an operator
 * can read the log of, and one that is down is not.
 */
export async function registerLocalServer(
  entry: LocalServerEntry | null,
  { database, files, ids, clock, logger }: LocalServerDependencies,
): Promise<LocalServerOutcome | null> {
  if (entry === null) return null;

  const decision = await localServerPairing(entry, files);
  if (!decision.ok) {
    logger.warn('local server not paired', {
      identityPath: entry.identityPath,
      port: entry.port,
      reason: decision.reason,
    });
    return null;
  }

  const { pairing } = decision;
  let outcome: LocalServerOutcome;
  try {
    outcome = await reconcileLocalServer(database, ids, clock, pairing);
  } catch (error) {
    logger.error('local server not paired', {
      identityPath: pairing.identityPath,
      address: pairing.address,
      error: String(error),
    });
    return null;
  }

  const fields = { address: outcome.address, identityPath: outcome.identityPath };
  switch (outcome.kind) {
    case 'registered':
      logger.info('local server paired', fields);
      break;
    case 'unchanged':
      logger.info('local server already paired', fields);
      break;
    case 'reconciled':
      logger.info('local server pairing reconciled', { ...fields, changed: outcome.changed });
      break;
    case 'left-alone':
      logger.warn('local server pairing left alone', { ...fields, problem: outcome.problem });
      break;
  }
  return outcome;
}
