import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNodeSetupMachine } from './node-setup-machine.js';
import { findProgram } from './setup-machine.js';

/**
 * The real filesystem, because every question this seam answers is a question
 * about one.
 *
 * The cases that matter are the ones a mode-bit check gets wrong: a file that is
 * there and not executable, and a *directory* named like a program, which
 * answers `X_OK` because that bit means "searchable" on a directory. Both are
 * how a wizard ends up recording a directory that has no provider in it.
 */

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentplex-setup-machine-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the real setup machine', () => {
  it('finds an executable program and skips a file that is not one', async () => {
    const withProgram = join(root, 'bin');
    const withoutProgram = join(root, 'sbin');
    await mkdir(withProgram, { recursive: true });
    await mkdir(withoutProgram, { recursive: true });
    await writeFile(join(withProgram, 'claude'), '#!/bin/sh\n');
    await chmod(join(withProgram, 'claude'), 0o755);
    await writeFile(join(withoutProgram, 'claude'), '#!/bin/sh\n');
    await chmod(join(withoutProgram, 'claude'), 0o644);

    const machine = createNodeSetupMachine({
      home: root,
      path: [withoutProgram, withProgram].join(delimiter),
    });

    expect(await findProgram('claude', machine)).toEqual([withProgram]);
  });

  it('does not mistake a directory for a program', async () => {
    const directory = join(root, 'trap');
    await mkdir(join(directory, 'claude'), { recursive: true });

    const machine = createNodeSetupMachine({ home: root, path: directory });

    expect(await findProgram('claude', machine)).toEqual([]);
  });

  it('reads a directory as a directory and a file as not one', async () => {
    const machine = createNodeSetupMachine({ home: root, path: undefined });

    expect(await machine.isDirectory(root)).toBe(true);
    expect(await machine.isDirectory(join(root, 'bin', 'claude'))).toBe(false);
    expect(await machine.isDirectory(join(root, 'nothing-here'))).toBe(false);
  });

  it('takes an absent PATH as no directories rather than as one empty one', async () => {
    // An empty entry in a PATH means the current directory, and a provider
    // adopted out of whatever directory setup was started in is a recorded
    // binPath that means something different on every boot.
    expect(createNodeSetupMachine({ home: root, path: undefined }).pathDirectories).toEqual([]);
    expect(createNodeSetupMachine({ home: root, path: '' }).pathDirectories).toEqual([]);
    expect(
      createNodeSetupMachine({ home: root, path: `${delimiter}/usr/bin${delimiter}` })
        .pathDirectories,
    ).toEqual(['/usr/bin']);
  });
});
