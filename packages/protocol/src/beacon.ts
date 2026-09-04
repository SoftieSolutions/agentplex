import { z } from 'zod';
import { serverIdSchema } from './identity.js';
import { frameParser } from './parse.js';

/**
 * What a server broadcasts to say it exists, and nothing more.
 *
 * Discovery is not authentication. A beacon says "there is a server at this
 * address, calling itself this, speaking this protocol"; every one of those is
 * a claim by whoever sent the datagram, and UDP on a local network will carry
 * a claim from anyone. What the hub does with one is pre-fill a pairing form.
 * Being heard on the network is nowhere near being trusted by it, and the
 * distance between the two is the user typing that server's token.
 *
 * It lives in the protocol package because both sides read this shape: the
 * server formats it (AGX-45) and the hub parses it (AGX-46). The socket does
 * not — a datagram is bytes, and this package is bundled into a browser that
 * has no such thing. Both sides hand text in and out.
 */

/**
 * The port beacons are broadcast to and listened for.
 *
 * A constant rather than a setting, because it is the one thing the two sides
 * cannot negotiate: a hub listening where nobody announces hears silence, and
 * has no way to tell that from an empty network. It is deliberately not either
 * role's HTTP port — the hub listens for beacons whatever port it serves on,
 * and a server announces the port it is dialled on rather than this one.
 *
 * Chosen from the dynamic range, above everything IANA has assigned, so that
 * an operator who has to open it in a firewall is not opening something else.
 */
export const BEACON_PORT = 50081;

/**
 * How often an announcing server repeats itself.
 *
 * Five seconds is the trade between two costs that pull in opposite
 * directions. A beacon is a couple of hundred bytes, so the traffic is
 * irrelevant at any interval anybody would pick; what the interval actually
 * buys is how quickly a machine appears in the pairing form after it starts,
 * and how quickly one that was unplugged stops being offered. Five seconds is
 * fast enough that a server which just came up is on screen before the user
 * has finished reading the page, and slow enough that the aging window below
 * is half a minute rather than a handful of seconds — long enough to survive a
 * wifi hiccup that drops a datagram or two, since UDP guarantees nothing and a
 * single lost packet must not make a live machine blink out of the list.
 */
export const BEACON_ANNOUNCE_INTERVAL_MS = 5_000;

/**
 * How many announcements may go missing before a claim is stale.
 *
 * Six, from the design document. UDP is lossy by construction, so the count
 * has to be well above the one or two a congested link will eat; six missed in
 * a row is a machine that is gone, not a machine that is unlucky.
 */
export const BEACON_MISSED_LIMIT = 6;

/**
 * How long a beacon claim stands without being repeated.
 *
 * Derived here rather than in the hub so that the two sides cannot drift: the
 * side that decides how often to speak and the side that decides when silence
 * means gone are reading the same arithmetic. Applying it — aging a candidate
 * out of the discovered list — is the hub's, in AGX-46.
 */
export const BEACON_EXPIRY_MS = BEACON_ANNOUNCE_INTERVAL_MS * BEACON_MISSED_LIMIT;

/**
 * Strict, unlike every frame schema in this package.
 *
 * Elsewhere an unknown field is tolerated because a frame arrives on an
 * authenticated connection from a peer whose version was checked. This arrives
 * on an open UDP port, and the rule it enforces is the one the design states
 * outright: a beacon never carries a token. A parser that stripped unknown
 * fields would accept a build that had quietly started broadcasting a secret,
 * and the receiving hub would never know it had been sent one.
 *
 * The literal `type` is the other half: it is what makes another program's
 * datagram on the same port a clean "not ours" rather than a parse failure
 * worth logging.
 */
export const serverBeaconSchema = z.strictObject({
  type: z.literal('agentplex-server-beacon'),
  /**
   * Read, never enforced here. A hub that could not parse a beacon from a
   * mismatched build could only report silence, when what it can report is a
   * machine it can see and cannot speak to. `checkProtocolVersion` is the
   * verdict, and it belongs to whoever is deciding what to show.
   */
  protocolVersion: z.int().positive(),
  serverId: serverIdSchema,
  /**
   * Where the hub would dial this server, as the server understands its own
   * position on the network. A claim like every other field: a hub is free to
   * compare it against the address the datagram actually came from.
   */
  address: z.string().min(1),
  /** The port the hub dials. Not `BEACON_PORT`, which is where this was heard. */
  port: z.int().min(1).max(65535),
});
export type ServerBeacon = z.infer<typeof serverBeaconSchema>;

/** The one parser for this direction. Nothing downstream re-checks `type`. */
export const parseServerBeacon = frameParser(serverBeaconSchema);

/**
 * The wire form, as text.
 *
 * Encoding it to bytes is the sender's business, because this package is
 * bundled into a browser and has no `Buffer` to reach for.
 */
export function formatServerBeacon(beacon: ServerBeacon): string {
  return JSON.stringify(beacon);
}
