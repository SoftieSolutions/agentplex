import type { HubId } from '@agentplex/protocol';
import {
  tokenDigest,
  type Clock,
  type IdGenerator,
  type TokenMinter,
} from '@agentplex/node-shared';
import {
  decideGrant,
  GRANT_ZERO_LABEL,
  grantIdSchema,
  hubIdDisagrees,
  parseServerGrants,
  serializeServerGrants,
  summarizeGrant,
  usableGrant,
  witnessedGrant,
  type GrantFileSystem,
  type GrantId,
  type GrantRefusal,
  type GrantSummary,
  type ServerGrant,
} from './server-grants.js';

/**
 * The grants this server will answer to, as a thing that is read now rather
 * than at boot.
 *
 * That is the whole design decision in this file. A revocation an operator
 * performs has to reach a daemon that is already running -- a record consulted
 * once at startup would mean the only way to withdraw a hub's access is to
 * restart the server, which is the outage revocation exists to avoid. So every
 * authorization re-reads the file. Handshakes are rare, a hub reconnects on a
 * backoff rather than in a loop, and the alternative is a cache with an
 * invalidation rule that is wrong exactly when it matters.
 *
 * Live connections are the other half, and this file cannot do it alone: a
 * connection that authenticated an hour ago holds no token to re-present. What
 * it offers instead is `refused`, which answers "of these grants, which have
 * stopped being usable" in one read, and the server sweeps its connections with
 * it. See `grant-sweep.ts` in the server app.
 *
 * Writes are serialized through one chain. Two handshakes landing together
 * would otherwise read the same file and write back two versions of it, and the
 * loser's record -- a mint, a revocation -- would vanish with no error
 * anywhere. Nothing outside this process is serialized against, which is the
 * honest limit: an operator editing the file by hand while the server runs can
 * still lose a write, and the command that will mint and revoke belongs in the
 * same lock or on the same machine's daemon.
 */

/** What the server learned about a presented token. */
export type AuthorizedGrant =
  | { readonly ok: true; readonly grantId: GrantId; readonly label: string }
  | {
      readonly ok: false;
      /** For a log line and nothing else. The frame says only that it failed. */
      readonly refusal: GrantRefusal;
    };

/**
 * The narrow half a connection needs: turn a token into a grant, or say no.
 *
 * Separate from the store below so that nothing on a socket's path can list,
 * mint or revoke anything, and so that a connection never holds a value that
 * carries a verifier.
 */
export interface GrantAuthority {
  authorize(presented: { readonly token: string; readonly hubId: HubId }): Promise<AuthorizedGrant>;
}

/** A grant that has stopped being usable, and why, as the sweep reads it. */
export interface WithdrawnGrant {
  readonly grantId: GrantId;
  readonly refusal: GrantRefusal;
}

/** A freshly minted grant. The token is here once and is never stored. */
export type MintedGrant =
  | { readonly ok: true; readonly grant: GrantSummary; readonly token: string }
  | { readonly ok: false; readonly problem: string };

export type RevokedGrant =
  | { readonly ok: true; readonly grant: GrantSummary }
  | { readonly ok: false; readonly problem: string };

export type GrantListing =
  | { readonly ok: true; readonly grants: readonly GrantSummary[] }
  | { readonly ok: false; readonly problem: string };

export interface ServerGrantStore extends GrantAuthority {
  /** Every grant, without its verifier, newest last. */
  list(): Promise<GrantListing>;
  /**
   * Mints one, for one hub. The token comes back exactly once: it is printed,
   * typed into that hub, and never readable off this machine again.
   */
  mint(request: {
    readonly label: string;
    readonly expiresAt: number | null;
  }): Promise<MintedGrant>;
  /** Says no to one grant, by name, leaving every other hub working. */
  revoke(grantId: GrantId): Promise<RevokedGrant>;
  /** Of these grants, the ones that may no longer be used. One read. */
  refused(grantIds: readonly GrantId[]): Promise<readonly WithdrawnGrant[]>;
}

export interface ServerGrantDependencies {
  readonly files: GrantFileSystem;
  readonly ids: IdGenerator;
  readonly tokens: TokenMinter;
  readonly clock: Clock;
  /**
   * Told, rather than logged from inside, for the reason every seam here is
   * injected: this module has no logger and should not grow one. A disagreeing
   * `hubId` is accepted and recorded, and the sentence about it belongs to
   * whoever is already writing log lines about the connection.
   */
  readonly onWitness?: ((witness: GrantWitness) => void) | undefined;
}

