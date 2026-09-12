import { basename, dirname, extname, join } from 'node:path';
import { z } from 'zod';
import { hubIdSchema, type HubId } from '@agentplex/protocol';
import { tokenDigest, tokenMatches } from '@agentplex/node-shared';
import type { FileRead } from './store-identity.js';

/**
 * A grant: one hub's permission to talk to this server, as a thing that can be
 * named, listed and taken away.
 *
 * Until this file a server held one token and had one answer. That is
 * authentication and it cannot express a decision: every hub presents the same
 * string, so the only revocation available is rotating it, which unpairs every
 * hub at once and is therefore the revocation nobody performs. A grant is the
 * unit that fixes it -- one per pairing rather than one per server -- and every
 * per-hub fact this server keeps hangs off the grant id it resolved, never off
 * anything the hub said about itself.
 *
 * ## What is stored, and what deliberately is not
 *
 * **A verifier, never the token.** `server-identity.ts` holds a token in the
 * clear because that file is where an operator reads it; a grant is minted,
 * printed once and never read back, so the server can hold `sha256` of it and
 * nothing that reads this file can present anything with what it found. The
 * hub's own rows keep their tokens in the clear for the opposite reason, which
 * is not an inconsistency: it presents them and an outbound credential cannot
 * be hashed.
 *
 * **`hubId` is a label.** It arrives on the handshake, so a hub holding the
 * token can claim to be any hub, and nothing here decides anything with it. It
 * is recorded so that a person reading a listing or a log line sees a name they
 * recognise, in exactly the sense a pairing's label is a name.
 *
 * `firstHubId` is the one seen when the grant was first used and `lastHubId`
 * the one seen most recently. When they disagree the server **accepts and
 * records it** rather than refusing: a hub whose database was rebuilt mints a
 * new id and is legitimately the same operator with the same token, and
 * refusing would turn a recoverable afternoon into an outage nothing explains.
 * Recording both is the honest half -- a server that cannot prove which hub is
 * connected must not display one name as though it could.
 *
 * **An expiry, now rather than later.** Per-hub tokens fix "two hubs cannot be
 * told apart"; they do nothing about "a token read off a screen in a support
 * session is valid until somebody notices". One nullable `expiresAt` is the
 * smallest thing that does, and adding the field afterwards means rewriting
 * every record that was stored without it. There is no renewal path on purpose:
 * an expired grant is minted again by hand, because renewal is the part that
 * becomes infrastructure, and the case this is for is the meeting rather than
 * the fleet.
 *
 * **No scopes.** They are deferred until a second kind of hub exists, and this
 * record is where they land when one does -- a field here, not a new mechanism.
 */

/**
 * The server's own name for a grant, minted by it and never taken off a frame.
 *
 * It is not in `@agentplex/protocol` because it is not on the wire and must not
 * become so: a hub that could name a grant could name somebody else's.
 */
export const grantIdSchema = z.string().min(1).max(200).brand<'GrantId'>();
export type GrantId = z.infer<typeof grantIdSchema>;

/**
 * Non-strict, like the identity and store files: a later version may add a
 * field -- scopes are the one already named -- and an older build that meets
 * one should read what it knows and carry on.
 */
export const serverGrantSchema = z.object({
  grantId: grantIdSchema,
  /** What the operator called the hub this was minted for. Shown in a listing. */
  label: z.string().min(1),
  /** `tokenDigest` of the token. The token itself is never written here. */
  verifier: z.string().min(1),
  /** The hub id first seen presenting it, `null` until one has been. */
  firstHubId: hubIdSchema.nullable(),
  /** The hub id seen most recently. Differs from the first when a hub was rebuilt. */
  lastHubId: hubIdSchema.nullable(),
  createdAt: z.int().nonnegative(),
  /** When this grant was last used to establish a connection, `null` until it was. */
  lastUsedAt: z.int().nonnegative().nullable(),
  /** Epoch ms after which it stops working, or `null` for a grant that never expires. */
  expiresAt: z.int().nonnegative().nullable(),
  /** Epoch ms a person said no. `null` for a grant that is still good. */
  revokedAt: z.int().nonnegative().nullable(),
});
export type ServerGrant = z.infer<typeof serverGrantSchema>;

/**
 * The file, whole or not at all.
 *
 * A record that does not parse fails the read rather than being skipped, which
 * is the opposite of what a listing of stores does and is deliberate. Skipping
 * a record would silently drop a grant, and the next write -- a mint, a
 * revocation -- would persist the version without it, so a byte of damage would
 * quietly delete a pairing nobody chose to remove. The identity file makes the
 * same call for the same reason: a credential file that cannot be read stops
 * the start, and the operator gets a sentence naming the file.
 */
export const serverGrantsFileSchema = z.object({
  grants: z.array(serverGrantSchema),
});

/**
 * The label a migrated grant zero carries.
 *
 * It says where the secret is rather than what it was for, because that is what
 * the operator needs when they meet it in a listing: this is the token in the
 * identity file, the one the hub on this machine pairs with and the one printed
 * before grants existed.
 */
export const GRANT_ZERO_LABEL = 'the pairing token in the identity file';

/** What a grants file turned out to be. `null` contents means there is no file yet. */
export type ServerGrantsParse =
  | { readonly ok: true; readonly grants: readonly ServerGrant[] }
  | { readonly ok: false; readonly problem: string };

