import { describe, expect, it } from 'vitest';
import { admitsMcpRequest } from './mcp-auth.js';

/**
 * The gate in front of the endpoint, as a value.
 *
 * Every rule about who may speak MCP to this hub is decided here, so none of it
 * needs a port to exercise. What a refusal is turned into -- a 401 with the same
 * two words the ticket exchange uses, and nothing an MCP client could mistake
 * for a protocol answer -- is `mcp.integration.test.ts`.
 */

const TOKEN = 'the-client-token-typed-on-the-device';

describe('the MCP bearer gate', () => {
  it('admits the client token', () => {
    expect(admitsMcpRequest(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it('reads the scheme without caring how it was capitalised', () => {
    expect(admitsMcpRequest(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(admitsMcpRequest(`BEARER ${TOKEN}`, TOKEN)).toBe(true);
  });

  it('refuses a wrong token', () => {
    expect(admitsMcpRequest(`Bearer ${TOKEN}-nearly`, TOKEN)).toBe(false);
  });

  it('refuses an absent header exactly as it refuses a wrong one', () => {
    expect(admitsMcpRequest(undefined, TOKEN)).toBe(false);
  });

  it('refuses another scheme carrying the right secret', () => {
    // The token is correct and the request still fails. `Basic` and
    // `Authorization: <token>` are two ways of asking this hub to find a
    // credential somewhere in a header, and finding one is how a parser turns
    // into a search.
    expect(admitsMcpRequest(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(admitsMcpRequest(TOKEN, TOKEN)).toBe(false);
  });

  it('refuses two headers, even when one of them is right', () => {
    // Node hands a repeated header up as an array. Picking either element would
    // be this function deciding which credential the caller meant.
    expect(admitsMcpRequest([`Bearer ${TOKEN}`, 'Bearer nonsense'], TOKEN)).toBe(false);
  });

  it('refuses an empty credential against an empty token', () => {
    // Not reachable through configuration -- `MIN_TOKEN_LENGTH` is 32 -- and
    // asserted anyway, because the shape of this bug is a comparison that
    // succeeds on two absent things.
    expect(admitsMcpRequest('Bearer ', '')).toBe(false);
  });
});
