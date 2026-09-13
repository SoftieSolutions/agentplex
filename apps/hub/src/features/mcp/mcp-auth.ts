import { tokenMatches } from '@agentplex/node-shared';
import { bearerCredential } from '../client-auth/client-auth.js';

/**
 * Who may speak MCP to this hub.
 *
 * One credential, presented in a header, compared the way every other secret in
 * this repository is compared. There is no ticket exchange here and there is not
 * going to be one: tickets exist because a browser's `WebSocket` constructor
 * cannot set a header, and an MCP client is an ordinary HTTP client that can.
 * The short-lived half of client auth buys nothing for a caller that never has
 * to put its credential in a URL, and it would cost the thing that makes this
 * endpoint simple to reason about -- that a request either carried the token or
 * did not.
 *
 * The same token as the client socket, and not one of its own. `0009_mcp_tokens`
 * is reserved in the design and stays unused: a second credential is a second
 * thing an operator has to rotate, and it would only be worth that if it granted
 * something different. It does not. MCP reaches exactly what the UI reaches, so
 * a token that opened one and not the other would be a distinction with no
 * capability behind it.
 *
 * A value rather than a write to a response, the way `client-auth.ts` decides
 * the ticket exchange: every rule about who gets in is exercised without a port,
 * and `mcp.ts` turns the answer into HTTP.
 */

/**
 * Whether a request carried the client token.
 *
 * Absent, malformed, another scheme, doubled, and wrong are one answer. A caller
 * that could tell them apart would have a way to probe for the header this hub
 * reads and for the length of what it expects there; `bearerCredential` is what
 * collapses the first four and `tokenMatches` the last.
 *
 * The token itself never leaves this function, and nothing above it is given a
 * reason to hold one: the caller gets a boolean, so there is no line anywhere
 * that could log the credential by logging its own inputs.
 */
export function admitsMcpRequest(
  authorization: string | string[] | undefined,
  token: string,
): boolean {
  const presented = bearerCredential(authorization);
  if (presented === null) return false;
  return tokenMatches(presented, token);
}
