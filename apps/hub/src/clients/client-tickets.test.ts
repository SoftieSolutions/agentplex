import { describe, expect, it } from 'vitest';
import { createClientTickets, CLIENT_TICKET_LIFETIME_MS } from './client-tickets.js';

/** A clock a test moves by hand. */
function fakeClock(start = 1_000): { now(): number; advance(ms: number): void } {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => void (at += ms),
  };
}

function counting(prefix = 'ticket'): { newToken(): string } {
  let next = 0;
  return { newToken: () => `${prefix}-${(next += 1)}` };
}

function tickets(clock = fakeClock(), tokens = counting()) {
  return { clock, tokens, store: createClientTickets({ clock, tokens }) };
}

describe('createClientTickets', () => {
  it('issues what the minter produced', () => {
    const { store } = tickets();
    expect(store.issue().ticket).toBe('ticket-1');
    expect(store.issue().ticket).toBe('ticket-2');
  });

  it('says how long the ticket has, so a client knows it must hurry', () => {
    const { store } = tickets();
    expect(store.issue().expiresInMs).toBe(CLIENT_TICKET_LIFETIME_MS);
  });

  it('redeems a ticket it issued', () => {
    const { store } = tickets();
    const { ticket } = store.issue();
    expect(store.redeem(ticket)).toBe(true);
  });

  /**
   * The single-use rule, and the reason a ticket may travel in a query string
   * at all: a URL ends up in a proxy log, a browser history and a referrer
   * header, so what leaks has to be something already spent.
   */
  it('refuses the second redemption of a ticket', () => {
    const { store } = tickets();
    const { ticket } = store.issue();
    expect(store.redeem(ticket)).toBe(true);
    expect(store.redeem(ticket)).toBe(false);
  });

  it('refuses a ticket once its lifetime has passed', () => {
    const { clock, store } = tickets();
    const { ticket } = store.issue();
    clock.advance(CLIENT_TICKET_LIFETIME_MS + 1);
    expect(store.redeem(ticket)).toBe(false);
  });

  it('still accepts a ticket at the last moment of its lifetime', () => {
    const { clock, store } = tickets();
    const { ticket } = store.issue();
    clock.advance(CLIENT_TICKET_LIFETIME_MS);
    expect(store.redeem(ticket)).toBe(true);
  });

  it('refuses a ticket it never issued', () => {
    const { store } = tickets();
    store.issue();
    expect(store.redeem('ticket-not-from-here')).toBe(false);
  });

  it('refuses an empty ticket without matching an empty entry', () => {
    const { store } = tickets(fakeClock(), { newToken: () => '' });
    store.issue();
    expect(store.redeem('')).toBe(true);
    expect(store.redeem('')).toBe(false);
  });

  it('keeps tickets apart: redeeming one does not spend another', () => {
    const { store } = tickets();
    const first = store.issue().ticket;
    const second = store.issue().ticket;
    expect(store.redeem(second)).toBe(true);
    expect(store.redeem(first)).toBe(true);
  });

  /**
   * Nothing sweeps on a timer, so issuing has to be what drops the dead ones.
   * A hub whose client opens the page and walks away must not accumulate a
   * ticket per attempt for as long as the process lives.
   */
  it('forgets expired tickets rather than holding them forever', () => {
    const { clock, store } = tickets();
    for (let index = 0; index < 5; index += 1) store.issue();
    expect(store.outstanding).toBe(5);

    clock.advance(CLIENT_TICKET_LIFETIME_MS + 1);
    store.issue();
    expect(store.outstanding).toBe(1);
  });

  it('takes a lifetime, so a deployment can shorten it', () => {
    const clock = fakeClock();
    const store = createClientTickets({ clock, tokens: counting(), lifetimeMs: 500 });
    const { ticket, expiresInMs } = store.issue();
    expect(expiresInMs).toBe(500);
    clock.advance(501);
    expect(store.redeem(ticket)).toBe(false);
  });
});
