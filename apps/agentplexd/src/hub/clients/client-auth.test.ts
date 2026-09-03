import { describe, expect, it } from 'vitest';
import {
  admitsUpgrade,
  answerTicketRequest,
  bearerCredential,
  requestPath,
  CLIENT_SOCKET_PATH,
  CLIENT_TICKET_PATH,
  NOT_AUTHORIZED,
} from './client-auth.js';
import { createClientTickets, type ClientTickets } from './client-tickets.js';

const TOKEN = 'the-client-token-typed-on-the-device';

function tickets(): ClientTickets {
  let next = 0;
  return createClientTickets({
    clock: { now: () => 1_000 },
    tokens: { newToken: () => `ticket-${(next += 1)}` },
  });
}

describe('bearerCredential', () => {
  it('reads the token out of a bearer header', () => {
    expect(bearerCredential(`Bearer ${TOKEN}`)).toBe(TOKEN);
  });

  it('accepts the scheme in any case, as the header is case-insensitive', () => {
    expect(bearerCredential(`bearer ${TOKEN}`)).toBe(TOKEN);
    expect(bearerCredential(`BEARER ${TOKEN}`)).toBe(TOKEN);
  });

  it('tolerates extra space between the scheme and the token', () => {
    expect(bearerCredential(`Bearer   ${TOKEN}  `)).toBe(TOKEN);
  });

  it('refuses a header with no scheme, a different scheme, or nothing after it', () => {
    expect(bearerCredential(TOKEN)).toBeNull();
    expect(bearerCredential(`Basic ${TOKEN}`)).toBeNull();
    expect(bearerCredential('Bearer')).toBeNull();
    expect(bearerCredential('Bearer ')).toBeNull();
  });

  it('refuses a header that is absent or repeated', () => {
    expect(bearerCredential(undefined)).toBeNull();
    // Node hands a repeated header up as an array for some header names and
    // joined for others. Either way two credentials is not one credential.
    expect(bearerCredential([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`])).toBeNull();
  });

  it('refuses a token with a space in it rather than taking the first word', () => {
    expect(bearerCredential('Bearer one two')).toBeNull();
  });
});

describe('requestPath', () => {
  it('is the path without the query, so it can be logged', () => {
    expect(requestPath('/client?ticket=secret')).toBe(CLIENT_SOCKET_PATH);
    expect(requestPath('/client/ticket')).toBe(CLIENT_TICKET_PATH);
  });

  it('normalizes, so no path can be dressed up as another', () => {
    expect(requestPath('/client/ticket/../ticket')).toBe(CLIENT_TICKET_PATH);
    expect(requestPath('/health/../client/ticket')).toBe(CLIENT_TICKET_PATH);
    expect(requestPath('/clientele')).toBe('/clientele');
    expect(requestPath('/client/ticket/')).not.toBe(CLIENT_TICKET_PATH);
  });

  it('is a path even when the request line is absent or absolute', () => {
    expect(requestPath(undefined)).toBe('/');
    expect(requestPath('http://hub.example/client?ticket=secret')).toBe(CLIENT_SOCKET_PATH);
  });
});

describe('answerTicketRequest', () => {
  const answer = (
    method: string,
    authorization: string | string[] | undefined,
    store: ClientTickets,
  ) => answerTicketRequest({ method, authorization }, { token: TOKEN, tickets: store });

  it('exchanges the credential for a ticket', () => {
    const store = tickets();
    const response = answer('POST', `Bearer ${TOKEN}`, store);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ticket: 'ticket-1', expiresInMs: 10_000 });
  });

  it('refuses a wrong credential with 401 and the one fact', () => {
    const store = tickets();
    const response = answer('POST', 'Bearer not-the-client-token', store);
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: NOT_AUTHORIZED });
    expect(store.outstanding).toBe(0);
  });

  it('refuses a missing credential the same way it refuses a wrong one', () => {
    const store = tickets();
    expect(answer('POST', undefined, store)).toEqual(
      answer('POST', 'Bearer not-the-client-token', store),
    );
  });

  /**
   * The whole reason the exchange exists. A long-lived credential in a URL is
   * in a log file, and no endpoint here is allowed to read one from there — so
   * the credential has exactly one place it can be presented, and this function
   * is given only that place to look.
   */
  it('has no way to read a credential from anywhere but the header', () => {
    const store = tickets();
    const response = answer('POST', undefined, store);
    expect(response.status).toBe(401);
  });

  it('refuses a method that is not POST, without saying anything about the credential', () => {
    const store = tickets();
    const response = answer('GET', `Bearer ${TOKEN}`, store);
    expect(response.status).toBe(405);
    expect(store.outstanding).toBe(0);
  });

  it('issues a fresh ticket every time', () => {
    const store = tickets();
    const first = answer('POST', `Bearer ${TOKEN}`, store);
    const second = answer('POST', `Bearer ${TOKEN}`, store);
    expect(first.body).not.toEqual(second.body);
  });
});

describe('admitsUpgrade', () => {
  it('admits a socket presenting a ticket that was issued', () => {
    const store = tickets();
    const { ticket } = store.issue();
    expect(admitsUpgrade(`${CLIENT_SOCKET_PATH}?ticket=${ticket}`, store)).toBe(true);
  });

  it('admits it once and never again', () => {
    const store = tickets();
    const { ticket } = store.issue();
    const url = `${CLIENT_SOCKET_PATH}?ticket=${ticket}`;
    expect(admitsUpgrade(url, store)).toBe(true);
    expect(admitsUpgrade(url, store)).toBe(false);
  });

  it('refuses a socket with no ticket at all', () => {
    expect(admitsUpgrade(CLIENT_SOCKET_PATH, tickets())).toBe(false);
    expect(admitsUpgrade(`${CLIENT_SOCKET_PATH}?ticket=`, tickets())).toBe(false);
  });

  /**
   * The ticket is the only thing this path reads. A client that puts its
   * long-lived credential in the URL has already leaked it, and the least this
   * hub can do is not also accept it.
   */
  it('never accepts the long-lived credential, under any parameter name', () => {
    const store = tickets();
    expect(admitsUpgrade(`${CLIENT_SOCKET_PATH}?token=${TOKEN}`, store)).toBe(false);
    expect(admitsUpgrade(`${CLIENT_SOCKET_PATH}?ticket=${TOKEN}`, store)).toBe(false);
    expect(admitsUpgrade(`${CLIENT_SOCKET_PATH}?authorization=Bearer%20${TOKEN}`, store)).toBe(
      false,
    );
  });

  it('refuses a request presenting two tickets rather than picking one', () => {
    const store = tickets();
    const good = store.issue().ticket;
    expect(admitsUpgrade(`${CLIENT_SOCKET_PATH}?ticket=${good}&ticket=other`, store)).toBe(false);
    // And the good one is still unspent: a refusal must not have consumed it.
    expect(store.outstanding).toBe(1);
  });

  it('refuses a URL it cannot read', () => {
    expect(admitsUpgrade('', tickets())).toBe(false);
  });

  it('decodes the ticket, since a query string is percent-encoded', () => {
    const store = createClientTickets({
      clock: { now: () => 1_000 },
      tokens: { newToken: () => 'has spaces and +' },
    });
    const { ticket } = store.issue();
    expect(admitsUpgrade(`${CLIENT_SOCKET_PATH}?ticket=${encodeURIComponent(ticket)}`, store)).toBe(
      true,
    );
  });
});
