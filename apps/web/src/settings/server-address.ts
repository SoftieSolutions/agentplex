import type { ParseResult } from '@agentplex/protocol';

/**
 * The address the pairing form submits: parsed in the browser, before anything
 * is sent anywhere. A word typed by a person is a claim, and the form is the
 * first boundary that can say no to it.
 *
 * The rules mirror the hub's own pairing parser
 * (apps/agentplexd/src/hub/pairing/server-address.ts) and must stay in step
 * with it — no code crosses a package line but the protocol, and the protocol
 * carries frames, not form validation. When a client pairing frame lands in
 * the protocol (see the settings screen's pairing seam), the address schema
 * belongs on that frame and this file dissolves into it; until then the hub's
 * parser remains the authority and this one exists so the user hears "no"
 * before a request does.
 */

/**
 * TLS only, as the design requires: the hub dials the server over TLS, and
 * `ws://` typed here is nearly always a token about to cross a network in the
 * clear.
 */
const DIALABLE_PROTOCOL = 'wss:';

/** Trims and checks the typed address; the value returned is the trimmed form. */
export function parseServerAddress(text: string): ParseResult<string> {
  const trimmed = text.trim();

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: `expected a URL such as ${DIALABLE_PROTOCOL}//box.example:8443` };
  }

  if (url.protocol !== DIALABLE_PROTOCOL) {
    // Quoted rather than suffixed with `//`: a bare `box.example:8443` parses
    // as a URL whose scheme is `box.example:`, and rendering that as
    // `box.example://` would read like a typo in the message.
    return {
      ok: false,
      reason: `expected a ${DIALABLE_PROTOCOL}// address, not the scheme ${JSON.stringify(url.protocol)}`,
    };
  }
  if (url.hostname.length === 0) return { ok: false, reason: 'expected a host' };
  if (url.username.length > 0 || url.password.length > 0) {
    return {
      ok: false,
      reason: 'expected no credentials in the address; the pairing token is the credential',
    };
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    return {
      ok: false,
      reason: 'expected no query string or fragment; neither means anything to a dial',
    };
  }

  return { ok: true, value: trimmed };
}
