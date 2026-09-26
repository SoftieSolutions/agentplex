import { describe, expect, it } from 'vitest';
import {
  tokenDigest,
  type Clock,
  type IdGenerator,
  type TokenMinter,
} from '@agentplex/node-shared';
import type { HubId } from '@agentplex/protocol';
import {
  openServerGrants,
  type GrantWitness,
  type ServerGrantStore,
} from './server-grant-store.js';
import { GRANT_ZERO_LABEL, parseServerGrants, type GrantId } from './server-grants.js';
import { createFakeGrantFiles, type FakeGrantFiles } from './fake-grant-files.js';

const PATH = '/var/lib/agentplex/server-grants.json';
const IDENTITY_TOKEN = 'the-token-in-the-identity-file';
const HUB = 'hub-one' as HubId;

function counting(prefix: string): IdGenerator {
  let next = 0;
  return { newId: () => `${prefix}-${(next += 1)}` };
}

function ticking(start = 1_700_000_000_000): Clock & { set(at: number): void } {
  let now = start;
  return {
    now: () => now,
    set: (at: number) => void (now = at),
  };
}

const tokens: TokenMinter = (() => {
  let next = 0;
  return { newToken: () => `minted-token-${(next += 1)}` };
})();

async function open(
  files: FakeGrantFiles = createFakeGrantFiles(),
  extras: { readonly clock?: Clock; readonly onWitness?: (witness: GrantWitness) => void } = {},
): Promise<{ store: ServerGrantStore; files: FakeGrantFiles; migrated: boolean }> {
  const ready = await openServerGrants(PATH, IDENTITY_TOKEN, {
    files,
    ids: counting('grant'),
    tokens,
    clock: extras.clock ?? ticking(),
    onWitness: extras.onWitness,
  });
  if (!ready.ok) throw new Error(`the grants file did not open: ${ready.problem}`);
  return { store: ready.store, files, migrated: ready.migrated };
}

function storedGrants(files: FakeGrantFiles) {
  const written = files.written(PATH);
  if (written === undefined) throw new Error('nothing was written');
  const parsed = parseServerGrants(written);
  if (!parsed.ok) throw new Error(parsed.problem);
  return parsed.grants;
}

describe('openServerGrants: the migration to grant zero', () => {
  it('writes one grant for the token already in the identity file', async () => {
    const { files, migrated } = await open();
    expect(migrated).toBe(true);

    const grants = storedGrants(files);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.label).toBe(GRANT_ZERO_LABEL);
    expect(grants[0]?.verifier).toBe(tokenDigest(IDENTITY_TOKEN));
    expect(grants[0]?.expiresAt).toBeNull();
    expect(grants[0]?.revokedAt).toBeNull();
  });

  /** The token the operator pastes into the hub keeps working, unchanged. */
  it('leaves the identity file token authorizing a handshake', async () => {
    const { store } = await open();
    const authorized = await store.authorize({ token: IDENTITY_TOKEN, hubId: HUB });
    expect(authorized.ok).toBe(true);
  });

  it('writes nothing on a second boot', async () => {
    const { files } = await open();
    expect(files.writes(PATH)).toBe(1);
    const again = await open(files);
    expect(again.migrated).toBe(false);
    expect(files.writes(PATH)).toBe(1);
  });

  /**
   * A revocation is a person having said no, and a boot that wrote grant zero
   * back would be the server undoing it -- the same rule `local-server.ts`
   * holds from the hub's end.
   */
  it('does not resurrect a grant zero somebody revoked', async () => {
    const { store, files } = await open();
    const zero = storedGrants(files)[0];
    await store.revoke(zero?.grantId ?? ('' as GrantId));

    const again = await open(files);
    expect(again.migrated).toBe(false);
    expect(storedGrants(files)).toHaveLength(1);
    expect(storedGrants(files)[0]?.revokedAt).not.toBeNull();
    const authorized = await again.store.authorize({ token: IDENTITY_TOKEN, hubId: HUB });
    expect(authorized).toEqual({ ok: false, refusal: 'revoked' });
  });

  /**
   * An identity file minted again carries a new token, and the hub beside it
   * reconciles onto that token at its next boot. Without a grant for it the
   * machine would lock its own hub out.
   */
  it('mints a grant for an identity token that has changed', async () => {
    const { files } = await open();
    const ready = await openServerGrants(PATH, 'a-freshly-minted-token', {
      files,
      ids: counting('later'),
      tokens,
      clock: ticking(),
    });
    expect(ready.ok && ready.migrated).toBe(true);
    expect(storedGrants(files)).toHaveLength(2);
  });

  it('refuses to open a grants file it cannot read, rather than starting empty', async () => {
    const files = createFakeGrantFiles({ unreadable: [PATH] });
    const ready = await openServerGrants(PATH, IDENTITY_TOKEN, {
      files,
      ids: counting('grant'),
      tokens,
      clock: ticking(),
    });
    expect(ready.ok).toBe(false);
    if (!ready.ok) expect(ready.problem).toContain('cannot read the grants file');
  });

  it('refuses to open a grants file that does not parse', async () => {
    const files = createFakeGrantFiles({ contents: { [PATH]: '{ "grants": [ { } ] }' } });
    const ready = await openServerGrants(PATH, IDENTITY_TOKEN, {
      files,
      ids: counting('grant'),
      tokens,
      clock: ticking(),
    });
    expect(ready.ok).toBe(false);
  });
});

