import { describe, expect, it } from 'vitest';
import { createScanCache } from './scan-cache.js';

const PATH = '/volumes/claude/projects/-Users-dev/session.jsonl';
const OTHER = '/volumes/claude/projects/-Users-dev/other.jsonl';

/** A loader that answers `value` and counts how often it was asked. */
function loader<T>(value: T): { load: () => Promise<T>; calls: () => number } {
  let calls = 0;
  return {
    load: () => {
      calls += 1;
      return Promise.resolve(value);
    },
    calls: () => calls,
  };
}

describe('createScanCache.resolve', () => {
  it('loads a path it has never seen', async () => {
    const cache = createScanCache<string>();
    const first = loader('parsed');

    expect(await cache.resolve(PATH, { size: 10, mtimeMs: 1000 }, first.load)).toBe('parsed');
    expect(first.calls()).toBe(1);
  });

  it('answers from memory, without loading, when size and mtime are unchanged', async () => {
    const cache = createScanCache<string>();
    await cache.resolve(PATH, { size: 10, mtimeMs: 1000 }, loader('parsed').load);
    const second = loader('re-parsed');

    expect(await cache.resolve(PATH, { size: 10, mtimeMs: 1000 }, second.load)).toBe('parsed');
    expect(second.calls()).toBe(0);
  });

  it('loads again when the file grew, which is a turn appended', async () => {
    const cache = createScanCache<string>();
    await cache.resolve(PATH, { size: 10, mtimeMs: 1000 }, loader('parsed').load);
    const second = loader('grown');

    expect(await cache.resolve(PATH, { size: 20, mtimeMs: 2000 }, second.load)).toBe('grown');
    expect(second.calls()).toBe(1);
  });

  it('loads again when the file shrank, which is a rewrite rather than an append', async () => {
    const cache = createScanCache<string>();
    await cache.resolve(PATH, { size: 10, mtimeMs: 1000 }, loader('parsed').load);
    const second = loader('truncated');

    expect(await cache.resolve(PATH, { size: 4, mtimeMs: 1000 }, second.load)).toBe('truncated');
    expect(second.calls()).toBe(1);
  });

  it('loads again when only the mtime moved, since a same-size rewrite is still a rewrite', async () => {
    const cache = createScanCache<string>();
    await cache.resolve(PATH, { size: 10, mtimeMs: 1000 }, loader('parsed').load);
    const second = loader('rewritten');

    expect(await cache.resolve(PATH, { size: 10, mtimeMs: 1001 }, second.load)).toBe('rewritten');
    expect(second.calls()).toBe(1);
  });

  it('remembers the newest load, not the first', async () => {
    const cache = createScanCache<string>();
    await cache.resolve(PATH, { size: 10, mtimeMs: 1000 }, loader('parsed').load);
    await cache.resolve(PATH, { size: 20, mtimeMs: 2000 }, loader('grown').load);
    const third = loader('unused');

    expect(await cache.resolve(PATH, { size: 20, mtimeMs: 2000 }, third.load)).toBe('grown');
    expect(third.calls()).toBe(0);
  });

  it('keeps each path to itself', async () => {
    const cache = createScanCache<string>();
    await cache.resolve(PATH, { size: 10, mtimeMs: 1000 }, loader('mine').load);
    const other = loader('theirs');

    expect(await cache.resolve(OTHER, { size: 10, mtimeMs: 1000 }, other.load)).toBe('theirs');
    expect(other.calls()).toBe(1);
  });

  it('does not remember a value it was told not to keep', async () => {
    // A read that failed is a fact about this moment, not about the file at
    // this stamp: a permission fixed without touching the file leaves its
    // size and mtime where they were, and a remembered failure would outlive
    // the fault for as long as the file does.
    const cache = createScanCache<string>({ keep: (value) => value !== 'failed' });
    await cache.resolve(PATH, { size: 10, mtimeMs: 1000 }, loader('failed').load);
    const second = loader('parsed');

    expect(await cache.resolve(PATH, { size: 10, mtimeMs: 1000 }, second.load)).toBe('parsed');
    expect(second.calls()).toBe(1);
  });
});

describe('createScanCache.retain', () => {
  it('drops a path this scan did not see, so a deleted file costs no memory', async () => {
    const cache = createScanCache<string>();
    await cache.resolve(PATH, { size: 10, mtimeMs: 1000 }, loader('mine').load);
    await cache.resolve(OTHER, { size: 10, mtimeMs: 1000 }, loader('theirs').load);

    cache.retain(new Set([OTHER]));

    const reloaded = loader('reloaded');
    expect(await cache.resolve(PATH, { size: 10, mtimeMs: 1000 }, reloaded.load)).toBe('reloaded');
    expect(reloaded.calls()).toBe(1);
    const kept = loader('unused');
    expect(await cache.resolve(OTHER, { size: 10, mtimeMs: 1000 }, kept.load)).toBe('theirs');
    expect(kept.calls()).toBe(0);
  });
});
