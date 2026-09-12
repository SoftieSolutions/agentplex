import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeDetachedSpawner } from './fake-process-runner.js';
import { z } from 'zod';
import { startDetached, type DetachedOperation } from './detached-spawn.js';
import { createNodeDetachedSpawner } from './node-process-runner.js';

/**
 * The other way a child is started: forked, handed nothing, and let go of.
 *
 * The parse-then-build guarantee is asserted against the fake, because what is
 * worth checking is the argv a request produced and that an unparseable one
 * produced none. The real spawner is asserted against a real child, because the
 * three things that make it detached -- a process group of its own, no inherited
 * stdio, an unreferenced handle -- are facts about the operating system that no
 * fake can be wrong about on its behalf.
 */

const writeOperation: DetachedOperation<{ readonly interpreter: string; readonly path: string }> = {
  name: 'test.write',
  summary: 'write a file and exit',
  request: z.strictObject({ interpreter: z.string().min(1), path: z.string().min(1) }),
  argv: (request) => ({
    file: request.interpreter,
    args: ['-e', `require('node:fs').writeFileSync(process.argv[1], 'here')`, request.path],
  }),
};

describe('startDetached', () => {
  it('builds the argv from the parsed request', async () => {
    const spawner = createFakeDetachedSpawner();

    const started = await startDetached(
      writeOperation,
      { interpreter: '/usr/bin/node', path: '/tmp/x' },
      spawner,
    );

    expect(started).toEqual({ ok: true });
    expect(spawner.started).toEqual([
      {
        file: '/usr/bin/node',
        args: ['-e', `require('node:fs').writeFileSync(process.argv[1], 'here')`, '/tmp/x'],
      },
    ]);
  });

  /**
   * The argv builder is never reached, so a malformed request cannot contribute
   * an argv element even in principle. The same guarantee `runOperation` makes,
   * and the reason this is a function rather than a call to `spawner.start`.
   */
  it('refuses a request that does not parse, and starts nothing', async () => {
    const spawner = createFakeDetachedSpawner();

    const started = await startDetached(writeOperation, { interpreter: '' }, spawner);

    expect(started.ok).toBe(false);
    expect(started.ok === false && started.problem).toContain('test.write');
    expect(spawner.started).toEqual([]);
  });

  /** A machine that cannot start it is a fact the caller answers for. */
  it('carries the refusal a machine gives back through', async () => {
    const spawner = createFakeDetachedSpawner({ problem: 'ENOENT' });

    const started = await startDetached(
      writeOperation,
      { interpreter: 'node', path: '/tmp/x' },
      spawner,
    );

    expect(started).toEqual({ ok: false, problem: 'ENOENT' });
  });
});

/**
 * A fork, a Node runtime booting, and then a file appearing.
 *
 * The poll below is the guard against a child that never writes, and it was set
 * to exactly vitest's default bound -- so it could never report anything: the
 * suite gave up at the same moment, with a message about a timeout instead of
 * `eventually` returning null and the assertion naming what was missing. The
 * budget is the inner bound and stays where a wedged child is caught quickly;
 * the suite's is now outside it, so the inner one is the one that fires.
 */
const TEST_TIMEOUT_MS = 20_000;

describe('createNodeDetachedSpawner', { timeout: TEST_TIMEOUT_MS }, () => {
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'agentplex-detached-'));
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /**
   * A real child, started and let go of. `start` settles at the fork rather
   * than at the exit -- which is the property under test, since the caller is a
   * command that must not wait -- so the file it writes is looked for
   * afterwards rather than awaited.
   */
  it('starts a child that outlives the call', async () => {
    const path = join(directory, 'written');
    const spawner = createNodeDetachedSpawner({ environment: {} });

    const started = await startDetached(
      writeOperation,
      { interpreter: process.execPath, path },
      spawner,
    );

    expect(started).toEqual({ ok: true });
    expect(await eventually(path)).toBe('here');
  });

  /**
   * The one failure this has, and the reason the implementation listens for
   * `error`: an `error` event with no listener is thrown as an uncaught
   * exception, and a notice's background refresh must not be able to end the
   * command it was started from.
   */
  it('answers rather than throwing when there is no such program', async () => {
    const spawner = createNodeDetachedSpawner({ environment: {} });

    const started = await startDetached(
      writeOperation,
      { interpreter: join(directory, 'not-a-program'), path: join(directory, 'never') },
      spawner,
    );

    expect(started.ok).toBe(false);
    expect(started.ok === false && started.problem).toContain('not-a-program');
  });
});

/**
 * The child is not waited for, so its file is looked for until it appears.
 *
 * Ten seconds of looking, which is half the suite's bound: a child that never
 * writes fails here, as a null the assertion can name, rather than as the
 * harness giving up on the test.
 */
async function eventually(path: string): Promise<string | null> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  return null;
}
