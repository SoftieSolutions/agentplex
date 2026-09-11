import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { doctorUsage } from './config.js';

/**
 * The doctor as an operator meets it: `agentplex doctor`, spawned, and asked
 * what its flags are.
 *
 * It runs a child process because the question is about one — which stream the
 * usage came out on, and what the exit code was — and nothing below the process
 * level can answer it. The suite already requires a build.
 *
 * What it spawns is the bin with the command word, which is a change of
 * entrypoint and not of subject: there is no `apps/doctor/dist/main.js` to run
 * any more, and the doctor is now reached the only way an operator was ever
 * able to reach it. The command word travelling through the dispatch is part of
 * what this asserts as a result — a `--help` that came back on stdout is a
 * `--help` that reached this program and not the bin's own usage, which the
 * third case pins by name.
 *
 * Asking for usage and mistyping a flag are two events, and the difference is
 * asserted here rather than described. An answer goes to stdout and exits 0. A
 * refusal keeps stderr and exit 2: the operator must act.
 *
 * A doctor has a third exit code, 1, for a machine that is not ready. Usage is
 * not a verdict on the machine and must not borrow it: `--help` inspects
 * nothing, so it has nothing to be unready about.
 *
 * The expected text is the program's own `doctorUsage()` rather than a copy of
 * what it prints, so a second usage message cannot be introduced without this
 * failing.
 */

/**
 * The built bin. Three levels up from this file is the app, and `dist` is
 * beside `src` under it. It has to be the built one: the bin resolves the
 * daemons and its own manifest relative to `import.meta.url`, and those
 * distances are `dist/`'s. `pnpm -C apps/cli build` first, which this suite
 * already needed when it ran a `dist` of its own.
 */
const BIN = fileURLToPath(new URL('../../../dist/main.js', import.meta.url));

/** The command word the bin consumes before this program reads argv. */
const COMMAND = 'doctor';

/**
 * A run with nothing inherited but a PATH: usage is a fact about the program,
 * and a settings file's environment must not be able to change it. stdin is
 * closed, because nothing on this path may ask anybody anything.
 */
function run(...args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [BIN, COMMAND, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env['PATH'] ?? '' },
  });
}

describe('agentplex doctor', () => {
  it.each(['--help', '-h'])('prints its usage on stdout and exits 0 for %s', (flag) => {
    const result = run(flag);

    expect(result.stdout).toBe(`${doctorUsage()}\n`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  /**
   * The role is the one setting the doctor cannot proceed without, and a run
   * that omits it is refused. Usage comes before that refusal, or the flag an
   * operator is missing is only nameable by an operator who already knows it.
   */
  it('answers --help without the role it otherwise insists on', () => {
    const result = run('--help');

    expect(result.stdout).toContain('--role');
    expect(result.stdout).not.toContain('no role');
  });

  it('still refuses a flag it does not know, on stderr, with the code a unit will not retry', () => {
    const result = run('--role=server', '--stores=/srv');

    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unknown argument: --stores=/srv');
    expect(result.stderr).toContain('Usage: agentplex doctor');
    // The doctor's usage and not the bin's: proof the word was consumed and
    // this program refused the flag, rather than the dispatcher refusing it.
    expect(result.stderr).not.toContain('Usage: agentplex <command>');
    expect(result.status).toBe(2);
  });
});
