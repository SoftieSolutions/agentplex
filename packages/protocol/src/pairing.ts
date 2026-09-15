import { z } from 'zod';

/**
 * What a pairing is made of: a label, an address, and a token.
 *
 * These rules used to live twice -- once in the hub's pairing feature, where a
 * form's submission was parsed, and once in the web app's settings screen,
 * where the same words were typed. Two parsers for one thing is two answers to
 * "is this address dialable", and the web copy said so in its own header: it
 * mirrored the hub's and had to be kept in step by hand. They are here now
 * because an address is on the wire in both directions -- it arrives on a
 * `server-pair` frame and it is published on every `machine-state` row -- and
 * the package both ends already share is the one place a rule about a wire
 * word can live once.
 *
 * Nothing here touches a Node builtin or another workspace package: `URL` is a
 * global in a browser and in a service, which is what makes moving the rules
 * here possible at all.
 */

/**
 * TLS only. The design has the hub dial the server over TLS, and `ws://` typed
 * into a pairing form is nearly always somebody about to send a token over a
 * network in the clear rather than somebody who has thought about it.
 */
const DIALABLE_PROTOCOL = 'wss:';

/**
 * The one address in this build that may be plaintext, and the only host it may
 * name: this machine, by loopback literal.
 *
 * `--role=both` is a hub and a server in one process, and the hub still dials
 * the server. There is no certificate authority that will issue for `127.0.0.1`
 * and no reverse proxy in a one-box install, so requiring `wss://` here would
 * produce a pairing that can never connect -- which is worse than no pairing,
 * because it fails at dial time with nothing pointing at the cause.
 *
 * The rule it is an exception to is about what a token crosses: a packet to
 * `127.0.0.1` is delivered by the kernel and never reaches an interface anybody
 * can watch. A hostname would not do -- `localhost` is resolved, and a name is a
 * thing that can be pointed somewhere else -- so this is the literal or nothing,
 * and `loopbackServerAddress` below takes a port and has nowhere to put a host.
 */
const LOOPBACK_PROTOCOL = 'ws:';
const LOOPBACK_HOST = '127.0.0.1';

/**
 * The bounds a frame carrying one of these is held to.
 *
 * They are about what a socket may carry rather than about what a pairing may
 * say: the content rules are below, and a frame that breaks one of those earns
 * a refusal the user can read. A frame that breaks one of these is not a
 * pairing anybody typed, so it never has to be turned into a sentence.
 */
export const SERVER_LABEL_MAX_CHARS = 200;
export const SERVER_ADDRESS_MAX_CHARS = 2_048;
export const SERVER_TOKEN_MAX_CHARS = 4_096;

type AddressProblem = string;

/**
 * `null` when the address is dialable; otherwise why it is not.
 *
 * One rule set, read by every parser below and by the pairing form, so the
 * loopback allowance is one named branch rather than a second opinion about
 * what an address is. The protocol is transport-agnostic on purpose -- public
 * DNS, a Tailscale name, an SSH-tunnelled port are all the same to it -- so
 * every rule here is about the URL and never about the route.
 */
function addressProblem(text: string, allowLoopbackPlaintext: boolean): AddressProblem | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return `expected a URL such as ${DIALABLE_PROTOCOL}//box.example:8443`;
  }

  const plaintextLoopback =
    url.protocol === LOOPBACK_PROTOCOL && url.hostname === LOOPBACK_HOST && allowLoopbackPlaintext;

  if (url.protocol !== DIALABLE_PROTOCOL && !plaintextLoopback) {
    // Quoted rather than suffixed with `//`, because a bare `box.example:8443`
    // is a URL whose scheme is `box.example:`, and rendering that as
    // `box.example://` reads like a typo in the message rather than in the
    // address.
    return `expected a ${DIALABLE_PROTOCOL}// address, not the scheme ${JSON.stringify(url.protocol)}`;
  }
  if (url.hostname.length === 0) return 'expected a host';
  if (url.username.length > 0 || url.password.length > 0) {
    // A credential in the URL is a second secret, kept somewhere nothing
    // rotates it, doing a job the per-server token already does. It is also
    // what makes an address publishable at all: a row in `machine-state`
    // carries the address the hub dials, and this rule is why that row cannot
    // be carrying a password.
    return 'expected no credentials in the address; the pairing token is the credential';
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    return 'expected no query string or fragment; neither means anything to a dial';
  }

  return null;
}

/**
 * The address the hub dials a paired server at, as a person may type one.
 *
 * A word typed into a form is a claim, so it goes through a parser that can say
 * no rather than being carried around as a string that everything downstream
 * hopes is a URL. The brand is what makes that unskippable: nothing can be
 * registered or dialled without having come through here or through
 * `pairedServerAddressSchema` below.
 */
export const serverAddressSchema = z
  .string()
  .trim()
  .max(SERVER_ADDRESS_MAX_CHARS)
  .superRefine((text, context) => {
    const problem = addressProblem(text, false);
    if (problem !== null) context.addIssue({ code: 'custom', message: problem });
  })
  .brand<'ServerAddress'>();

export type ServerAddress = z.infer<typeof serverAddressSchema>;

/**
 * The same rules with the plaintext loopback allowance: the address of a
 * pairing that exists, rather than of one somebody is proposing.
 *
 * This build writes exactly two shapes -- a `wss://` address somebody typed,
 * and the loopback address `loopbackServerAddress` builds for a hub and a
 * server in one process -- and both have to be readable by whatever reads a
 * pairing back: the hub's own row parser, and the client parsing the
 * `machine-state` row that names where a server is dialled. A parser that
 * refused the second would refuse to read back what the boot before it wrote.
 *
 * It is not what a pairing form goes through. `serverAddressSchema` is, and it
 * still says no to `ws://` whatever the host, so nothing typed, announced or
 * replayed can reach the allowance.
 */
export const pairedServerAddressSchema = z
  .string()
  .trim()
  .max(SERVER_ADDRESS_MAX_CHARS)
  .superRefine((text, context) => {
    const problem = addressProblem(text, true);
    if (problem !== null) context.addIssue({ code: 'custom', message: problem });
  })
  .brand<'ServerAddress'>();

/** A port as a URL can carry one. Checked here so nothing formats a number into an address. */
const loopbackPortSchema = z.int().min(1).max(65535);

/**
 * The address of a server in this same process, or `null` if that is not a port.
 *
 * A port and nothing else: there is no parameter through which another machine
 * could arrive, which is what makes "this exception is for the loopback" a fact
 * about the signature rather than a rule somebody has to remember. The result
 * still goes through a parser, so the brand is earned rather than cast on.
 */
export function loopbackServerAddress(port: number): ServerAddress | null {
  const parsedPort = loopbackPortSchema.safeParse(port);
  if (!parsedPort.success) return null;

  const parsed = pairedServerAddressSchema.safeParse(
    `${LOOPBACK_PROTOCOL}//${LOOPBACK_HOST}:${parsedPort.data}`,
  );
  return parsed.success ? parsed.data : null;
}

/** What the row is called on the user's own screen. Their words, not a machine's. */
export const serverLabelSchema = z.string().trim().min(1).max(SERVER_LABEL_MAX_CHARS);

/**
 * The token the server printed and the user pasted.
 *
 * This parser rejects the empty and the absurd and stops there. How much
 * entropy a token carries is the minting side's business -- the server is what
 * generates it -- and a length rule invented here would only be a rule the
 * thing that mints tokens has never heard of.
 */
export const serverTokenSchema = z.string().trim().min(1).max(SERVER_TOKEN_MAX_CHARS);
