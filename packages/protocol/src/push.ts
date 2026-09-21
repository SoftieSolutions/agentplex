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
 * pair would be a second secret nothing rotates; and it is capped at
 * `PUSH_ENDPOINT_MAX_CHARS` so that a client cannot grow a row without bound.
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
