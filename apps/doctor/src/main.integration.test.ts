import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { doctorUsage } from './config.js';

/**
 * The doctor's entrypoint as an operator meets it: the built program, spawned,
 * and asked what its flags are.
 *
 * It runs the built entry because the question is about a process — which
 * stream the usage came out on, and what the exit code was — and nothing below
 * the process level can answer it. The suite already requires a build.
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

const ENTRYPOINT = fileURLToPath(new URL('../dist/main.js', import.meta.url));

/**
 * A run with nothing inherited but a PATH: usage is a fact about the program,
 * and a settings file's environment must not be able to change it. stdin is
 * closed, because nothing on this path may ask anybody anything.
 */
function run(...args: readonly string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [ENTRYPOINT, ...args], {
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
    expect(result.status).toBe(2);
  });
});
