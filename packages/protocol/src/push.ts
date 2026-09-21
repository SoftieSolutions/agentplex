import { z } from 'zod';

/**
 * What a browser hands over when it asks to be told, as the wire carries it.
 *
 * The shape lives here rather than in the hub because two parties read it and
 * one parser is what keeps them agreeing: the client leg parses a
 * `push-subscribe` frame with it, and the hub's push feature parses its own
 * rows off disk with it. A second spelling in the feature would be a second
 * answer to "what is a subscription", and the one that is wrong is always the
 * one nobody is looking at.
 *
 * It is browser-safe, like everything in this package: no Node builtin, no
 * workspace import, `URL` and nothing else.
 */

/**
 * The bounds a wire-carried or stored subscription is held to.
 *
 * A browser's own values sit far inside them -- an endpoint is a couple of
 * hundred characters, `p256dh` is an uncompressed P-256 point at 87 base64url
 * characters and `auth` is 16 bytes at 22. The caps are the sizes past which a
 * value is not a subscription anybody's browser produced, not the sizes today's
 * browsers happen to produce: pinning the exact lengths would refuse the first
 * push service that changes a token format, for the sake of rejecting inputs
 * the encryption already rejects.
 */
export const PUSH_ENDPOINT_MAX_CHARS = 2_048;
export const PUSH_KEY_MAX_CHARS = 256;

/**
 * One key: base64url, bounded, non-empty.
 *
 * Two different things are held to it, which is why it is not called a
 * subscription key. A browser's `p256dh` and `auth` are not secrets of this
 * hub's -- they belong to that browser, they are useless without the private
 * half it kept, and their job is to encrypt a payload that not even the push
 * service relaying it can read. The hub's own VAPID halves are the same
 * encoding and are held to the same bound by the feature that mints them.
 */
export const pushKeySchema = z.base64url().min(1).max(PUSH_KEY_MAX_CHARS);

/**
 * `null` when the host is an address the hub may POST to; otherwise which
 * family it belongs to.
 *
 * ## Why this rule exists
 *
 * An endpoint is the one field on this wire that becomes a request the hub
 * makes. Whoever holds this hub's client token can therefore hand it an address
 * and have the hub POST to it from inside whatever network the hub sits in --
 * a metadata service, a router's admin port, a database that trusts the subnet.
 * Refusing the addresses that are only reachable from in there costs a line of
 * parsing and removes the cheap half of that.
 *
 * ## Why only literals, and what the rest of the answer is
 *
 * A hostname is not judged, and pretending to judge one would be worse than
 * not. A name is resolved by somebody else at the moment of the send, so a name
 * that answers publicly when this parser runs can answer `127.0.0.1` a second
 * later -- DNS rebinding, and it defeats any check made here by construction.
 * Only a literal is decidable at parse time, so only a literal is judged.
 *
 * What keeps the rest small is the shape of the feature rather than this rule.
 * The body is fixed -- a provider name, the words for a status, two ids -- and
 * is built from an event the subscriber cannot influence, so nothing a client
 * chooses reaches the request except the URL. Redirects are not followed, so
 * one hop is all an endpoint gets. And the outcome never goes back to the
 * client: a send is `delivered`, `gone` or `failed` in this hub's own log, so
 * an endpoint cannot be used to read anything back. What remains is a blind
 * POST of a fixed body to a name that resolves somewhere, which is the residual
 * risk this accepts rather than claiming to have closed.
 */
function internalAddressFamily(hostname: string): string | null {
  const four = ipv4Octets(hostname);
  if (four !== null) return internalIpv4Family(four);

  const six = ipv6Groups(hostname);
  if (six === null) return null;

  // Every group zero: the unspecified address, which on many stacks connects
  // to the local host rather than failing.
  if (six.every((group) => group === 0)) return 'IPv6 unspecified';
  if (six[7] === 1 && six.slice(0, 7).every((group) => group === 0)) return 'IPv6 loopback';
  // fe80::/10 and fc00::/7: the address a machine has on its own link, and the
  // range a private network numbers itself out of.
  if (((six[0] ?? 0) & 0xffc0) === 0xfe80) return 'IPv6 link-local';
  if (((six[0] ?? 0) & 0xfe00) === 0xfc00) return 'IPv6 unique local';

  // An IPv4 address wearing an IPv6 spelling. Five zero groups is either
  // `::ffff:a.b.c.d`, which a stack sends to that IPv4 host, or the deprecated
  // `::a.b.c.d`; both put an IPv4 address in the low 32 bits, and reading it
  // there is what stops `[::ffff:127.0.0.1]` being the way around this rule.
  if (six.slice(0, 5).every((group) => group === 0)) {
    const high = six[6] ?? 0;
    const low = six[7] ?? 0;
    const embedded = internalIpv4Family([high >> 8, high & 0xff, low >> 8, low & 0xff]);
    if (embedded !== null) return `${embedded}, mapped into IPv6`;
  }
  return null;
}

/** Which family an IPv4 address is in, of the four a hub may not be pointed at. */
function internalIpv4Family(octets: readonly number[]): string | null {
  const [a = 0, b = 0] = octets;
  if (a === 127) return 'IPv4 loopback';
  // 0.0.0.0/8 is "this network": the unspecified address and the addresses
  // that are only meaningful to the host itself.
  if (a === 0) return 'IPv4 unspecified';
  if (a === 169 && b === 254) return 'IPv4 link-local';
  if (a === 10) return 'IPv4 private';
  if (a === 172 && b >= 16 && b <= 31) return 'IPv4 private';
  if (a === 192 && b === 168) return 'IPv4 private';
  return null;
}