/** What a handshake turned out to say about the hub behind a grant. */
export interface GrantWitness {
  readonly grantId: GrantId;
  readonly hubId: HubId;
  /** True when this hub id is not the one the grant was first used by. */
  readonly disagrees: boolean;
  /** Set when the bookkeeping write failed. The connection was allowed anyway. */
  readonly unrecorded: string | null;
}

export type ServerGrantsReady =
  | { readonly ok: true; readonly store: ServerGrantStore; readonly migrated: boolean }
  | { readonly ok: false; readonly path: string; readonly problem: string };

/**
 * Opens the grants file, writing grant zero the first time.
 *
 * The migration is the reason the upgrade is a non-event. The server keeps
 * minting a token at first boot and keeps writing it into the identity file --
 * `local-server.ts` reads it from there and all four of its structural bounds
 * depend on it being there -- and that token becomes a grant like any other.
 * Every pairing that worked yesterday works today, the hub needs no migration
 * and no schema change, and there is now a record a revocation can name.
 *
 * It is keyed on the verifier rather than on the file being absent, which
 * matters twice. An identity file minted again gets a grant for its new token,
 * so the hub beside it keeps working instead of locking itself out. And a grant
 * zero somebody *revoked* is not written back: a revocation is a person having
 * said no, and a boot that undid it would be the server choosing -- the same
 * rule `local-server.ts` holds from the hub's end.
 *
 * A file that is there and unreadable is never written over, and the caller is
 * expected to refuse to start. Coming up with an empty grants file would unpair
 * every hub silently; coming up ignoring it would answer to credentials the
 * operator believes they withdrew.
 */
export async function openServerGrants(
  path: string,
  identityToken: string,
  dependencies: ServerGrantDependencies,
): Promise<ServerGrantsReady> {
  const { files, ids, clock } = dependencies;

  const read = await readGrants(path, files);
  if (!read.ok) return { ok: false, path, problem: read.problem };

  let migrated = false;
  if (!read.grants.some((grant) => grant.verifier === tokenDigest(identityToken))) {
    const zero = mintedGrant(ids, clock, {
      label: GRANT_ZERO_LABEL,
      token: identityToken,
      expiresAt: null,
    });
    if (zero === null) {
      return { ok: false, path, problem: 'the id source produced no usable grant id' };
    }
    const written = await files.writeFile(path, serializeServerGrants([...read.grants, zero]));
    if (written.kind === 'failed') {
      return { ok: false, path, problem: `cannot write the grants file: ${written.reason}` };
    }
    migrated = true;
  }

  return { ok: true, store: createStore(path, dependencies), migrated };
}

