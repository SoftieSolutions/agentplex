import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeProviderFiles } from './node-provider-files.js';

/**
 * The one seam that has to be tested against a real filesystem.
 *
 * Everything above it takes a `ProviderFiles` and can be handed a fake, but
 * the claim this file makes is about what Node's errno does — and a claim
 * about a runtime is not settled until it has been run at the origin. A mock
 * of `fs` would only assert that this test and this file agree.
 */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentplex-provider-files-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('nodeProviderFiles.listDirectory', () => {
  it('separates files from the directories a provider keeps beside them', async () => {
    await writeFile(join(root, 'session.jsonl'), '{}\n');
    await mkdir(join(root, 'session'));

    const listing = await nodeProviderFiles.listDirectory(root);

    expect(listing.kind === 'read' && [...listing.entries].sort(byName)).toEqual([
      { name: 'session', kind: 'directory' },
      { name: 'session.jsonl', kind: 'file' },
    ]);
  });

  it('calls a directory that is not there missing, not failed', async () => {
    // The difference the whole seam exists for: a store no Claude Code has
    // written into has no `projects/`, and that is normal.
    const listing = await nodeProviderFiles.listDirectory(join(root, 'projects'));

    expect(listing).toEqual({ kind: 'missing' });
  });

  it('calls a file where a directory should be missing too', async () => {
    await writeFile(join(root, 'projects'), 'not a directory');

    const listing = await nodeProviderFiles.listDirectory(join(root, 'projects'));

    expect(listing).toEqual({ kind: 'missing' });
  });

  it('reports a symlink as neither a file nor a directory', async () => {
    // Not followed. Discovery walks a directory another program writes into,
    // and a link is the cheapest way to point it out of the store or into a
    // cycle. Reporting the entry and declining to open it costs nothing real:
    // a provider that wants its transcripts found writes them where it says.
    await writeFile(join(root, 'real.jsonl'), '{}\n');
    await symlink(join(root, 'real.jsonl'), join(root, 'link.jsonl'));

    const listing = await nodeProviderFiles.listDirectory(root);

    expect(listing.kind === 'read' && [...listing.entries].sort(byName)).toEqual([
      { name: 'link.jsonl', kind: 'other' },
      { name: 'real.jsonl', kind: 'file' },
    ]);
  });
});

describe('nodeProviderFiles.readFile', () => {
  it('reads a transcript back byte for byte', async () => {
    await writeFile(join(root, 'session.jsonl'), '{"type":"user"}\n');

    const read = await nodeProviderFiles.readFile(join(root, 'session.jsonl'));

    expect(read).toEqual({ kind: 'read', contents: '{"type":"user"}\n' });
  });

  it('calls a transcript that is gone missing rather than failing over it', async () => {
    // Transcripts are deleted while a listing is being walked. A session that
    // no longer exists is not a session this server failed to read.
    const read = await nodeProviderFiles.readFile(join(root, 'gone.jsonl'));

    expect(read).toEqual({ kind: 'missing' });
  });

  it('fails, rather than reporting nothing, when the path is a directory', async () => {
    await mkdir(join(root, 'session'));

    const read = await nodeProviderFiles.readFile(join(root, 'session'));

    expect(read.kind).toBe('failed');
  });
});

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name);
}
