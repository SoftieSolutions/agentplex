import { describe, expect, it } from 'vitest';
import { tokenDigest } from '@agentplex/node-shared';
import type { HubId } from '@agentplex/protocol';
import {
  decideGrant,
  parseServerGrants,
  serializeServerGrants,
  serverGrantsPath,
  summarizeGrant,
  usableGrant,
  witnessedGrant,
  hubIdDisagrees,
  type GrantId,
  type ServerGrant,
} from './server-grants.js';

const NOW = 1_700_000_000_000;

function grant(overrides: Partial<ServerGrant> = {}): ServerGrant {
  return {
    grantId: 'grant-1' as GrantId,
    label: 'the hub in the basement',
    verifier: tokenDigest('a-token'),
    firstHubId: null,
    lastHubId: null,
    createdAt: NOW - 1000,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

describe('parseServerGrants', () => {
  it('reads back what serializeServerGrants wrote', () => {
    const grants = [grant(), grant({ grantId: 'grant-2' as GrantId, label: 'ci' })];
    const parsed = parseServerGrants(serializeServerGrants(grants));
    expect(parsed).toEqual({ ok: true, grants });
  });

  it('reads a file that carries a field this build does not know', () => {
    const written = JSON.stringify({
      grants: [{ ...grant(), scopes: ['read'] }],
      mintedBy: 'a later version',
    });
    const parsed = parseServerGrants(written);
    expect(parsed.ok).toBe(true);
  });

  /**
   * The direction that does not over-claim, and the opposite of what a listing
   * of stores does. A record skipped here would be a record the next write
   * deletes, so a byte of damage would silently remove a pairing.
   */
  it('fails the whole file rather than skipping a record it cannot read', () => {
    const written = JSON.stringify({ grants: [grant(), { grantId: 'grant-2' }] });
    const parsed = parseServerGrants(written);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem).toContain('not a grants file');
  });

  it('refuses something that is not JSON at all', () => {
    const parsed = parseServerGrants('not json');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem).toContain('not JSON');
  });
});

describe('serializeServerGrants', () => {
  it('writes no token, only a verifier of one', () => {
    const written = serializeServerGrants([grant()]);
    expect(written).not.toContain('a-token');
    expect(written).toContain(tokenDigest('a-token'));
  });

  it('is indented with a trailing newline, because a person opens it', () => {
    const written = serializeServerGrants([grant()]);
    expect(written.endsWith('\n')).toBe(true);
    expect(written).toContain('\n  "grants"');
  });
});

describe('serverGrantsPath', () => {
  it('sits beside the identity file and is named after it', () => {
    expect(serverGrantsPath('/var/lib/agentplex/server.json')).toBe(
      '/var/lib/agentplex/server-grants.json',
    );
  });

  /**
   * Two servers configured with two identity files in one directory get two
   * grants files. A fixed name would hand both of them one authorization
   * record, which is the bug the identity file itself refuses.
   */
  it('gives two identity files in one directory two grants files', () => {
    expect(serverGrantsPath('/etc/agentplex/left.json')).not.toBe(
      serverGrantsPath('/etc/agentplex/right.json'),
    );
  });

  it('handles an identity file with no extension', () => {
    expect(serverGrantsPath('/etc/agentplex/identity')).toBe('/etc/agentplex/identity-grants.json');
  });
});

