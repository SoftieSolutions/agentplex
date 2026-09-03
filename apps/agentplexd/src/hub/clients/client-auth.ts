import { tokenMatches } from '../../shared/tokens.js';
import type { ClientTickets, IssuedTicket } from './client-tickets.js';

/**
 * How a client proves it may attach, decided as values rather than as writes to
 * a socket.
 *
 * Two steps, because a browser has two different things it can do. An ordinary
 * request can carry a header, so the long-lived credential is presented there
 * and nowhere else. A `WebSocket` cannot carry one — the constructor takes a URL
 * and a subprotocol list — so the socket presents a ticket in the query string,
 * which is survivable only because `client-tickets.ts` makes a ticket worthless
 * the moment it is used.
 *
 * The two failures are one fact. A wrong credential is a 401 at the exchange
 * and a bad, spent or expired ticket is a 1008 close at the upgrade, and both
 * say `not authorized` and nothing else. Which check failed is not information
 * this hub owes anyone: an unauthenticated caller learning that its ticket was
 * merely expired has learned that its credential was good, and a user reading
 * two different messages for one broken pairing has learned nothing at all.
 */

/** Where the credential is exchanged. A POST, because it mints state. */
export const CLIENT_TICKET_PATH = '/client/ticket';

/** Where the socket arrives, with its ticket and nothing else. */
export const CLIENT_SOCKET_PATH = '/client';

/**
 * The only thing an unauthorized caller is ever told, on either path.
 *
 * Also the websocket close reason, which RFC 6455 caps at 123 bytes — well
 * inside it, and short for the same reason it is vague.
 */
export const NOT_AUTHORIZED = 'not authorized';

/** The one query parameter this hub reads off a URL, anywhere. */
const TICKET_PARAM = 'ticket';

/**
 * A base for parsing a request target, which is a path and query rather than a
 * URL. It is never looked at: only the path and the search survive.
 */
const REQUEST_BASE = 'http://request.invalid';

/**
 * Reads a bearer credential out of an `authorization` header.
 *
 * Parsed rather than sliced. A header is a claim: it may be absent, it may have
 * arrived twice (Node hands some repeated headers up as an array), it may name
 * a different scheme, and none of those are a credential. Returning `null` for
 * all of them is what keeps the caller from having a second way to fail.
 */
export function bearerCredential(header: string | string[] | undefined): string | null {
  // Two credentials is not one credential, and picking either would be this
  // function deciding which of them the client meant.
  if (typeof header !== 'string') return null;

  const match = /^bearer\s+(\S+)\s*$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * The path a request is for, with the query gone.
 *
 * Everything routes on this rather than on `request.url`, because the socket's
 * URL carries a ticket and a raw request target is therefore a secret. This is
 * the form that is safe to log. `URL` also normalizes, so a path cannot be
 * dressed up with `..` to look like a different one.
 */
export function requestPath(url: string | undefined): string {
  try {
    return new URL(url ?? '/', REQUEST_BASE).pathname;
  } catch {
    return '/';
  }
}

/** What this hub reads of a request to the ticket endpoint, and no more. */
export interface TicketRequest {
  readonly method: string | undefined;
  readonly authorization: string | string[] | undefined;
}

export type TicketResponse =
  | { readonly status: 200; readonly body: IssuedTicket }
  | { readonly status: 401 | 405; readonly body: { readonly error: string } };

export interface TicketExchange {
  /** The shared credential typed on the device. Never logged, never in a URL. */
  readonly token: string;
  readonly tickets: ClientTickets;
}

/**
 * Exchanges the credential for a ticket, or refuses.
 *
 * A value rather than a response write, so that every rule about who gets a
 * ticket is testable without a port: the hub turns this into HTTP and decides
 * nothing.
 */
export function answerTicketRequest(
  request: TicketRequest,
  { token, tickets }: TicketExchange,
): TicketResponse {
  // Before the credential is looked at, so that a client with a good token and
  // the wrong verb is told about the verb. A GET here would be prefetchable,
  // cacheable, and would put the exchange somewhere a link can reach it.
  if (request.method !== 'POST') {
    return { status: 405, body: { error: `${CLIENT_TICKET_PATH} takes a POST` } };
  }

  const presented = bearerCredential(request.authorization);
  // An absent credential and a wrong one are the same answer. A caller that
  // could tell them apart would have a way to probe for the header's name.
  if (presented === null || !tokenMatches(presented, token)) {
    return { status: 401, body: { error: NOT_AUTHORIZED } };
  }

  return { status: 200, body: tickets.issue() };
}

/**
 * Decides an upgrade from its URL, spending the ticket it carries.
 *
 * The URL is the whole input, and `ticket` is the only parameter read from it.
 * That is what makes "the long-lived credential is never accepted from a query
 * string" a property of the code rather than a promise: there is no branch here
 * that compares anything to the token.
 */
export function admitsUpgrade(url: string, tickets: ClientTickets): boolean {
  let presented: readonly string[];
  try {
    presented = new URL(url, REQUEST_BASE).searchParams.getAll(TICKET_PARAM);
  } catch {
    return false;
  }

  // Exactly one. Two tickets is a client asking this hub to choose which
  // credential it meant, and choosing is how a check gets bypassed.
  const ticket = presented.length === 1 ? presented[0] : undefined;
  if (ticket === undefined || ticket.length === 0) return false;

  return tickets.redeem(ticket);
}
