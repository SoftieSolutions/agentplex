import { z } from 'zod';

/**
 * The address the hub dials a paired server at.
 *
 * This is a word typed by a person into a form, so it goes through a parser
 * that can say no rather than being carried around as a string that everything
 * downstream hopes is a URL. The brand is what makes that unskippable: nothing
 * can be registered or dialled without having come through here.
 *
 * The protocol is transport-agnostic on purpose -- public DNS, a Tailscale
 * name, an SSH-tunnelled port are all the same to it -- so the rules below are
 * about the URL and never about the route.
 */

/**
 * TLS only. The design has the hub dial the server over TLS, and `ws://` typed
 * into a pairing form is nearly always somebody about to send a token over a
 * network in the clear rather than somebody who has thought about it.
 */
const DIALABLE_PROTOCOL = 'wss:';

export type AddressProblem = string;

/** `null` when the address is dialable; otherwise why it is not. */
function addressProblem(text: string): AddressProblem | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return `expected a URL such as ${DIALABLE_PROTOCOL}//box.example:8443`;
  }

  if (url.protocol !== DIALABLE_PROTOCOL) {
    // Quoted rather than suffixed with `//`, because a bare `box.example:8443`
    // is a URL whose scheme is `box.example:`, and rendering that as
    // `box.example://` reads like a typo in the message rather than in the
    // address.
    return `expected a ${DIALABLE_PROTOCOL}// address, not the scheme ${JSON.stringify(url.protocol)}`;
  }
  if (url.hostname.length === 0) return 'expected a host';
  if (url.username.length > 0 || url.password.length > 0) {
    // A credential in the URL is a second secret, kept somewhere nothing
    // rotates it, doing a job the per-server token already does.
    return 'expected no credentials in the address; the pairing token is the credential';
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    return 'expected no query string or fragment; neither means anything to a dial';
  }

  return null;
}

/**
 * The parser. Branded, so a `ServerAddress` in a signature is a promise that
 * these rules already ran, and an unchecked string cannot be passed instead.
 */
export const serverAddressSchema = z
  .string()
  .trim()
  .superRefine((text, context) => {
    const problem = addressProblem(text);
    if (problem !== null) context.addIssue({ code: 'custom', message: problem });
  })
  .brand<'ServerAddress'>();

export type ServerAddress = z.infer<typeof serverAddressSchema>;
