import { describe, expect, it } from 'vitest';
import { createFakeStoreFiles } from './fake-store-files.js';
import { ensureServerIdentity } from './server-identity.js';
import { randomTokenMinter } from '@agentplex/node-shared';

const PATH = '/etc/agentplex/server.json';

const ids = { newId: () => 'server-under-test' };
const tokens = { newToken: () => 'token-under-test' };

/**
 * What an orchestrator would inject. Long enough to be a real one, and nothing
 * `tokens` above would ever produce, so a test that finds it found the
 * configured one.
 */
const CONFIGURED = {
  token: 'a-token-the-deployment-already-held-0123',
  setting: 'AGENTPLEX_SERVER_TOKEN',
};

function dependencies(files = createFakeStoreFiles()) {
  return { files, ids, tokens };
}

describe('ensureServerIdentity', () => {
  it('mints an identity the first time the server starts', async () => {
    const result = await ensureServerIdentity(PATH, dependencies());

    expect(result).toEqual({
      ok: true,
      identity: { serverId: 'server-under-test', token: 'token-under-test' },
      minted: true,
    });
  });

  it('writes the identity where it can be read back', async () => {
    const files = createFakeStoreFiles();

    await ensureServerIdentity(PATH, dependencies(files));

    expect(JSON.parse(files.contents.get(PATH) ?? '')).toEqual({
      serverId: 'server-under-test',
      token: 'token-under-test',
    });
  });

  it('reads the same identity on every later start, so a pairing survives a restart', async () => {
    const files = createFakeStoreFiles();
    await ensureServerIdentity(PATH, dependencies(files));

    // A second start with a different id and token source: nothing it produces
    // may reach the answer, or the pairing the user completed would break on
    // the next restart.
    const second = await ensureServerIdentity(PATH, {
      files,
      ids: { newId: () => 'a-different-server' },
      tokens: { newToken: () => 'a-different-token' },
    });

    expect(second).toEqual({
      ok: true,
      identity: { serverId: 'server-under-test', token: 'token-under-test' },
      minted: false,
    });
  });

  it('never mints over a file it cannot read', async () => {
    // The alternative presents the machine to the hub as a server nobody has
    // paired, with a token the user has never seen, and the only symptom is a
    // paired server that quietly stopped answering.
    const files = createFakeStoreFiles({ unreadable: [PATH] });

    const result = await ensureServerIdentity(PATH, dependencies(files));

    expect(result).toMatchObject({ ok: false, path: PATH });
    expect(files.creates).toEqual([]);
  });

  it('refuses a file that is not JSON rather than replacing it', async () => {
    const files = createFakeStoreFiles({ files: { [PATH]: 'half a file' } });

    const result = await ensureServerIdentity(PATH, dependencies(files));

    expect(result).toMatchObject({ ok: false });
    expect(files.contents.get(PATH)).toBe('half a file');
  });

  it('refuses a file that is JSON but not an identity', async () => {
    const files = createFakeStoreFiles({ files: { [PATH]: '{"serverId":""}' } });

    const result = await ensureServerIdentity(PATH, dependencies(files));

    expect(result).toMatchObject({ ok: false });
  });

  it('keeps the fields a later version added, rather than calling the file broken', async () => {
    const files = createFakeStoreFiles({
      files: { [PATH]: '{"serverId":"s1","token":"t1","somethingNewer":true}' },
    });

    const result = await ensureServerIdentity(PATH, dependencies(files));

    expect(result).toMatchObject({ ok: true, identity: { serverId: 's1', token: 't1' } });
  });

  it('reports a mount it cannot write to, rather than coming up with no identity', async () => {
    const files = createFakeStoreFiles({ unwritable: [PATH] });

    const result = await ensureServerIdentity(PATH, dependencies(files));

    expect(result).toMatchObject({ ok: false, path: PATH });
  });

  it('takes the identity that won when two copies start against one file', async () => {
    // The guard is what keeps the winner's own create from re-entering this.
    let winnerHasMinted = false;
    const files = createFakeStoreFiles({
      // The other copy mints between this one's read and its create.
      beforeCreate: async (path) => {
        if (winnerHasMinted) return;
        winnerHasMinted = true;
        await files.createFile(path, '{"serverId":"winner","token":"w"}');
      },
    });

    const result = await ensureServerIdentity(PATH, dependencies(files));

    expect(result).toMatchObject({
      ok: true,
      identity: { serverId: 'winner', token: 'w' },
      minted: false,
    });
  });
});

