import { describe, expect, it } from 'vitest';
import { createFakeStoreFiles } from './fake-store-files.js';
import { ensureServerIdentity, randomTokenMinter } from './server-identity.js';

const PATH = '/etc/agentplexd/server.json';

const ids = { newId: () => 'server-under-test' };
const tokens = { newToken: () => 'token-under-test' };

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