function createStore(path: string, dependencies: ServerGrantDependencies): ServerGrantStore {
  const { files, ids, tokens, clock, onWitness } = dependencies;

  // One chain, so two writes never read the same file and clobber each other.
  // Every method that touches the disk goes through it, reads included: a read
  // that overlaps a write would otherwise hand a caller the version before it.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return {
    authorize: ({ token, hubId }) =>
      serialized(async (): Promise<AuthorizedGrant> => {
        const read = await readGrants(path, files);
        // A grants file that stopped being readable under a running server
        // refuses, rather than falling back to anything: the alternative is a
        // server that answers to a credential it can no longer check.
        if (!read.ok) return { ok: false, refusal: 'no-grant' };

        const decision = decideGrant(read.grants, { token, now: clock.now() });
        if (!decision.ok) return { ok: false, refusal: decision.refusal };

        const { grant } = decision;
        const disagrees = hubIdDisagrees(grant, hubId);
        const witnessed = witnessedGrant(grant, hubId, clock.now());
        const written = await files.writeFile(
          path,
          serializeServerGrants(replace(read.grants, witnessed)),
        );
        // The connection is allowed either way. What failed is bookkeeping --
        // when this grant was last used and which hub claimed it -- and
        // refusing a hub that presented a good credential because a disk was
        // full would be the server withholding access nobody withdrew.
        onWitness?.({
          grantId: grant.grantId,
          hubId,
          disagrees,
          unrecorded: written.kind === 'failed' ? written.reason : null,
        });
        return { ok: true, grantId: grant.grantId, label: grant.label };
      }),

    list: () =>
      serialized(async (): Promise<GrantListing> => {
        const read = await readGrants(path, files);
        if (!read.ok) return { ok: false, problem: read.problem };
        return { ok: true, grants: read.grants.map(summarizeGrant) };
      }),

    mint: ({ label, expiresAt }) =>
      serialized(async (): Promise<MintedGrant> => {
        const read = await readGrants(path, files);
        if (!read.ok) return { ok: false, problem: read.problem };

        const token = tokens.newToken();
        if (token.length === 0) return { ok: false, problem: 'the token source produced nothing' };
        const grant = mintedGrant(ids, clock, { label, token, expiresAt });
        if (grant === null) {
          return { ok: false, problem: 'the id source produced no usable grant id' };
        }

        const written = await files.writeFile(path, serializeServerGrants([...read.grants, grant]));
        if (written.kind === 'failed') {
          return { ok: false, problem: `cannot write the grants file: ${written.reason}` };
        }
        return { ok: true, grant: summarizeGrant(grant), token };
      }),

    revoke: (grantId) =>
      serialized(async (): Promise<RevokedGrant> => {
        const read = await readGrants(path, files);
        if (!read.ok) return { ok: false, problem: read.problem };

        const existing = read.grants.find((grant) => grant.grantId === grantId);
        if (existing === undefined) return { ok: false, problem: `there is no grant ${grantId}` };
        // Already revoked is the answer the operator asked for, so it is not a
        // refusal -- and the date is the first one, because a second revocation
        // of the same grant did not withdraw anything the first had not.
        if (existing.revokedAt !== null) return { ok: true, grant: summarizeGrant(existing) };

        const revoked: ServerGrant = { ...existing, revokedAt: clock.now() };
        const written = await files.writeFile(
          path,
          serializeServerGrants(replace(read.grants, revoked)),
        );
        if (written.kind === 'failed') {
          return { ok: false, problem: `cannot write the grants file: ${written.reason}` };
        }
        return { ok: true, grant: summarizeGrant(revoked) };
      }),

    refused: (grantIds) =>
      serialized(async (): Promise<readonly WithdrawnGrant[]> => {
        const read = await readGrants(path, files);
        // A file that cannot be read withdraws nothing. The alternative is a
        // server that drops every live hub the moment a disk hiccups, which is
        // a worse failure than one late revocation: the next handshake refuses
        // anyway, because that one has a credential to check and this does not.
        if (!read.ok) return [];

        const now = clock.now();
        const withdrawn: WithdrawnGrant[] = [];
        for (const grantId of new Set(grantIds)) {
          const grant = read.grants.find((one) => one.grantId === grantId);
          if (grant === undefined) {
            withdrawn.push({ grantId, refusal: 'no-grant' });
            continue;
          }
          const decision = usableGrant(grant, now);
          if (!decision.ok) withdrawn.push({ grantId, refusal: decision.refusal });
        }
        return withdrawn;
      }),
  };
}

type GrantsRead =
  | { readonly ok: true; readonly grants: readonly ServerGrant[] }
  | { readonly ok: false; readonly problem: string };

/** An absent file is an empty set of grants; an unreadable one is a refusal. */
async function readGrants(path: string, files: GrantFileSystem): Promise<GrantsRead> {
  const read = await files.readFile(path);
  if (read.kind === 'missing') return { ok: true, grants: [] };
  if (read.kind === 'failed') {
    return { ok: false, problem: `cannot read the grants file: ${read.reason}` };
  }
  const parsed = parseServerGrants(read.contents);
  return parsed.ok ? { ok: true, grants: parsed.grants } : { ok: false, problem: parsed.problem };
}

function mintedGrant(
  ids: IdGenerator,
  clock: Clock,
  request: { readonly label: string; readonly token: string; readonly expiresAt: number | null },
): ServerGrant | null {
  const grantId = grantIdSchema.safeParse(ids.newId());
  if (!grantId.success) return null;
  return {
    grantId: grantId.data,
    label: request.label,
    verifier: tokenDigest(request.token),
    firstHubId: null,
    lastHubId: null,
    createdAt: clock.now(),
    lastUsedAt: null,
    expiresAt: request.expiresAt,
    revokedAt: null,
  };
}

/** The list with one grant replaced in place, so a listing keeps its order. */
function replace(grants: readonly ServerGrant[], updated: ServerGrant): readonly ServerGrant[] {
  return grants.map((grant) => (grant.grantId === updated.grantId ? updated : grant));
}
