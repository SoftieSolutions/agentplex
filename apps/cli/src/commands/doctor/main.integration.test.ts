import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MIN_TOKEN_LENGTH } from '@agentplex/node-shared';
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
 * Two bounds, because this forks a Node runtime and `spawnSync` blocks the
 * thread it runs on.
 *
 * The child had no bound at all, and vitest's default five seconds could not
 * supply one: a blocked thread cannot be interrupted, so the suite's bound was
 * only ever consulted after the child had already returned. A wedged child hung
 * until somebody killed the run. `EXIT_TIMEOUT_MS` is the guard that was
 * missing -- it is the one that can actually stop a child -- and the suite's is
 * larger so that a slow machine is not mistaken for a wedged one. This is the
 * layering `setup/main.integration.test.ts` next door already keeps.
 */
const EXIT_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 25_000;

/**
 * A run with nothing inherited but a PATH: usage is a fact about the program,
 * and a settings file's environment must not be able to change it. stdin is
 * closed, because nothing on this path may ask anybody anything.
 */
function run(...args: readonly string[]): SpawnSyncReturns<string> {
  return runWith({}, ...args);
}

/**
 * The same run, with a settings file's worth of environment on it.
 *
 * Settings rather than flags, because that is how a machine has them: the
 * installer writes an EnvironmentFile and the unit reads it, and the doctor is
 * asked what *those* can start.
 */
function runWith(
  settings: Readonly<Record<string, string>>,
  ...args: readonly string[]
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [BIN, COMMAND, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // `$HOME` travels with `$PATH`, and the suite's is a throwaway -- see
    // `scripts/test-home.ts`. An environment without it is not sealed: a
    // child asking `os.homedir()` gets the passwd entry when `$HOME` is
    // missing, which is the operator's real home.
    env: { HOME: process.env['HOME'] ?? '', PATH: process.env['PATH'] ?? '', ...settings },
    timeout: EXIT_TIMEOUT_MS,
  });
}

/** Loopback, so nothing this suite binds is reachable from another machine. */
const LOOPBACK = '127.0.0.1';

/** Long enough for the hub, which is all the check reads about it. */
const CLIENT_TOKEN = 'd'.repeat(MIN_TOKEN_LENGTH);

const listeners: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const close of listeners) await close();
});

/**
 * A port with something on it, and the same port after it is let go.
 *
 * Both answers come from one helper because they are one arrangement: the
 * kernel picks a free port by binding zero, and what the test does next --
 * keep it or release it -- is the difference between the two cases below. A
 * port picked any other way is a port somebody else on the runner may hold.
 */
async function boundPort(): Promise<{
  readonly port: number;
  readonly release: () => Promise<void>;
}> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: LOOPBACK, port: 0, exclusive: true }, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the listener reported no port'));
        return;
      }
      resolve(address.port);
    });
  });

  let closed = false;
  const release = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  };
  listeners.push(release);
  return { port, release };
}

/** The settings a hub is started from, pointed at a directory this test owns. */
async function hubSettings(port: number): Promise<Readonly<Record<string, string>>> {
  const directory = await mkdtemp(join(tmpdir(), 'agentplex-doctor-'));
  return {
    AGENTPLEX_ROLE: 'hub',
    AGENTPLEX_HOST: LOOPBACK,
    AGENTPLEX_HUB_PORT: String(port),
    AGENTPLEX_DATABASE_FILE: join(directory, 'agentplex.db'),
    AGENTPLEX_CLIENT_TOKEN: CLIENT_TOKEN,
  };
}