describe('ServerGrantStore.mint', () => {
  it('hands back a token once and stores only a verifier of it', async () => {
    const { store, files } = await open();
    const minted = await store.mint({ label: 'the hub in the basement', expiresAt: null });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    expect(files.written(PATH)).not.toContain(minted.token);
    expect(files.written(PATH)).toContain(tokenDigest(minted.token));
    expect(JSON.stringify(minted.grant)).not.toContain(minted.token);
  });

  it('mints a grant that then authorizes its own token and nothing else', async () => {
    const { store } = await open();
    const minted = await store.mint({ label: 'ci', expiresAt: null });
    if (!minted.ok) throw new Error(minted.problem);

    const authorized = await store.authorize({ token: minted.token, hubId: HUB });
    expect(authorized).toMatchObject({ ok: true, grantId: minted.grant.grantId, label: 'ci' });
    expect(await store.authorize({ token: 'something-else', hubId: HUB })).toEqual({
      ok: false,
      refusal: 'no-grant',
    });
  });

  it('records the expiry it was asked for', async () => {
    const clock = ticking();
    const { store } = await open(createFakeGrantFiles(), { clock });
    const minted = await store.mint({ label: 'a support session', expiresAt: clock.now() + 60 });
    if (!minted.ok) throw new Error(minted.problem);

    expect(await store.authorize({ token: minted.token, hubId: HUB })).toMatchObject({ ok: true });
    clock.set(clock.now() + 60);
    expect(await store.authorize({ token: minted.token, hubId: HUB })).toEqual({
      ok: false,
      refusal: 'expired',
    });
  });

  it('says so rather than throwing when the disk will not take it', async () => {
    const { store, files } = await open();
    files.breaks(PATH, { writes: true });
    const minted = await store.mint({ label: 'ci', expiresAt: null });
    expect(minted.ok).toBe(false);
    if (!minted.ok) expect(minted.problem).toContain('cannot write the grants file');
  });
});

describe('ServerGrantStore.revoke', () => {
  it('names one grant and leaves every other hub working', async () => {
    const { store } = await open();
    const left = await store.mint({ label: 'left', expiresAt: null });
    const right = await store.mint({ label: 'right', expiresAt: null });
    if (!left.ok || !right.ok) throw new Error('a mint failed');

    const revoked = await store.revoke(left.grant.grantId);
    expect(revoked.ok).toBe(true);

    expect(await store.authorize({ token: left.token, hubId: HUB })).toEqual({
      ok: false,
      refusal: 'revoked',
    });
    expect(await store.authorize({ token: right.token, hubId: HUB })).toMatchObject({ ok: true });
    expect(await store.authorize({ token: IDENTITY_TOKEN, hubId: HUB })).toMatchObject({
      ok: true,
    });
  });

  it('says there is no such grant rather than writing one', async () => {
    const { store, files } = await open();
    const before = files.writes(PATH);
    const revoked = await store.revoke('grant-nobody-minted' as GrantId);
    expect(revoked.ok).toBe(false);
    expect(files.writes(PATH)).toBe(before);
  });

  it('is idempotent and keeps the date of the first no', async () => {
    const clock = ticking();
    const { store } = await open(createFakeGrantFiles(), { clock });
    const minted = await store.mint({ label: 'ci', expiresAt: null });
    if (!minted.ok) throw new Error(minted.problem);

    const first = await store.revoke(minted.grant.grantId);
    clock.set(clock.now() + 10_000);
    const second = await store.revoke(minted.grant.grantId);
    expect(first.ok && second.ok && first.grant.revokedAt).toBe(
      second.ok ? second.grant.revokedAt : null,
    );
  });
});

