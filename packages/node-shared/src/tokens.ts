import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Secrets: where they come from, and the only way two of them are compared.
 *
 * Both roles hold one now. A server has a pairing token the hub presents back
 * to it; a hub has the client token typed on the device and the short-lived
 * tickets it exchanges that token for. The minting and the comparison are the
 * same problem in both places, and having them in one file is what stops the
 * second use site from re-deciding either — the failure mode being a `===` on
 * a credential, which is a correct-looking line of code.
 */

/**
 * The entropy seam.
 *
 * Injected so a test can assert on the secret it expects rather than on a
 * pattern, and so that the one place a secret is generated is visible in the
 * wiring. It is separate from `IdGenerator` because the two have different
 * jobs: an id must be unique and may be public, a token must be unguessable.
 * A uuid is the wrong thing to authenticate with and a token is the wrong
 * thing to put in a log line, and one interface for both invites each to be
 * used as the other.
 */
export interface TokenMinter {
  newToken(): string;
}

/**
 * 32 bytes from the CSPRNG, base64url so it survives being pasted into a form,
 * a shell, and a YAML file without quoting or escaping — and, since the hub's
 * tickets go through here too, without being percent-encoded on its way into a
 * query string.
 */
export const randomTokenMinter: TokenMinter = {
  newToken: () => randomBytes(32).toString('base64url'),
};

/**
 * The floor under a token a person or a deployment supplied, rather than one
 * `randomTokenMinter` produced.
 *
 * Short enough to be typed on a phone, long enough that guessing it is not a
 * plan. 32 characters is under what the minter above produces (43), so the
 * documented way of generating one always passes; what it refuses is the
 * password somebody picked because it was quick, on a credential that is the
 * only thing standing between a network and every session behind it.
 *
 * One number rather than one per caller. The hub's client token and the
 * server's configured pairing token are the same decision taken twice -- an
 * operator supplied a secret instead of letting a CSPRNG mint one -- and two
 * constants that have to agree are two that eventually do not.
 */
export const MIN_TOKEN_LENGTH = 32;

/**
 * Compares two secrets without leaking how far the comparison got.
 *
 * `timingSafeEqual` throws on differing lengths, and calling it on the raw
 * bytes would therefore turn the secret's length into something an attacker can
 * read off an exception. Hashing both first makes every comparison the same
 * fixed width, so the only thing measurable is that one happened.
 */
export function tokenMatches(presented: string, expected: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(presented), digest(expected));
}

/**
 * A secret reduced to something that can be stored where the secret may not be.
 *
 * Here rather than beside its caller because it is the same decision as the
 * comparison below it and has to stay in step with it: a digest written into a
 * file and a comparison taken somewhere else are two spellings of one rule, and
 * the second one is where it stops being true.
 *
 * The asymmetry that makes it worth having is whose job each side has. The hub
 * must hold its tokens in the clear because it *presents* them, and an outbound
 * credential cannot be hashed. A server only ever *checks* one, so once the
 * pairing flow prints a token rather than leaving it in a file to be re-read,
 * the server never needs the plaintext again and holds this instead.
 *
 * No salt and no slow KDF, deliberately. These are 32 bytes from the CSPRNG,
 * not passwords: there is nothing to guess offline and nothing a rainbow table
 * could hold, so a per-record salt would buy nothing and cost the property that
 * makes this usable -- that the digest of a presented token is a lookup key.
 */
export function tokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}