describe('agentplex doctor', { timeout: TEST_TIMEOUT_MS }, () => {
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

/**
 * The hub half, run as an operator runs it: the real bin, the real settings,
 * the real machine.
 *
 * In process there is nothing to be sure of here. The probe that answers
 * whether the hub's port is free is a bind, the one that answers whether its
 * database directory can be written is `access`, and both are exactly the
 * calls a fake stands in for everywhere else. This is the suite that has them
 * as subjects, on a port this test holds and a directory it made.
 */
describe('agentplex doctor on a hub', { timeout: TEST_TIMEOUT_MS }, () => {
  it('reports what the hub needs, and exits 0 when this machine has it', async () => {
    const { port, release } = await boundPort();
    // Let go of it first: what the doctor should find is a free port, and the
    // kernel just told us which one nobody else had.
    await release();

    const result = runWith(await hubSettings(port));

    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('database');
    expect(result.stdout).toContain('client token');
    expect(result.stdout).toContain(`${LOOPBACK}:${String(port)}`);
    expect(result.stdout).toContain('free');
    // The client package is a line either way -- it resolves on an installed
    // machine and not out of this app's `dist` in a checkout -- and either way
    // it does not move the exit code. That is the property: a hub with no
    // client starts and serves 503.
    expect(result.stdout).toContain('web client');
    expect(result.status).toBe(0);
  });

  it('says the hub port is taken, and exits 1, when something already holds it', async () => {
    const { port } = await boundPort();

    const result = runWith(await hubSettings(port));

    expect(result.stdout).toContain('in-use');
    expect(result.stdout).toContain(`${LOOPBACK}:${String(port)}`);
    // A check that says "not ready" has failed in the only sense a shell
    // understands.
    expect(result.status).toBe(1);
  });

  it('names every setting a half-finished hub is missing, rather than refusing to look', async () => {
    const result = runWith({ AGENTPLEX_ROLE: 'hub' });

    expect(result.stdout).toContain('AGENTPLEX_DATABASE_FILE');
    expect(result.stdout).toContain('AGENTPLEX_CLIENT_TOKEN');
    // Not exit 2: the settings are not a typo to fix before the machine can be
    // inspected, they are the finding.
    expect(result.status).toBe(1);
  });
});

/**
 * The settings file, which is what a machine is actually configured with.
 *
 * The daemons' units name it as their EnvironmentFile, so a doctor that read
 * only its own environment and flags was reporting on a machine nobody runs:
 * the operator had to retype, as flags, what the installer and setup had
 * already written down. This is the doctor run the way an operator runs it on
 * an installed machine -- with no flags at all.
 *
 * Its own home rather than the suite's, because the file lives under it: a
 * `role=server` settings file in the shared home would be read by every other
 * run in this file. The assertion is on stdout rather than the exit code: a
 * server with no provider installed is a machine that is not ready, which is
 * exit 1 and a true report, and what this case is about is which machine the
 * report describes.
 */
describe('agentplex doctor on an installed machine', { timeout: TEST_TIMEOUT_MS }, () => {
  it('reads the role and the server settings out of the settings file, with no flags', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentplex-doctor-home-'));
    const prefix = join(home, '.agentplex');
    const bin = join(prefix, 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(prefix, 'agentplex.env'),
      [
        '# agentplex settings, as install.sh and setup leave them.',
        'AGENTPLEX_ROLE=server',
        `AGENTPLEX_PREFIX=${prefix}`,
        `AGENTPLEX_BIN_PATH=${bin}`,
        `AGENTPLEX_SERVER_IDENTITY_FILE=${join(prefix, 'server.json')}`,
        '',
      ].join('\n'),
    );

    const result = runWith({ HOME: home });

    expect(result.stderr).not.toContain('no role');
    expect(result.stdout).toContain('agentplex doctor  role=server');
    expect(result.stdout).toContain(join(prefix, 'agentplex.env'));
    // The identity file the settings name, which is the one the server reads.
    expect(result.stdout).toContain(`server identity\n  ${join(prefix, 'server.json')}\n`);
    // The data root defaults from that same home, and it is there.
    expect(result.stdout).toMatch(new RegExp(`ready +${prefix.replaceAll('.', '\\.')}`));
  });
});
