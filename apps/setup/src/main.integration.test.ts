import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { dirname } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nodePtyFactory, type PtyExit } from '@agentplex/pty';
import { setupUsage } from './setup-command.js';

/**
 * `agentplex setup --help` as an operator meets it: the built program, spawned,
 * and asked what its flags are.
 *
 * It runs the built entry because the question is about a process — which
 * stream the usage came out on, and what the exit code was — and nothing below
 * the process level can answer it. The suite already requires a build.
 *
 * Setup is the one program here that would otherwise ask the operator
 * something, and that is what the second case is for. Every other program
 * answers `--help` or refuses; this one has a third thing it can do, and doing
 * it to somebody who asked what the flags are would leave them holding a
 * wizard. A pipe cannot show that: a piped input ends, and an ended input is
 * how the wizard learns there is nobody to ask. A tty never ends, so a run that
 * started asking on one would sit there — which is a test that hangs rather
 * than fails, and why this one is bounded by a timeout of its own.
 *
 * The expected text is the command's own `setupUsage()` rather than a copy of
 * what it prints, so a second usage message cannot be introduced without this
 * failing.
 */

const ENTRYPOINT = fileURLToPath(new URL('../dist/main.js', import.meta.url));

/** Long enough for a fork on a busy machine, short enough to be a failure. */
const EXIT_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 25_000;

/**
 * A run with nothing inherited but a PATH: usage is a fact about the program,
 * and the machine it runs on must not be able to change it. stdin is closed,
 * because nothing on this path may ask anybody anything — and setup with a
 * closed stdin and no plan reports that there is nobody to ask, so an empty
 * stderr is the evidence that the wizard never started.
 */
function run(...args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [ENTRYPOINT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env['PATH'] ?? '' },
    timeout: EXIT_TIMEOUT_MS,
  });
}

describe('agentplex setup', () => {
  it.each(['--help', '-h'])('prints its usage on stdout and exits 0 for %s', (flag) => {
    const result = run(flag);

    expect(result.stdout).toBe(`${setupUsage()}\n`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it(
    'answers on a real terminal and exits, rather than starting to ask questions',
    async () => {
      const pty = nodePtyFactory.open({
        command: process.execPath,
        args: [ENTRYPOINT, '--help'],
        cwd: dirname(ENTRYPOINT),
        // The directory node is in and nothing else, so nothing on this machine
        // is discoverable and the run stays hermetic.
        env: { PATH: dirname(process.execPath) },
        cols: 80,
        rows: 24,
        term: 'xterm-256color',
      });

      const chunks: string[] = [];
      pty.onData((chunk) => chunks.push(new TextDecoder().decode(chunk)));

      const outcome = await Promise.race([
        new Promise<PtyExit>((resolve) => pty.onExit(resolve)),
        new Promise<'never exited'>((resolve) =>
          setTimeout(() => resolve('never exited'), EXIT_TIMEOUT_MS),
        ),
      ]);

      // Killed either way: a test that leaves a child behind on failure is a
      // test that makes the next run stranger than this one.
      pty.kill();

      expect(outcome).toEqual({ exitCode: 0, signal: null });
      expect(chunks.join('')).toContain('Usage: agentplex setup');
    },
    TEST_TIMEOUT_MS,
  );

  it('still refuses a flag it does not know, on stderr, with the code a unit will not retry', () => {
    const result = run('--pln', '/etc/agentplex/plan.json');

    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unknown argument: --pln');
    expect(result.stderr).toContain('Usage: agentplex setup');
    expect(result.status).toBe(2);
  });
});
