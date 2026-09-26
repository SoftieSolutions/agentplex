import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DirectoryRead } from './directory-browse.js';
import { nodeDirectoryReader } from './node-directory-reader.js';

/**
 * The seam against the runtime that answers it.
 *
 * `directory-browse.test.ts` says what the rule does with a read; this says the
 * real `opendir` gives the read the seam promises. The claims worth pinning are
 * the cap -- no more than `limit` entries come back, and `more` says whether the
 * directory held another -- and that each entry's kind is the entry's own, a
 * link reported as a link rather than as what it points at.
 */

const LIMIT = 3;

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'agentplex-directory-reader-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function files(directory: string, count: number): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    await writeFile(join(directory, `file-${index}`), '', 'utf8');
  }
}

function read(outcome: DirectoryRead): Extract<DirectoryRead, { kind: 'read' }> {
  if (outcome.kind !== 'read') throw new Error(`expected a read, got: ${outcome.reason}`);
  return outcome;
}

describe('nodeDirectoryReader.read', () => {
  it('stops at the limit and says the directory holds more', async () => {
    const directory = join(scratch, 'over');
    await files(directory, LIMIT + 1);

    const outcome = read(await nodeDirectoryReader.read(directory, LIMIT));
    expect(outcome.entries).toHaveLength(LIMIT);
    expect(outcome.more).toBe(true);
  });

  it('reads a directory at the limit whole and says there is no more', async () => {
    const directory = join(scratch, 'at');
    await files(directory, LIMIT);

    const outcome = read(await nodeDirectoryReader.read(directory, LIMIT));
    expect(outcome.entries.map((entry) => entry.name).sort()).toEqual([
      'file-0',
      'file-1',
      'file-2',
    ]);
    expect(outcome.more).toBe(false);
  });

  it('reports a file, a directory and a link as each one is, never following the link', async () => {
    const directory = join(scratch, 'kinds');
    await mkdir(join(directory, 'folder'), { recursive: true });
    await writeFile(join(directory, 'plain'), '', 'utf8');
    await symlink(join(directory, 'folder'), join(directory, 'link'));

    const outcome = read(await nodeDirectoryReader.read(directory, LIMIT));
    const kinds = Object.fromEntries(outcome.entries.map((entry) => [entry.name, entry.kind]));
    expect(kinds).toEqual({ plain: 'file', folder: 'directory', link: 'other' });
    expect(outcome.more).toBe(false);
  });

  it('fails on a path that is a file rather than a directory', async () => {
    const path = join(scratch, 'plain');
    await writeFile(path, '', 'utf8');

    const outcome = await nodeDirectoryReader.read(path, LIMIT);
    expect(outcome.kind).toBe('failed');
  });
});