/**
 * The four octets of an IPv4 literal, or `null` when the host is not one.
 *
 * Read off `URL.hostname` rather than off the text, because a URL parser has
 * already folded `127.1` and `0x7f.1` into the canonical dotted quad. A rule
 * over the raw string would have to know every one of those spellings, and
 * would be wrong about the next one.
 */
function ipv4Octets(hostname: string): readonly number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/**
 * The eight groups of an IPv6 literal, or `null` when the host is not one.
 *
 * Bracketed, because that is how a URL carries one and therefore the only way
 * one can arrive here. A trailing dotted quad is expanded even though the URL
 * parser normalises it away, so that this answers the same for an address that
 * reached it from somewhere with a laxer parser.
 */
function ipv6Groups(hostname: string): readonly number[] | null {
  if (!hostname.startsWith('[') || !hostname.endsWith(']')) return null;
  const text = hostname.slice(1, -1).toLowerCase();

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = expandIpv6Groups(halves[0] ?? '');
  const tail = halves.length === 2 ? expandIpv6Groups(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;

  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...Array.from({ length: missing }, () => 0), ...tail];
}

/** One side of a `::`, as groups. An empty side is no groups, not one zero. */
function expandIpv6Groups(side: string): number[] | null {
  if (side.length === 0) return [];
  const groups: number[] = [];
  const pieces = side.split(':');
  for (const [index, piece] of pieces.entries()) {
    if (index === pieces.length - 1 && piece.includes('.')) {
      const octets = ipv4Octets(piece);
      if (octets === null) return null;
      groups.push(((octets[0] ?? 0) << 8) | (octets[1] ?? 0));
      groups.push(((octets[2] ?? 0) << 8) | (octets[3] ?? 0));
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
    groups.push(Number.parseInt(piece, 16));
  }
  return groups.length > 8 ? null : groups;
}

/**
 * `null` when the endpoint is a URL a push may be sent to; otherwise why not.
 *
 * One rule set rather than a regular expression, for the same reason a server
 * address has one: what makes an endpoint acceptable is a handful of statements
 * about a parsed URL, and each of them earns a sentence somebody can read when
 * it refuses.
 */
function endpointProblem(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'expected a URL such as https://push.example/send/abc';
  }

  // Plaintext is not a strictness we invented: the Push API is a secure-context
  // feature and no push service issues an http:// endpoint. One that arrives is
  // either a hand-edited row or somebody pointing this hub's POSTs somewhere.
  if (url.protocol !== 'https:') {
    return `expected an https:// endpoint, not the scheme ${JSON.stringify(url.protocol)}`;
  }
  if (url.hostname.length === 0) return 'expected a host';
  if (url.username.length > 0 || url.password.length > 0) {
    // A credential in the endpoint is a second secret kept where nothing
    // rotates it. The endpoint is already the capability: whoever holds it can
    // push, which is why it is treated as the identity of a subscription and
    // never as a label.
    return 'expected no credentials in the endpoint; the endpoint is itself the capability';
  }
  const family = internalAddressFamily(url.hostname);
  if (family !== null) {
    return `expected a push service reachable from anywhere; ${url.hostname} is an ${family} address`;
  }
  return null;
}

/**
 * The URL a push is POSTed to, and the identity of a subscription.
 *
 * This is the one field on this wire that is an address the hub will later make
 * a request to, so what bounds it is worth saying in one place. It must parse
 * as a URL; it must be `https:` and have a host, because the Push API is a
 * secure-context feature and no service issues anything else; it may carry no
 * credentials, because the endpoint is itself the capability and a userinfo
 * pair would be a second secret nothing rotates; it is capped at
 * `PUSH_ENDPOINT_MAX_CHARS` so that a client cannot grow a row without bound;
 * and its host may not be an IP literal on a loopback, private, link-local or
 * unspecified address, because a client that may name where the hub POSTs
 * should not be able to name somewhere only the hub can reach.
 *
 * What the hub sends to it is fixed and is decided nowhere near this frame: the
 * provider's name, the words for a status, and `{ storeId, sessionId }` for the
 * tap to land on. A session's title, working directory and branch never reach
 * it -- a notification is read on a lock screen, in a lobby, over somebody's
 * shoulder -- and no field here can widen that, because the payload is built
 * from an event the subscriber never names.
 *
 * Branded, so that nothing can be stored or removed without having come through
 * here: an endpoint arrives from a browser, over a socket or off disk, and all
 * three are claims. A bare string in an unsubscribe would be a string somebody
 * eventually builds by hand.
 */
export const pushEndpointSchema = z
  .string()
  .trim()
  .min(1)
  .max(PUSH_ENDPOINT_MAX_CHARS)
  .superRefine((text, context) => {
    const problem = endpointProblem(text);
    if (problem !== null) context.addIssue({ code: 'custom', message: problem });
  })
  .brand<'PushEndpoint'>();

export type PushEndpoint = z.infer<typeof pushEndpointSchema>;

/**
 * One browser's subscription, in the shape the browser produces it.
 *
 * `{ endpoint, keys: { p256dh, auth } }` is what the DOM's own
 * `PushSubscription.toJSON()` hands over and what a sender wants, so the shape
 * crosses the wire and the hub's feature without being taken apart and put back
 * together twice. The hub's columns are flat because a table is flat; that is
 * the only place the two shapes differ.
 */
export const pushSubscriptionSchema = z.object({
  endpoint: pushEndpointSchema,
  keys: z.object({ p256dh: pushKeySchema, auth: pushKeySchema }),
});

export type PushSubscription = z.infer<typeof pushSubscriptionSchema>;
