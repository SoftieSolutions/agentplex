import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodePtyFactory } from '../server/node-pty-factory.js';
import type { PtyExit } from '../server/pty.js';

/**
 * `agentplexd setup` on a real terminal, run to the end, and then: does it exit?
 *
 * Nothing below the process level can answer that. Every other test here drives
 * the terminal seam with a stream, and a stream ends — which is what makes a
 * piped run exit whether or not anything released the input. A tty never ends,
 * so an input left resumed holds the event loop open forever and the operator
 * gets a finished wizard and a prompt that never comes back. That is a real pty,
 * a real child, and an exit code or nothing.
 *
 * It runs the built entrypoint because that is the artifact an operator runs.
 * The suite already requires a build — the workspace's own tests resolve
 * `@agentplex/protocol` through its built declarations — so this adds no
 * requirement that was not already there.
 *
 * `--role hub` on purpose: it is the shortest way to the last question, and a
 * hub plan touches no store, mints no identity and starts no child, so what this
 * asserts is the terminal and nothing else.
 */

/**
 * A fork on a busy machine, and then a wizard. Generous, and still bounded.
 *
 * The test's own timeout is longer, so a run that never exits fails as "never
 * exited" with the child killed rather than as vitest giving up on a test that
 * has left a process behind.
 */
const EXIT_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 25_000;

const ENTRYPOINT = fileURLToPath(new URL('../../dist/main.js', import.meta.url));

/** Role, hub port, apply, save. Every one of them takes the offer. */
const RETURN = '\r';
const ANSWERS = RETURN.repeat(4);

let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'agentplex-setup-exit-'));
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('a finished setup run', () => {
  it(
    'exits when the terminal it was driven on has not ended',
    async () => {
      const pty = nodePtyFactory.open({
        command: process.execPath,
        args: [ENTRYPOINT, 'setup', '--role', 'hub'],
        cwd: home,
        // Everything the child is allowed to know about this machine. `PATH` holds
        // the directory node is in and nothing else, so the survey finds no
        // provider and the run stays hermetic.
        env: { HOME: home, PATH: dirname(process.execPath) },
        cols: 80,
        rows: 24,
        term: 'xterm-256color',
      });

      const exited = new Promise<PtyExit>((resolve) => pty.onExit(resolve));

      // Written once the child has produced something, so the answers reach a
      // program that is already reading rather than a pty nobody has opened yet.
      let answered = false;
      pty.onData(() => {
        if (answered) return;
        answered = true;
        pty.write(ANSWERS);
      });

      const outcome = await Promise.race([
        exited,
        new Promise<'never exited'>((resolve) =>
          setTimeout(() => resolve('never exited'), EXIT_TIMEOUT_MS),
        ),
      ]);

      // Killed either way: a test that leaves a child behind on failure is a
      // test that makes the next run stranger than this one.
      pty.kill();

      expect(outcome).toEqual({ exitCode: 0, signal: null });
    },
    TEST_TIMEOUT_MS,
  );
});
