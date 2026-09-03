import { describe, expect, it } from 'vitest';
import { createFakeStoreFiles, type FakeStoreFilesOptions } from './fake-store-files.js';
import {
  ensureStoreIdentity,
  ensureStores,
  parseStoreFile,
  STORE_FILE_NAME,
  type StoreIdentity,
} from './store-identity.js';

const STORE = '/volumes/claude';
const STORE_FILE = `${STORE}/${STORE_FILE_NAME}`;

/** Ids are handed out in order, so a test can name the one it expects. */
function idsFrom(...values: readonly string[]) {
  let next = 0;
  return { newId: () => values[next++] ?? `unexpected-id-${next}` };
}

function volume(options: FakeStoreFilesOptions = {}) {
  return createFakeStoreFiles(options);
}

function identityOf(result: StoreIdentity): string {
  expect(result.ok).toBe(true);
  return result.ok ? result.store.storeId : '';
}

describe('ensureStoreIdentity', () => {
  it('mints the store file at the store root on first use', async () => {
    const files = volume();

    const result = await ensureStoreIdentity(STORE, { files, ids: idsFrom('store-a') });

    expect(result).toMatchObject({
      ok: true,
      minted: true,
      store: { storeId: 'store-a', path: STORE },
    });
    expect(files.creates).toEqual([STORE_FILE]);
  });

  it('writes a file its own parser accepts', async () => {
    const files = volume();

    await ensureStoreIdentity(STORE, { files, ids: idsFrom('store-a') });

    expect(parseStoreFile(files.contents.get(STORE_FILE) ?? '')).toEqual({
      ok: true,
      storeId: 'store-a',
    });
  });

  it('reads the minted id back instead of minting a second one', async () => {
    const files = volume();
    const ids = idsFrom('store-a', 'store-b');

    const first = await ensureStoreIdentity(STORE, { files, ids });
    const second = await ensureStoreIdentity(STORE, { files, ids });

    expect(identityOf(second)).toBe(identityOf(first));
    expect(second).toMatchObject({ ok: true, minted: false });
    expect(files.creates).toEqual([STORE_FILE]);
  });

  it('reports the same storeId to two servers mounting the same volume', async () => {
    const files = volume();

    const one = await ensureStoreIdentity(STORE, { files, ids: idsFrom('minted-by-one') });
    const two = await ensureStoreIdentity(STORE, { files, ids: idsFrom('minted-by-two') });

    expect(identityOf(two)).toBe(identityOf(one));
    expect(identityOf(two)).toBe('minted-by-one');
  });

  it('takes the winner id when another server mints between the read and the create', async () => {
    // Both servers see no file, both try to create; the loser adopts the file
    // that is there rather than the id it had ready.
    let winnerHasMinted = false;
    const files = volume({
      beforeCreate: async (path) => {
        if (winnerHasMinted) return;
        winnerHasMinted = true;
        await files.createFile(path, JSON.stringify({ storeId: 'minted-by-the-winner' }));
      },
    });

    const result = await ensureStoreIdentity(STORE, { files, ids: idsFrom('minted-by-the-loser') });

    expect(identityOf(result)).toBe('minted-by-the-winner');
    expect(result).toMatchObject({ minted: false });
  });

  it('refuses a file that is not JSON rather than minting over it', async () => {
    const files = volume({ files: { [STORE_FILE]: 'half a file' } });

    const result = await ensureStoreIdentity(STORE, { files, ids: idsFrom('store-a') });

    expect(result).toMatchObject({ ok: false, path: STORE });
    expect(files.creates).toEqual([]);
    expect(files.contents.get(STORE_FILE)).toBe('half a file');
  });

  it('refuses a file whose storeId is not a store id', async () => {
    const files = volume({ files: { [STORE_FILE]: JSON.stringify({ storeId: 42 }) } });

    const result = await ensureStoreIdentity(STORE, { files, ids: idsFrom('store-a') });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? '' : result.problem).toContain('storeId');
  });

  it('refuses a store whose file cannot be read, and does not mint a second identity', async () => {
    const files = volume({ unreadable: [STORE_FILE] });

    const result = await ensureStoreIdentity(STORE, { files, ids: idsFrom('store-a') });

    expect(result).toMatchObject({ ok: false, path: STORE });
    expect(files.creates).toEqual([]);
  });

  it('reports a store it cannot write rather than claiming an id nothing recorded', async () => {
    const files = volume({ unwritable: [STORE_FILE] });

    const result = await ensureStoreIdentity(STORE, { files, ids: idsFrom('store-a') });

    expect(result).toMatchObject({ ok: false, path: STORE });
    expect(result.ok ? '' : result.problem).toContain('EROFS');
  });

  it('keeps the store path it was configured with, trailing separator and all', async () => {
    const files = volume();

    const result = await ensureStoreIdentity('/volumes/claude/', {
      files,
      ids: idsFrom('store-a'),
    });

    expect(result).toMatchObject({ ok: true, store: { path: '/volumes/claude/' } });
    expect(files.creates).toEqual([STORE_FILE]);
  });
});

describe('ensureStores', () => {
  it('lets an unreadable store cost itself and not the listing', async () => {
    const broken = '/volumes/broken';
    const files = volume({ unreadable: [`${broken}/${STORE_FILE_NAME}`] });
    const ids = idsFrom('store-a', 'store-b');

    const results = await ensureStores([STORE, broken, '/volumes/other'], { files, ids });

    const mounted = results.filter((result) => result.ok);
    expect(mounted.map((result) => result.store.path)).toEqual([STORE, '/volumes/other']);
    expect(new Set(mounted.map((result) => result.store.storeId)).size).toBe(2);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, path: broken, problem: expect.stringContaining('EACCES') },
    ]);
  });

  it('answers with no stores when none are configured', async () => {
    expect(await ensureStores([], { files: volume(), ids: idsFrom() })).toEqual([]);
  });
});

describe('parseStoreFile', () => {
  it('says no to a bare id, an array, and a missing field', () => {
    for (const contents of ['"store-a"', '["store-a"]', '{}', '{"storeId":""}', 'null']) {
      expect(parseStoreFile(contents)).toMatchObject({ ok: false });
    }
  });

  it('ignores fields a later version may add, so an old server can still read', () => {
    expect(parseStoreFile('{"storeId":"store-a","mintedBy":"a later agentplexd"}')).toEqual({
      ok: true,
      storeId: 'store-a',
    });
  });
});
