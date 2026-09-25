import { describe, expect, it } from 'vitest';
import {
  DIRECTORY_ENTRIES_MAX,
  directoryListingFrameSchema,
  directorySchema,
  normaliseDirectory,
} from './directory.js';

describe('directorySchema', () => {
  it('accepts an absolute path', () => {
    expect(directorySchema.safeParse('/Users/dev/code/agentplex').success).toBe(true);
  });

  it('refuses a relative path, which would mean a different directory per process', () => {
    expect(directorySchema.safeParse('code/agentplex').success).toBe(false);
    expect(directorySchema.safeParse('./code').success).toBe(false);
    expect(directorySchema.safeParse('').success).toBe(false);
  });

  it('refuses a null byte, which truncates the path at the syscall', () => {
    // What is opened would be a prefix of what was checked: `/srv/work` here,
    // with everything the containment rule looked at thrown away.
    expect(directorySchema.safeParse('/srv/work\u0000/../../etc').success).toBe(false);
  });

  it('leaves the path as written: normalising is the reader machine’s job', () => {
    // `..` is not refused here and is not collapsed here. The server resolves
    // the real path before it checks containment, which is the only place the
    // answer is a fact rather than a guess about somebody else's disk.
    const parsed = directorySchema.parse('/srv/work/../work/');
    expect(parsed).toBe('/srv/work/../work/');
  });
});

describe('directoryListingFrameSchema', () => {
  const listing = {
    type: 'directory-listing',
    replyTo: 3,
    directory: '/srv/work',
    roots: ['/srv/work'],
    entries: [{ name: 'agentplex', kind: 'directory' }],
    truncated: false,
  };

  it('accepts a listing of a directory', () => {
    expect(directoryListingFrameSchema.safeParse(listing).success).toBe(true);
  });

  it('accepts the listing of roots, whose entries carry their own absolute paths', () => {
    expect(
      directoryListingFrameSchema.safeParse({
        ...listing,
        directory: null,
        entries: [{ name: '/srv/work', kind: 'directory' }],
      }).success,
    ).toBe(true);
  });

  it('refuses an entry kind outside the three the protocol knows', () => {
    expect(
      directoryListingFrameSchema.safeParse({
        ...listing,
        entries: [{ name: 'link', kind: 'symlink' }],
      }).success,
    ).toBe(false);
  });

  it('refuses more entries than the cap, so a reader can trust the bound', () => {
    const entries = Array.from({ length: DIRECTORY_ENTRIES_MAX + 1 }, (_unused, index) => ({
      name: `entry-${String(index)}`,
      kind: 'file' as const,
    }));
    expect(directoryListingFrameSchema.safeParse({ ...listing, entries }).success).toBe(false);
  });

  it('refuses a root that is not an absolute path', () => {
    expect(directoryListingFrameSchema.safeParse({ ...listing, roots: ['work'] }).success).toBe(
      false,
    );
  });
});

/**
 * The spelling two peers compare by.
 *
 * The claim that this is "the same normalisation the server's project key uses"
 * is not made by a test here: it is made by `project-files.ts` calling this
 * function, and checked against `node:path`'s own POSIX `normalize` in
 * `apps/server/src/projects/project-files.test.ts`, which is somewhere a Node builtin
 * may be imported. This package is bundled into a browser and may import none.
 */
describe('normaliseDirectory', () => {
  it('drops a trailing separator, so one directory is one project', () => {
    expect(normaliseDirectory('/srv/work/')).toBe('/srv/work');
    expect(normaliseDirectory('/srv/work')).toBe('/srv/work');
  });

  it('collapses a repeated separator and a redundant dot', () => {
    expect(normaliseDirectory('/srv//work')).toBe('/srv/work');
    expect(normaliseDirectory('/srv/./work')).toBe('/srv/work');
  });

  it('resolves a parent reference as a path resolver does', () => {
    expect(normaliseDirectory('/srv/work/../other')).toBe('/srv/other');
    // Past the root is the root, not a climb out of it. Nothing here touches a
    // disk, so this is string semantics and not a containment decision -- the
    // server's rule is what decides whether `/` may be spawned in.
    expect(normaliseDirectory('/../..')).toBe('/');
  });

  it('leaves case, Unicode spelling and near-misses alone', () => {
    // Folding any of these would put one project's sessions under another's on
    // the systems where the paths are genuinely distinct.
    expect(normaliseDirectory('/srv/Work')).toBe('/srv/Work');
    expect(normaliseDirectory('/srv/work-secrets')).toBe('/srv/work-secrets');
    expect(normaliseDirectory('/srv/..work')).toBe('/srv/..work');
  });

  it('answers the root for the paths that collapse to nothing', () => {
    expect(normaliseDirectory('/')).toBe('/');
    expect(normaliseDirectory('//')).toBe('/');
  });
});