/** The parser that can say no. Every path into a grant goes through it. */
export function parseServerGrants(contents: string): ServerGrantsParse {
  let json: unknown;
  try {
    json = JSON.parse(contents);
  } catch (error) {
    return { ok: false, problem: `the grants file is not JSON: ${String(error)}` };
  }

  const parsed = serverGrantsFileSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return { ok: false, problem: `the grants file is not a grants file: ${issues}` };
  }

  return { ok: true, grants: parsed.data.grants };
}

/**
 * Indented with a trailing newline, like the identity file, because a person
 * opens this one too -- to read a label, a date, or which hub a grant claims to
 * belong to. What they cannot read out of it is a credential.
 */
export function serializeServerGrants(grants: readonly ServerGrant[]): string {
  return `${JSON.stringify({ grants }, null, 2)}\n`;
}

/**
 * Where the grants for a given identity file live: beside it, named after it.
 *
 * Beside the identity file rather than under the data root, because these two
 * are one deployment coordinate. The identity file is already the path three
 * programs agree on -- setup writes it, the hub reads it to pair the server on
 * its own machine, doctor reports on it -- and a second setting for the file
 * that says who may use that identity is a second thing to get out of step with
 * the first.
 *
 * Named after it rather than fixed, so that two servers configured with two
 * identity files in one directory get two grants files. A fixed name would hand
 * both of them the same authorization record, which is the bug
 * `server-identity.ts` refuses for the identity itself.
 */
export function serverGrantsPath(identityPath: string): string {
  const name = basename(identityPath);
  const extension = extname(name);
  const stem = extension === '' ? name : name.slice(0, -extension.length);
  return join(dirname(identityPath), `${stem}-grants.json`);
}

/**
 * Why a presented token was not accepted.
 *
 * It reaches a log line and a sweep, and it never reaches a frame.
 * `handshake-rejected` says the handshake failed and no more: telling a peer
 * that its credential was real but withdrawn confirms the one bit an attacker
 * wants, and a revoked hub is therefore refused exactly as a wrong token is.
 */
export type GrantRefusal = 'no-grant' | 'revoked' | 'expired';

export type GrantDecision =
  | { readonly ok: true; readonly grant: ServerGrant }
  | { readonly ok: false; readonly refusal: GrantRefusal };

/**
 * Whether a grant may be used at this instant, given the grants that exist.
 *
 * Pure, and separate from anything that reads a disk, because it is the whole
 * of the authorization rule and a rule nothing can test without a filesystem is
 * a rule nobody tests. The lookup is by digest so a handshake is one comparison
 * rather than a walk, and the accept still goes through `tokenMatches`: there
 * is one way two secrets are compared in this codebase and a second spelling of
 * it is how that stops being true.
 */
export function decideGrant(
  grants: readonly ServerGrant[],
  presented: { readonly token: string; readonly now: number },
): GrantDecision {
  const verifier = tokenDigest(presented.token);
  const found = grants.find((grant) => tokenMatches(grant.verifier, verifier));
  if (found === undefined) return { ok: false, refusal: 'no-grant' };
  return usableGrant(found, presented.now);
}

/**
 * The same rule applied to a grant already resolved, for the sweep that has to
 * ask about a connection that is already up.
 *
 * Revocation is checked before expiry so that a grant which is both reports the
 * decision a person took rather than the one a clock took.
 */
export function usableGrant(grant: ServerGrant, now: number): GrantDecision {
  if (grant.revokedAt !== null) return { ok: false, refusal: 'revoked' };
  if (grant.expiresAt !== null && now >= grant.expiresAt) {
    return { ok: false, refusal: 'expired' };
  }
  return { ok: true, grant };
}

/**
 * The grant with what this handshake saw recorded on it.
 *
 * A new value rather than a mutation, because the caller decides whether the
 * write survives: a bookkeeping write that fails must not cost a hub a
 * connection it had already been authorized for.
 */
export function witnessedGrant(grant: ServerGrant, hubId: HubId, now: number): ServerGrant {
  return {
    ...grant,
    firstHubId: grant.firstHubId ?? hubId,
    lastHubId: hubId,
    lastUsedAt: now,
  };
}

/** Whether this handshake's hub id disagrees with the one the grant was first used by. */
export function hubIdDisagrees(grant: ServerGrant, hubId: HubId): boolean {
  return grant.firstHubId !== null && grant.firstHubId !== hubId;
}

/**
 * A grant as a listing shows it: everything but the verifier.
 *
 * The verifier is left out rather than redacted at each caller, for the reason
 * the token never reaches a result type: a value that cannot carry the secret
 * cannot leak it, and a caller that has to remember is one that will forget.
 */
export interface GrantSummary {
  readonly grantId: GrantId;
  readonly label: string;
  readonly firstHubId: HubId | null;
  readonly lastHubId: HubId | null;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly expiresAt: number | null;
  readonly revokedAt: number | null;
}

export function summarizeGrant(grant: ServerGrant): GrantSummary {
  const { verifier: _verifier, ...summary } = grant;
  return summary;
}

/** How a grants file is read and replaced. `FileRead` is the store seam's. */
export type FileWrite =
  { readonly kind: 'written' } | { readonly kind: 'failed'; readonly reason: string };

/**
 * The disk under the grants file.
 *
 * Its own seam rather than a method on `StoreFileSystem`, because that one
 * reaches a provider's volume and `data-root.ts` is explicit that a write must
 * never appear on it. This one replaces a file the server owns, and the
 * replacement has to be atomic: a reader that meets a half-written grants file
 * is a server that refuses every handshake until somebody notices.
 */
export interface GrantFileSystem {
  readFile(path: string): Promise<FileRead>;
  /** Replaces the file, atomically, creating it if it is not there. */
  writeFile(path: string, contents: string): Promise<FileWrite>;
}
