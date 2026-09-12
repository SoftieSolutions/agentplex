import { describe, expect, it } from 'vitest';
import { createFakeProjectFiles } from './fake-project-files.js';

/**
 * The fake answers the shapes the real disk does for the same sequence of
 * calls, so that what `project-docs.test.ts` proves against it is something
 * `node-project-files.integration.test.ts` has already proved about the disk.
 */
describe('createFakeProjectFiles', () => {
  it('writes only into a folder that is there, like a real rename would', async () => {
    const files = createFakeProjectFiles();

    expect((await files.writeFile('/root/plan.md', 'x')).kind).toBe('failed');
    await files.createDirectory('/root');
    expect((await files.writeFile('/root/plan.md', 'x')).kind).toBe('written');
    expect(files.writes).toEqual(['/root/plan.md', '/root/plan.md']);
  });

  it('reads back what was written, stamped with the write that produced it', async () => {
    const files = createFakeProjectFiles({ directories: ['/root'] });
    const first = await files.writeFile('/root/plan.md', 'first');
    const second = await files.writeFile('/root/plan.md', 'second');

    const read = await files.readFile('/root/plan.md');

    expect(read).toEqual({
      kind: 'read',
      contents: 'second',
      updatedAt: second.kind === 'written' ? second.updatedAt : -1,
    });
    expect(
      first.kind === 'written' && second.kind === 'written' && first.updatedAt < second.updatedAt,
    ).toBe(true);
  });

  it('says a file nobody wrote is missing, and one nobody may read is a failure', async () => {
    const files = createFakeProjectFiles({
      directories: ['/root'],
      existingFiles: { '/root/locked.md': 'x' },
      unreadableFiles: ['/root/locked.md'],
    });

    expect(await files.readFile('/root/plan.md')).toEqual({ kind: 'missing' });
    expect((await files.readFile('/root/locked.md')).kind).toBe('failed');
  });

  it('lists the files in one folder and not the files in another', async () => {
    const files = createFakeProjectFiles({ directories: ['/root/a', '/root/b'] });
    await files.writeFile('/root/a/plan.md', 'plan');
    await files.writeFile('/root/b/other.md', 'other');

    const listing = await files.listFiles('/root/a');

    expect(listing.kind === 'listed' ? listing.entries.map((entry) => entry.name) : []).toEqual([
      'plan.md',
    ]);
    expect(listing.kind === 'listed' ? listing.entries[0]?.bytes : -1).toBe(4);
    expect(await files.listFiles('/root/c')).toEqual({ kind: 'missing' });
  });

  it('answers a captured listing at a path in place of its own files', async () => {
    const captured = {
      kind: 'listed' as const,
      entries: [{ name: 'plan.md', updatedAt: 1_756_000_000_000, bytes: 7 }],
    };
    const files = createFakeProjectFiles({ listings: { '/root': captured } });

    expect(await files.listFiles('/root')).toBe(captured);
  });
});
