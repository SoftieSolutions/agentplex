import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { serverUsage } from './config.js';

/**
 * The server's entrypoint as an operator meets it: the built program, spawned,
 * and asked what its flags are.
 *
 * It runs the built entry because the question is about a process — which
 * stream the usage came out on, and what the exit code was — and nothing below
 * the process level can answer it. The suite already requires a build.
 *
 * Asking for usage and mistyping a flag are two events, and the difference is
 * asserted here rather than described. An answer goes to stdout and exits 0. A
 * refusal keeps stderr and exit 2, which is the code `install.sh` writes into
 * the unit as `RestartPreventExitStatus`: the operator must act, and restarting
 * will not help. The image asserts that second half too, on the error path,
 * because usage on stderr is its proof that node-pty loaded.
 *
 * The expected text is the program's own `serverUsage()` rather than a copy of
 * what it prints, so a second usage message cannot be introduced without this
 * failing.
 */

const ENTRYPOINT = fileURLToPath(new URL('../dist/main.js', import.meta.url));

/**
 * Two bounds, because this forks a Node runtime and `spawnSync` blocks the
 * thread it runs on.
 *
 * The child had none, and vitest's default five seconds could not supply one: a
 * blocked thread cannot be interrupted, so the suite's bound was only consulted
 * once the child had already returned. `EXIT_TIMEOUT_MS` is the guard that can
 * actually stop one; the suite's is larger, so a busy machine is not mistaken
 * for a wedged daemon. Nothing below asserts how long a run took.
 */
const EXIT_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 25_000;

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
    timeout: EXIT_TIMEOUT_MS,
  });
}

describe('agentplex server', { timeout: TEST_TIMEOUT_MS }, () => {
  it.each(['--help', '-h'])('prints its usage on stdout and exits 0 for %s', (flag) => {
    const result = run(flag);

    expect(result.stdout).toBe(`${serverUsage()}\n`);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  /**
   * The server refuses to start at all on an installation whose node-pty did
   * not build, and that refusal is checked before the flags because it is a
   * fact about the installation rather than the invocation. Usage is neither:
   * what this program's flags are is true of the program, so the question is
   * answered before the machine is asked anything about itself. An operator
   * staring at a server that will not start is exactly the one who needs it.
   */
  it('says how it is actually started, since nobody can type its name', () => {
    const result = run('--help');

    // The two loose ends this closes: the usage named an invocation that does
    // not exist, and the one that does -- systemd, from a unit -- was nowhere
    // in it. `agentplex start` is what enables and starts that unit, and it is
    // the answer to what somebody typing `--help` at this file wanted.
    expect(result.stdout).toContain('agentplex server is a daemon, not a command');
    expect(result.stdout).toContain('agentplex-server.service');
    expect(result.stdout).toContain('agentplex start');
    expect(result.stdout).toContain('pnpm -C apps/server start');
  });

  it('answers --help ahead of every question it asks about the machine', () => {
    const result = run('--help');

    expect(result.stdout).toContain('--server-identity-file');
    expect(result.stdout).not.toContain('pseudoterminal');
  });

  it('still refuses a flag it does not know, on stderr, with the code a unit will not retry', () => {
    const result = run('--role=server');

    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('unknown argument: --role=server');
    // The usage names the invocation that exists -- an interpreter and this
    // program's compiled entry -- rather than `agentplex server`, which is a
    // command line nobody can type since the daemons stopped being subcommands.
    expect(result.stderr).toContain('Usage: <node> apps/server/dist/main.js');
    expect(result.stderr).not.toContain('Usage: agentplex server');
    expect(result.status).toBe(2);
  });
});
