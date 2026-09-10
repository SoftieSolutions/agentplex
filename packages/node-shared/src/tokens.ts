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
