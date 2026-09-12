import { describe, expect, it } from 'vitest';
import type { TokenStore } from '../auth/token.js';
import { createBrowserDependencies, parseTicketBody, socketUrl } from './browser.js';

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

describe('createBrowserDependencies', () => {
  function recordingFetch(): { fetch: typeof globalThis.fetch; headers: string[] } {
    const headers: string[] = [];
    return {
      headers,
      fetch: (_input, init) => {
        headers.push(new Headers(init?.headers).get('authorization') ?? '');
        return Promise.resolve(Response.json({ ticket: 'ticket-1', expiresInMs: 10_000 }));
      },
    };
  }

  it('presents the token the store holds at the moment of each exchange', async () => {
    // Read per exchange, not at construction: the settings screen writes the
    // token after the store exists, and the next dial must carry it.
    let stored: string | null = null;
    const tokens: TokenStore = {
      read: () => stored,
      write: (token) => ((stored = token), true),
      clear: () => ((stored = null), true),
    };
    const { fetch, headers } = recordingFetch();
    const dependencies = createBrowserDependencies({ tokens, fetch });

    expect(await dependencies.fetchTicket()).toBe('ticket-1');
    tokens.write('the-token-typed-on-the-device');
    expect(await dependencies.fetchTicket()).toBe('ticket-1');
    tokens.clear();
    expect(await dependencies.fetchTicket()).toBe('ticket-1');

    // No token is an empty Bearer (`Headers` trims the trailing space), which
    // the hub refuses with its ordinary 401; it is never a header left out.
    expect(headers).toEqual(['Bearer', 'Bearer the-token-typed-on-the-device', 'Bearer']);
  });
});