describe('ensureServerIdentity with a token the deployment set', () => {
  it('takes the configured token rather than minting one nobody knows', async () => {
    // The case the default cannot serve: a container has no disk that outlives
    // it and CI has nobody to read a file off it, so a minted token is a
    // credential that exists only where nothing can reach it.
    const result = await ensureServerIdentity(PATH, {
      ...dependencies(),
      configuredToken: CONFIGURED,
    });

    expect(result).toEqual({
      ok: true,
      identity: { serverId: 'server-under-test', token: CONFIGURED.token },
      minted: true,
    });
  });

  it('writes it to the identity file exactly as a minted one, so nothing downstream changes', async () => {
    // The hub beside a `--role=both` server reads its token off this file, and
    // the grant AGX-204 will migrate this record into is this record. A
    // configured token is a token source and not a second mechanism.
    const files = createFakeStoreFiles();

    await ensureServerIdentity(PATH, { ...dependencies(files), configuredToken: CONFIGURED });

    expect(JSON.parse(files.contents.get(PATH) ?? '')).toEqual({
      serverId: 'server-under-test',
      token: CONFIGURED.token,
    });
  });

  it('refuses to start when the file and the setting name different tokens', async () => {
    // Neither direction of resolving it is safe. Preferring the file leaves a
    // server answering to a credential the operator believes they replaced;
    // preferring the setting rewrites an identity a pairing was completed
    // against.
    const files = createFakeStoreFiles({
      files: { [PATH]: '{"serverId":"server-under-test","token":"the-token-on-the-disk"}' },
    });

    const result = await ensureServerIdentity(PATH, {
      ...dependencies(files),
      configuredToken: CONFIGURED,
    });

    expect(result).toMatchObject({ ok: false, path: PATH });
  });

  it('names the file and the setting in that refusal, and neither token', async () => {
    const files = createFakeStoreFiles({
      files: { [PATH]: '{"serverId":"server-under-test","token":"the-token-on-the-disk"}' },
    });

    const result = await ensureServerIdentity(PATH, {
      ...dependencies(files),
      configuredToken: CONFIGURED,
    });

    const problem = result.ok ? '' : result.problem;
    expect(problem).toContain(PATH);
    expect(problem).toContain(CONFIGURED.setting);
    expect(problem).not.toContain(CONFIGURED.token);
    expect(problem).not.toContain('the-token-on-the-disk');
  });

  it('leaves the disagreeing file exactly as it found it', async () => {
    const contents = '{"serverId":"server-under-test","token":"the-token-on-the-disk"}';
    const files = createFakeStoreFiles({ files: { [PATH]: contents } });

    await ensureServerIdentity(PATH, { ...dependencies(files), configuredToken: CONFIGURED });

    expect(files.contents.get(PATH)).toBe(contents);
    expect(files.creates).toEqual([]);
  });

  it('takes the file when it agrees, and says nothing was minted', async () => {
    const files = createFakeStoreFiles({
      files: { [PATH]: JSON.stringify({ serverId: 's1', token: CONFIGURED.token }) },
    });

    const result = await ensureServerIdentity(PATH, {
      ...dependencies(files),
      configuredToken: CONFIGURED,
    });

    expect(result).toEqual({
      ok: true,
      identity: { serverId: 's1', token: CONFIGURED.token },
      minted: false,
    });
  });

  it('refuses when the copy that won the create race holds another token', async () => {
    // The same disagreement, arriving by the one path that reaches an existing
    // file without having read it first.
    let winnerHasMinted = false;
    const files = createFakeStoreFiles({
      beforeCreate: async (path) => {
        if (winnerHasMinted) return;
        winnerHasMinted = true;
        await files.createFile(path, '{"serverId":"winner","token":"the-winners-token"}');
      },
    });

    const result = await ensureServerIdentity(PATH, {
      ...dependencies(files),
      configuredToken: CONFIGURED,
    });

    expect(result).toMatchObject({ ok: false, path: PATH });
  });

  it('refuses an empty configured token rather than writing an identity nothing can present', async () => {
    const result = await ensureServerIdentity(PATH, {
      ...dependencies(),
      configuredToken: { ...CONFIGURED, token: '' },
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? '' : result.problem).toContain(CONFIGURED.setting);
  });
});

describe('randomTokenMinter', () => {
  it('mints a token with real entropy behind it', () => {
    // 32 bytes base64url. The length is asserted because the thing that would
    // go wrong silently is somebody shortening it.
    expect(randomTokenMinter.newToken()).toHaveLength(43);
  });

  it('never mints the same token twice', () => {
    const minted = new Set(Array.from({ length: 50 }, () => randomTokenMinter.newToken()));
    expect(minted.size).toBe(50);
  });

  it('mints a token that survives being pasted into a form or a shell', () => {
    // base64url, so no padding, no slashes and nothing a YAML file would quote.
    expect(randomTokenMinter.newToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
