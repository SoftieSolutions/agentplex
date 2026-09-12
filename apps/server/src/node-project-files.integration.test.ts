import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeProjectFiles } from './node-project-files.js';
import {
  PROJECT_FILES_DIRECTORY,
  PROJECT_FILE_NAME,
  ensureProjectFiles,
  parseProjectFile,
} from './project-files.js';

/**
 * The seam against the runtime that answers it.
 *
 * `project-files.test.ts` describes what each answer means; this says that the
 * real `mkdir` and `writeFile` produce those answers, and that a key really
 * does name a directory on a real filesystem. The claims worth pinning are the
 * two the module comment makes: `wx` fails with `EEXIST` on a file that is
 * there rather than truncating it, and a folder made for one working tree is
 * one directory with one name.
 */

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'agentplex-project-files-'));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('nodeProjectFiles', () => {
  it('makes one folder under the data root and writes the note in it', async () => {
    const result = await ensureProjectFiles(scratch, '/srv/work', nodeProjectFiles);

    expect(result).toMatchObject({ ok: true, created: true, described: true });
    const path = result.ok ? result.path : '';
    const note = parseProjectFile(await readFile(join(path, PROJECT_FILE_NAME), 'utf8'));
    expect(note.ok ? note.file.workingTree : '').toBe('/srv/work');
  });

  it('gives one working tree one directory, however often it is asked', async () => {
    await ensureProjectFiles(scratch, '/srv/work', nodeProjectFiles);
    const again = await ensureProjectFiles(scratch, '/srv/work', nodeProjectFiles);

    expect(again).toMatchObject({ ok: true, created: false });
    await expect(readdir(join(scratch, PROJECT_FILES_DIRECTORY))).resolves.toHaveLength(1);
  });

  it('leaves a note that is already there rather than truncating it', async () => {
    const first = await ensureProjectFiles(scratch, '/srv/work', nodeProjectFiles);
    const note = join(first.ok ? first.path : '', PROJECT_FILE_NAME);
    await writeFile(note, 'written by hand\n', 'utf8');

    await ensureProjectFiles(scratch, '/srv/work', nodeProjectFiles);

    await expect(readFile(note, 'utf8')).resolves.toBe('written by hand\n');
  });

  it('says a folder cannot be made when a file is in the way of the root', async () => {
    await writeFile(join(scratch, PROJECT_FILES_DIRECTORY), 'not a directory\n', 'utf8');

    const result = await ensureProjectFiles(scratch, '/srv/work', nodeProjectFiles);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.problem).toContain('not a directory');
  });

  // The negative rule, against the real disk this time. Two working trees that
  // differ only in a traversal-shaped segment land in two ordinary directories
  // under the project root, and neither of them is anywhere else.
  it('keeps every folder it makes inside the project root', async () => {
    for (const workingTree of ['/srv/work', '/srv/../etc/passwd', '/', '/srv/..']) {
      await ensureProjectFiles(scratch, workingTree, nodeProjectFiles);
    }

    await expect(readdir(scratch)).resolves.toEqual([PROJECT_FILES_DIRECTORY]);
    for (const entry of await readdir(join(scratch, PROJECT_FILES_DIRECTORY))) {
      expect(entry).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });
});
