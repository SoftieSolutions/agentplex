import { describe, expect, it } from 'vitest';
import { createFakeProviderFiles } from './fake-provider-files.js';

const PATH = '/volumes/claude/projects/-Users-dev/session.jsonl';

describe('createFakeProviderFiles.stat', () => {
  it('sizes a file in UTF-8 bytes, as the real filesystem does', async () => {
    const files = createFakeProviderFiles({ files: { [PATH]: 'café\n' } });

    const stat = await files.stat(PATH);

    expect(stat.kind === 'read' && stat.size).toBe(6);
  });

  it('moves the mtime of a same-size rewrite nobody gave a new mtime', async () => {
    // A constant stand-in would make this rewrite invisible to anything keyed
    // on the stamp, and the fake would be causing a stale read, not catching one.
    const files = createFakeProviderFiles({ files: { [PATH]: '{"a":1}\n' } });
    const before = await files.stat(PATH);

    files.write(PATH, '{"b":2}\n');
    const after = await files.stat(PATH);

    expect(before.kind === 'read' && after.kind === 'read').toBe(true);
    if (before.kind !== 'read' || after.kind !== 'read') return;
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).not.toBe(before.mtimeMs);
  });

  it('answers the mtime a test states, until a write states another', async () => {
    const files = createFakeProviderFiles({
      files: { [PATH]: '{"a":1}\n' },
      mtimes: { [PATH]: 1_000 },
    });
    expect(await files.stat(PATH)).toEqual({ kind: 'read', size: 8, mtimeMs: 1_000 });

    files.write(PATH, '{"a":1}\n{"b":2}\n', 2_000);

    expect(await files.stat(PATH)).toEqual({ kind: 'read', size: 16, mtimeMs: 2_000 });
  });

  it('stats a file nobody may read, since stat asks the directory and not the file', async () => {
    const files = createFakeProviderFiles({ files: { [PATH]: '{}\n' }, unreadable: [PATH] });

    expect((await files.stat(PATH)).kind).toBe('read');
    expect((await files.readFile(PATH)).kind).toBe('failed');
  });

  it('fails a file named unstatable, and calls a removed one missing', async () => {
    const files = createFakeProviderFiles({ files: { [PATH]: '{}\n' }, unstatable: [PATH] });
    expect((await files.stat(PATH)).kind).toBe('failed');

    files.remove(PATH);

    expect(await files.readFile(PATH)).toEqual({ kind: 'missing' });
  });

  it('records every stat and every whole read, in order', async () => {
    const files = createFakeProviderFiles({ files: { [PATH]: '{}\n' } });

    await files.stat(PATH);
    await files.readFile(PATH);
    await files.readFile(PATH);

    expect(files.stats).toEqual([PATH]);
    expect(files.reads).toEqual([PATH, PATH]);
  });
});
