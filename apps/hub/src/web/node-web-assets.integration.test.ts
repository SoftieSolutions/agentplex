import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createNodeWebAssets } from './node-web-assets.js';

/**
 * The real disk, which is the only thing that can answer the two questions the
 * in-memory root cannot: what the filesystem does with a path that leaves the
 * web root, and which of the errors a read can fail with mean "there is no such
 * file" as opposed to "this one could not be read".
 */

const directory = await mkdtemp(join(tmpdir(), 'agentplex-web-'));

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

await mkdir(join(directory, 'assets'));
await writeFile(join(directory, 'index.html'), '<!doctype html>');
await writeFile(join(directory, 'assets', 'index-abc123.js'), 'console.log(1)');
await writeFile(join(directory, '..', 'agentplex-web-outside.txt'), 'not yours');

const files = createNodeWebAssets(directory);

describe('createNodeWebAssets', () => {
  it('reads a file out of the web root', async () => {
    const bytes = await files.read('assets/index-abc123.js');

    expect(bytes === null ? null : new TextDecoder().decode(bytes)).toBe('console.log(1)');
  });

  it('reports a file that is not there as absent rather than throwing', async () => {
    await expect(files.read('assets/index-gone.js')).resolves.toBeNull();
  });

  it('reports a directory as absent', async () => {
    // A browser can ask for `/assets`, and the answer is that there is no such
    // file. Nothing here lists a directory.
    await expect(files.read('assets')).resolves.toBeNull();
  });

  it('reports a path through a file as absent', async () => {
    await expect(files.read('index.html/deeper')).resolves.toBeNull();
  });

  it('refuses to read outside the web root', async () => {
    // The second of the two independent containment checks. `web-assets.ts`
    // refuses the path before it gets here; this refuses it again, because a
    // guard that holds only while its caller keeps normalizing is not a guard.
    await expect(files.read('../agentplex-web-outside.txt')).resolves.toBeNull();
    await expect(files.read('/etc/passwd')).resolves.toBeNull();
  });

  it('names the root it resolved, for the log line', () => {
    expect(files.root).toBe(directory);
  });
});
