import { describe, expect, it } from 'vitest';
import { parseTicketBody, socketUrl } from './browser.js';

describe('parseTicketBody', () => {
  it('reads the ticket the hub actually answers with', () => {
    // The exchange's answer shape, as `client-auth.ts` sends it.
    const body = { ticket: 'ticket-1', expiresInMs: 10_000 };
    expect(parseTicketBody(body)).toEqual({ ok: true, value: 'ticket-1' });
  });

  it.each([null, 'ticket-1', {}, { ticket: 7 }, { ticket: '' }])('says no to %j', (raw) => {
    const parsed = parseTicketBody(raw);
    expect(parsed.ok).toBe(false);
  });
});

describe('socketUrl', () => {
  it('carries the ticket, escaped, to the client socket path', () => {
    const url = socketUrl({ protocol: 'http:', host: '192.168.1.20:8080' }, 'a/b+c');
    expect(url).toBe('ws://192.168.1.20:8080/client?ticket=a%2Fb%2Bc');
  });

  it('upgrades to wss when the page itself came over TLS', () => {
    const url = socketUrl({ protocol: 'https:', host: 'hub.example' }, 'ticket-1');
    expect(url).toBe('wss://hub.example/client?ticket=ticket-1');
  });
});
