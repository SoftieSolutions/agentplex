import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureDataRoot } from './data-root.js';
import { nodeDataRoot } from './node-data-root.js';

/**
 * The seam against the runtime that answers it.
 *
 * The fake in `data-root.test.ts` describes what each answer means; this says
 * that the real `mkdir` and `access` produce those answers. The claim worth
 * pinning is the one the module comment makes about a return value:
 * `mkdir(recursive)` resolves with a path when it created something and with
 * `undefined` when the directory was already there, which is the whole of how
 * a first start is told from every later one.
 */

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'agentplex-data-root-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('nodeDataRoot', () => {
  it('creates a data root and every parent it needed', async () => {
    const path = join(scratch, 'state', 'agentplex');

    await expect(ensureDataRoot(path, nodeDataRoot)).resolves.toEqual({
      ok: true,
      path,
      created: true,
    });
  });

  it('says a directory that was already there was not created', async () => {
    const path = join(scratch, 'agentplex');
    await ensureDataRoot(path, nodeDataRoot);

    await expect(ensureDataRoot(path, nodeDataRoot)).resolves.toEqual({
      ok: true,
      path,
      created: false,
    });
  });

  it('refuses a path occupied by a file rather than clobbering it', async () => {
    const path = join(scratch, 'agentplex');
    await writeFile(path, 'not a directory\n', 'utf8');

    const result = await ensureDataRoot(path, nodeDataRoot);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.problem).toContain('is not a directory');
  });

  it('refuses a data root under a file, which is a typo in the path above it', async () => {
    await writeFile(join(scratch, 'state'), 'not a directory\n', 'utf8');
    const path = join(scratch, 'state', 'agentplex');

    const result = await ensureDataRoot(path, nodeDataRoot);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.problem).toContain('not a directory');
  });
});
