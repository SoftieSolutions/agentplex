import { mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodeWriteMachine } from './node-write-machine.js';

/**
 * The three primitives the package swap added, against the real filesystem,
 * because what each promises is a fact about one: a link that replaces a link
 * `symlink` alone refuses with EEXIST, a dangling link that is still something
 * at its path, and an entry the tarball packs `-rw-r--r--` made runnable.
 */

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentplex-write-machine-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the real write machine', () => {
  it('replaces a link that is already there, relative target and all', async () => {
    const prefix = join(root, 'replace');
    await mkdir(join(prefix, 'bin'), { recursive: true });
    await mkdir(join(prefix, 'lib', 'old'), { recursive: true });
    await mkdir(join(prefix, 'lib', 'new'), { recursive: true });
    await writeFile(join(prefix, 'lib', 'new', 'main.js'), 'new\n');
    const command = join(prefix, 'bin', 'agentplex');
    await symlink('../lib/old/main.js', command);

    const linked = await nodeWriteMachine.link('../lib/new/main.js', command);

    expect(linked).toEqual({ ok: true });
    expect(await readlink(command)).toBe('../lib/new/main.js');
    expect(await readFile(command, 'utf8')).toBe('new\n');
    expect(await nodeWriteMachine.exists(`${command}.new`)).toBe(false);
  });

  it('counts a dangling link as something, and a missing path as nothing', async () => {
    const dangling = join(root, 'dangling');
    await symlink('nowhere', dangling);

    expect(await nodeWriteMachine.exists(dangling)).toBe(true);
    expect(await nodeWriteMachine.exists(join(root, 'absent'))).toBe(false);
    expect(await nodeWriteMachine.exists(join(root, 'absent', 'below'))).toBe(false);
  });

  it('makes an entry executable', async () => {
    const entry = join(root, 'main.js');
    await writeFile(entry, '#!/usr/bin/env node\n', { mode: 0o644 });

    expect(await nodeWriteMachine.chmod(entry, 0o755)).toEqual({ ok: true });
    expect((await stat(entry)).mode & 0o777).toBe(0o755);
  });

  it('says which path a chmod could not reach', async () => {
    const missing = join(root, 'missing.js');

    const changed = await nodeWriteMachine.chmod(missing, 0o755);

    expect(changed.ok).toBe(false);
    expect(changed.ok ? '' : changed.problem).toContain(missing);
  });

  it('creates a file with the mode it was given, never wider for a moment', async () => {
    const settings = join(root, 'agentplex.env');

    expect(
      await nodeWriteMachine.writeFile(settings, 'AGENTPLEX_ROLE=hub\n', { mode: 0o600 }),
    ).toEqual({ ok: true });
    expect((await stat(settings)).mode & 0o777).toBe(0o600);
    expect(await readFile(settings, 'utf8')).toBe('AGENTPLEX_ROLE=hub\n');
  });
});