describe('ServerGrantStore.authorize', () => {
  it('re-reads the file, so a revocation reaches a daemon that is already up', async () => {
    const { store, files } = await open();
    const minted = await store.mint({ label: 'ci', expiresAt: null });
    if (!minted.ok) throw new Error(minted.problem);
    expect(await store.authorize({ token: minted.token, hubId: HUB })).toMatchObject({ ok: true });

    // Somebody else wrote the file: another process, a command, an operator.
    const grants = storedGrants(files).map((grant) =>
      grant.grantId === minted.grant.grantId ? { ...grant, revokedAt: 1 } : grant,
    );
    await files.writeFile(PATH, JSON.stringify({ grants }));

    expect(await store.authorize({ token: minted.token, hubId: HUB })).toEqual({
      ok: false,
      refusal: 'revoked',
    });
  });

  it('records the hub id it saw and reports a later disagreement without refusing', async () => {
    const witnessed: GrantWitness[] = [];
    const { store, files } = await open(createFakeGrantFiles(), {
      onWitness: (witness) => void witnessed.push(witness),
    });

    await store.authorize({ token: IDENTITY_TOKEN, hubId: HUB });
    expect(storedGrants(files)[0]?.firstHubId).toBe(HUB);
    expect(witnessed[0]?.disagrees).toBe(false);

    const rebuilt = 'hub-rebuilt' as HubId;
    const second = await store.authorize({ token: IDENTITY_TOKEN, hubId: rebuilt });
    expect(second.ok).toBe(true);
    expect(witnessed[1]?.disagrees).toBe(true);
    expect(storedGrants(files)[0]?.firstHubId).toBe(HUB);
    expect(storedGrants(files)[0]?.lastHubId).toBe(rebuilt);
  });

  /**
   * Bookkeeping that could not be written must not cost a hub a connection it
   * presented a good credential for.
   */
  it('accepts a good token even when the record of it cannot be written', async () => {
    const witnessed: GrantWitness[] = [];
    const { store, files } = await open(createFakeGrantFiles(), {
      onWitness: (witness) => void witnessed.push(witness),
    });
    files.breaks(PATH, { writes: true });

    expect(await store.authorize({ token: IDENTITY_TOKEN, hubId: HUB })).toMatchObject({
      ok: true,
    });
    expect(witnessed[0]?.unrecorded).toContain('unwritable');
  });

  /**
   * A server that answers to a credential it can no longer check would be
   * over-claiming in the one place it must not: the alternative to refusing is
   * a hub let in on a record nobody could read.
   */
  it('refuses everything while the grants file cannot be read', async () => {
    const { store, files } = await open();
    expect(await store.authorize({ token: IDENTITY_TOKEN, hubId: HUB })).toMatchObject({
      ok: true,
    });

    files.breaks(PATH, { reads: true });
    expect(await store.authorize({ token: IDENTITY_TOKEN, hubId: HUB })).toEqual({
      ok: false,
      refusal: 'no-grant',
    });

    files.breaks(PATH, { reads: false });
    expect(await store.authorize({ token: IDENTITY_TOKEN, hubId: HUB })).toMatchObject({
      ok: true,
    });
  });

  it('does not write twice for one handshake', async () => {
    const { store, files } = await open();
    const before = files.writes(PATH);
    await store.authorize({ token: IDENTITY_TOKEN, hubId: HUB });
    expect(files.writes(PATH)).toBe(before + 1);
  });

  /** Two handshakes landing together must not lose one another's record. */
  it('serializes concurrent writes rather than clobbering', async () => {
    const { store, files } = await open();
    const [left, right] = await Promise.all([
      store.mint({ label: 'left', expiresAt: null }),
      store.mint({ label: 'right', expiresAt: null }),
    ]);
    expect(left.ok && right.ok).toBe(true);
    expect(storedGrants(files)).toHaveLength(3);
  });
});

describe('ServerGrantStore.refused', () => {
  it('names the grants that stopped being usable, in one read', async () => {
    const clock = ticking();
    const { store } = await open(createFakeGrantFiles(), { clock });
    const live = await store.mint({ label: 'live', expiresAt: null });
    const dying = await store.mint({ label: 'dying', expiresAt: clock.now() + 10 });
    const gone = await store.mint({ label: 'gone', expiresAt: null });
    if (!live.ok || !dying.ok || !gone.ok) throw new Error('a mint failed');
    await store.revoke(gone.grant.grantId);
    clock.set(clock.now() + 10);

    const withdrawn = await store.refused([
      live.grant.grantId,
      dying.grant.grantId,
      gone.grant.grantId,
      'grant-nobody-minted' as GrantId,
    ]);
    expect(withdrawn).toEqual([
      { grantId: dying.grant.grantId, refusal: 'expired' },
      { grantId: gone.grant.grantId, refusal: 'revoked' },
      { grantId: 'grant-nobody-minted', refusal: 'no-grant' },
    ]);
  });

  /**
   * A disk that hiccuped must not drop every live hub. The next handshake has a
   * credential to check and refuses on its own; this one has nothing.
   */
  it('withdraws nothing while the file cannot be read', async () => {
    const { store, files } = await open();
    const minted = await store.mint({ label: 'ci', expiresAt: null });
    if (!minted.ok) throw new Error(minted.problem);
    await store.revoke(minted.grant.grantId);
    expect(await store.refused([minted.grant.grantId])).toHaveLength(1);

    files.breaks(PATH, { reads: true });
    expect(await store.refused([minted.grant.grantId])).toEqual([]);
  });
});

describe('ServerGrantStore.list', () => {
  it('shows the label, the dates and the hub each grant claimed, and no verifier', async () => {
    const { store } = await open();
    const minted = await store.mint({ label: 'the hub in the basement', expiresAt: null });
    if (!minted.ok) throw new Error(minted.problem);
    await store.authorize({ token: minted.token, hubId: HUB });

    const listed = await store.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.grants).toHaveLength(2);
    const row = listed.grants[1];
    expect(row?.label).toBe('the hub in the basement');
    expect(row?.lastHubId).toBe(HUB);
    expect(JSON.stringify(listed.grants)).not.toContain(tokenDigest(minted.token));
  });
});
