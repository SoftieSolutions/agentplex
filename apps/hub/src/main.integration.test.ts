import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hubUsage } from './config.js';

/**
 * The hub's entrypoint as an operator meets it: the built program, spawned, and
 * asked what its flags are.
 *
 * It runs the built entry because the question is about a process — which
 * stream the usage came out on, and what the exit code was — and nothing below
 * the process level can answer it. The suite already requires a build.
 *
 * Asking for usage and mistyping a flag are two events, and the difference is
 * asserted here rather than described. An answer goes to stdout and exits 0,
 * where a pager or a pipe can take it. A refusal keeps stderr and exit 2, which
 * is the code `install.sh` writes into the unit as `RestartPreventExitStatus`:
 * the operator must act, and restarting will not help.
 *
 * The expected text is the program's own `hubUsage()` rather than a copy of
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

describe('agentplex hub', () => {
  it.each(['--help', '-h'])('prints its usage on stdout and exits 0 for %s', (flag) => {
    const result = run(flag);

    expect(result.stdout).toBe(`${hubUsage()}\n`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  /**
   * The hub cannot start without a database file or a client token, and it says
   * so on stderr. Usage has to be reachable before any of that: the operator
   * asking what the flags are is the operator who has not set them yet.
   */
  it('answers --help without the settings it cannot start without', () => {
    const result = run('--help');

    expect(result.stdout).toContain('--database-file');
    expect(result.stdout).toContain('--client-token');
  });

  it('still refuses a flag it does not know, on stderr, with the code a unit will not retry', () => {
    const result = run('--databse-file=/var/lib/agentplex/hub.db');

    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unknown argument: --databse-file=/var/lib/agentplex/hub.db');
    expect(result.stderr).toContain('Usage: agentplex hub');
    expect(result.status).toBe(2);
  });
});