describe('decideGrant', () => {
  it('resolves a token to the grant minted for it', () => {
    const decision = decideGrant([grant()], { token: 'a-token', now: NOW });
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.grant.grantId).toBe('grant-1');
  });

  it('tells two hubs apart by the token each presents', () => {
    const grants = [grant(), grant({ grantId: 'grant-2' as GrantId, verifier: tokenDigest('b') })];
    const first = decideGrant(grants, { token: 'a-token', now: NOW });
    const second = decideGrant(grants, { token: 'b', now: NOW });
    expect(first.ok && first.grant.grantId).toBe('grant-1');
    expect(second.ok && second.grant.grantId).toBe('grant-2');
  });

  it('says no to a token no grant was minted for', () => {
    expect(decideGrant([grant()], { token: 'wrong', now: NOW })).toEqual({
      ok: false,
      refusal: 'no-grant',
    });
  });

  /**
   * Revoking one leaves every other hub working. That is the whole of what the
   * per-pairing shape buys, so it is asserted rather than assumed.
   */
  it('refuses a revoked grant and leaves the others alone', () => {
    const grants = [
      grant({ revokedAt: NOW - 1 }),
      grant({ grantId: 'grant-2' as GrantId, verifier: tokenDigest('b') }),
    ];
    expect(decideGrant(grants, { token: 'a-token', now: NOW })).toEqual({
      ok: false,
      refusal: 'revoked',
    });
    expect(decideGrant(grants, { token: 'b', now: NOW }).ok).toBe(true);
  });

  it('refuses a grant whose expiry has passed and accepts one still inside it', () => {
    expect(decideGrant([grant({ expiresAt: NOW })], { token: 'a-token', now: NOW })).toEqual({
      ok: false,
      refusal: 'expired',
    });
    expect(decideGrant([grant({ expiresAt: NOW + 1 })], { token: 'a-token', now: NOW }).ok).toBe(
      true,
    );
  });

  it('reports a revoked and expired grant as revoked, because that was a person', () => {
    const both = grant({ revokedAt: NOW - 10, expiresAt: NOW - 5 });
    expect(decideGrant([both], { token: 'a-token', now: NOW })).toEqual({
      ok: false,
      refusal: 'revoked',
    });
  });

  it('finds nothing in an empty set rather than throwing', () => {
    expect(decideGrant([], { token: 'a-token', now: NOW })).toEqual({
      ok: false,
      refusal: 'no-grant',
    });
  });
});

describe('usableGrant', () => {
  it('answers the same question about a grant already in hand', () => {
    expect(usableGrant(grant(), NOW).ok).toBe(true);
    expect(usableGrant(grant({ revokedAt: NOW }), NOW)).toEqual({ ok: false, refusal: 'revoked' });
  });
});

describe('witnessedGrant', () => {
  const hub = 'hub-one' as HubId;
  const other = 'hub-two' as HubId;

  it('records the first hub id it ever saw and keeps it', () => {
    const first = witnessedGrant(grant(), hub, NOW);
    expect(first.firstHubId).toBe(hub);
    expect(first.lastHubId).toBe(hub);
    expect(first.lastUsedAt).toBe(NOW);

    const second = witnessedGrant(first, other, NOW + 5);
    expect(second.firstHubId).toBe(hub);
    expect(second.lastHubId).toBe(other);
  });

  it('leaves the grant it was given alone', () => {
    const original = grant();
    witnessedGrant(original, hub, NOW);
    expect(original.firstHubId).toBeNull();
  });
});

describe('hubIdDisagrees', () => {
  /**
   * A rebuilt hub database mints a new id and is legitimately the same operator
   * with the same token. The server records the disagreement; it is the caller
   * that must not turn it into a refusal.
   */
  it('is true only once a different hub id has been seen before', () => {
    expect(hubIdDisagrees(grant(), 'hub-one' as HubId)).toBe(false);
    expect(hubIdDisagrees(grant({ firstHubId: 'hub-one' as HubId }), 'hub-one' as HubId)).toBe(
      false,
    );
    expect(hubIdDisagrees(grant({ firstHubId: 'hub-one' as HubId }), 'hub-two' as HubId)).toBe(
      true,
    );
  });
});

describe('summarizeGrant', () => {
  it('carries everything a listing shows and no verifier', () => {
    const summary = summarizeGrant(grant({ firstHubId: 'hub-one' as HubId }));
    expect(summary).toEqual({
      grantId: 'grant-1',
      label: 'the hub in the basement',
      firstHubId: 'hub-one',
      lastHubId: null,
      createdAt: NOW - 1000,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    });
    expect(JSON.stringify(summary)).not.toContain(tokenDigest('a-token'));
  });
});
