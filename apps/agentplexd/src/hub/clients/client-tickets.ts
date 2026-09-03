import type { Clock } from '../../shared/clock.js';
import { tokenMatches, type TokenMinter } from '../../shared/tokens.js';

/**
 * The short-lived half of client authentication.
 *
 * A browser cannot set a header on a websocket: the `WebSocket` constructor
 * takes a URL and a subprotocol list and nothing else. So whatever authenticates
 * the socket arrives in the query string, and a query string is not a place a
 * long-lived credential can go — it lands in the reverse proxy's access log, in
 * the browser's history, and in a `Referer` header on whatever the page loads
 * next. None of those are places a secret can be withdrawn from.
 *
 * What can survive that is a secret that is worthless by the time it is written
 * down. A ticket is spent by the first redemption and dead a few seconds after
 * it was issued, whichever comes first — both, not either, because each covers
 * what the other does not: single use alone leaves an unredeemed ticket valid
 * forever in a log file, and a deadline alone leaves a copied URL replayable for
 * as long as it lasts.
 *
 * The long-lived credential never comes here. It is presented in a header, to
 * an ordinary HTTP request, which is the one place a browser can put it.
 */

/**
 * How long a ticket lasts.
 *
 * Long enough for a slow phone on a slow network to finish one POST and open
 * one socket, and short enough that a ticket sitting in a proxy log is not a
 * credential. It is not a session length: the socket, once open, is not
 * re-checked against the ticket that opened it.
 */
export const CLIENT_TICKET_LIFETIME_MS = 10_000;

export interface IssuedTicket {
  /** Goes in the query string, and nowhere else, exactly once. */
  readonly ticket: string;
  /** How long the client has to use it. Told, rather than left to be discovered. */
  readonly expiresInMs: number;
}

export interface ClientTickets {
  /** Mints a ticket and remembers it until it is spent or expires. */
  issue(): IssuedTicket;
  /**
   * Spends a ticket. True at most once per issued ticket, and only inside its
   * lifetime.
   */
  redeem(ticket: string): boolean;
  /** How many unspent, unexpired tickets are being held. */
  readonly outstanding: number;
}

export interface ClientTicketsDependencies {
  /**
   * Where a ticket's entropy comes from, injected for the reason the server's
   * pairing token is: a test asserting on a redemption needs to know the value,
   * and a seam is how it gets one without the real build minting anything
   * weaker.
   */
  readonly tokens: TokenMinter;
  /**
   * The expiry seam. A `Timers` would also work and is deliberately not used:
   * expiry has to be decided at the moment of redemption, because a ticket
   * whose validity depended on a callback having fired would be valid for as
   * long as the event loop was busy.
   */
  readonly clock: Clock;
  readonly lifetimeMs?: number;
}

export function createClientTickets(dependencies: ClientTicketsDependencies): ClientTickets {
  const { tokens, clock } = dependencies;
  const lifetimeMs = dependencies.lifetimeMs ?? CLIENT_TICKET_LIFETIME_MS;

  /** Ticket to the last moment it is good for. */
  const outstanding = new Map<string, number>();

  const dropExpired = (at: number): void => {
    for (const [ticket, expiresAt] of outstanding) {
      if (expiresAt < at) outstanding.delete(ticket);
    }
  };

  return {
    issue(): IssuedTicket {
      const at = clock.now();
      // Nothing here runs on a timer, so issuing is what collects the dead. A
      // client that opens the page and walks away leaves a ticket behind every
      // time, and the sweep is what stops that being unbounded.
      dropExpired(at);

      const ticket = tokens.newToken();
      outstanding.set(ticket, at + lifetimeMs);
      return { ticket, expiresInMs: lifetimeMs };
    },

    redeem(ticket: string): boolean {
      const at = clock.now();

      // A scan and a constant-time compare, rather than the map lookup this
      // structure is built for. A `Map.get` on a secret hashes it and compares
      // it with early exit, which is the timing leak `tokenMatches` exists to
      // avoid; and the loop does not stop at the match, so what it takes does
      // not depend on where in the set the ticket was. The set is what a few
      // seconds of issuing produced, so the cost of that is nothing.
      let found: string | null = null;
      for (const [candidate, expiresAt] of outstanding) {
        if (tokenMatches(ticket, candidate) && expiresAt >= at) found = candidate;
      }

      dropExpired(at);
      if (found === null) return false;

      // Spent, whatever happens next. A socket that fails to be served is not a
      // reason to hand the ticket back: it was written into a URL the moment it
      // was used, and a second chance is exactly what must not exist.
      outstanding.delete(found);
      return true;
    },

    get outstanding(): number {
      return outstanding.size;
    },
  };
}
