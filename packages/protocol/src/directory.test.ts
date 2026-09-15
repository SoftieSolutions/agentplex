import { describe, expect, it } from 'vitest';
import {
  DIRECTORY_ENTRIES_MAX,
  directoryListingFrameSchema,
  directorySchema,
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
