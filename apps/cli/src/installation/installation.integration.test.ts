import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `agentplex status` and `agentplex start`, run as an operator runs them,
 * against a prefix laid out the way `install.sh` lays one out.
 *
 * Everything below the process level is covered by the suites beside this one,
 * with a filesystem that is a table and a `systemctl` that is a lookup. What
 * those cannot answer is whether the paths are right: `nodeInstallationFiles`
 * reads a real disk, the built bin resolves its own modules from `dist`, and
 * the layout this walks -- `<prefix>/agentplex.env`, `<prefix>/lib/node_modules/
 * @softiesolutions/*`, `<prefix>/node/.agentplex-node-version`,
 * `$HOME/.config/systemd/user` -- is the installer's, not this app's. A
 * directory this builds by hand and a command that finds what is in it is the
 * only way to check the two agree.
 *
 * The prefix is a throwaway under `$TMPDIR` and `$HOME` points into it, so the
 * run is hermetic: nothing reads the contributor's own `~/.agentplex`, and
 * nothing writes outside the directory `afterAll` removes.
 *
 * `PATH` is a directory this test made, holding a link to the node running it
 * and nothing else. `dirname(process.execPath)` would not do: that is usually
 * `/usr/bin`, which is where `systemctl` lives -- so a suite written that way
 * would find a real one, ask a real manager about units it invented, and answer
 * differently on a contributor's laptop than in CI.
 *
 * With nothing but node on it this is the no-systemd machine on every box,
 * which is the one machine state a test can arrange honestly without a
 * container. It is also the fallback that matters most, because it is what an
 * operator on macOS gets. The container check exercises the other half, where
 * systemd is really installed.
 */

const BIN = fileURLToPath(new URL('../../dist/main.js', import.meta.url));

/** Loading two modules and reading six small files is not slow, and a CI box is. */
const RUN_TIMEOUT_MS = 20_000;

const VERSIONS = {
  '@softiesolutions/agentplex': '1.4.0',
  '@softiesolutions/agentplex-hub': '1.2.0',
  '@softiesolutions/agentplex-server': '1.5.0',
  '@softiesolutions/agentplex-web': '1.1.0',
} as const;

let home: string;
let prefix: string;
/** A PATH with node on it and no systemctl. See the note above. */
let onlyNode: string;

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(...argv: readonly string[]): Promise<Run> {
  const child = spawn(process.execPath, [BIN, ...argv], {
    env: { HOME: home, PATH: onlyNode },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, stdout, stderr };
}

/**
 * A prefix as `install.sh` leaves one: the settings file it writes once, the
 * four packages npm installs into it, the runtime it stamps, and two unit files
 * in the user manager's directory.
 *
 * The manifests carry `agentplex.protocol` because the published ones do --
 * packaging writes it into every one of them, which is the whole reason
 * `status` can read the claim back off an installed machine.
 */
async function assemblePrefix(protocols: Readonly<Record<string, number>>): Promise<void> {
  await writeFile(
    join(prefix, 'agentplex.env'),
    [
      'AGENTPLEX_ROLE=both',
      `AGENTPLEX_PREFIX=${prefix}`,
      `AGENTPLEX_BIN_PATH=${prefix}/bin`,
      '',
    ].join('\n'),
  );

  for (const [name, version] of Object.entries(VERSIONS)) {
    const directory = join(prefix, 'lib', 'node_modules', name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ name, version, agentplex: { protocol: protocols[name] ?? 3 } }),
    );
  }

  // The runtime as the installer leaves it: an interpreter under `node/bin`
  // and the stamp beside it recording what was unpacked. Both matter here --
  // the stamp is what `status` reports, and the interpreter is what the
  // foreground command names instead of the one running this test.
  await mkdir(join(prefix, 'node', 'bin'), { recursive: true });
  await writeFile(join(prefix, 'node', '.agentplex-node-version'), 'v24.9.0\n');
  // Removed first, because this is called again to change a manifest and
  // `symlink` refuses a path that is already there.
  const interpreter = join(prefix, 'node', 'bin', 'node');
  await rm(interpreter, { force: true });
  await symlink(process.execPath, interpreter);

  const units = join(home, '.config', 'systemd', 'user');
  await mkdir(units, { recursive: true });
  for (const daemon of ['hub', 'server']) {
    await writeFile(join(units, `agentplex-${daemon}.service`), '[Unit]\n');
  }
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'agentplex-installation-'));
  prefix = join(home, '.agentplex');
  await mkdir(prefix, { recursive: true });
  onlyNode = join(home, 'runtime');
  await mkdir(onlyNode, { recursive: true });
  await symlink(process.execPath, join(onlyNode, 'node'));
  await assemblePrefix({});
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('agentplex status against a real prefix', () => {
  it(
    'finds the install, the four packages, both units and the runtime',
    { timeout: RUN_TIMEOUT_MS },
    async () => {
      const status = await run('status');

      expect(status.stderr).toBe('');
      expect(status.stdout).toContain(`prefix=${prefix}   scope=user   role=both`);
      for (const version of Object.values(VERSIONS)) expect(status.stdout).toContain(version);
      expect(status.stdout).toContain('agentplex-hub.service');
      expect(status.stdout).toContain('agentplex-server.service');
      expect(status.stdout).toContain('node v24.9.0   installed by install.sh');
      // No systemctl on this PATH, so nothing is claimed about what the units
      // are doing -- and that is not a failure of the machine.
      expect(status.stdout).toContain('there is no systemctl on this machine');
      expect(status.code).toBe(0);
    },
  );

  it(
    'reports a protocol disagreement it could only have read off the manifests',
    { timeout: RUN_TIMEOUT_MS },
    async () => {
      await assemblePrefix({ '@softiesolutions/agentplex-hub': 4 });
      const status = await run('status');
      await assemblePrefix({});

      expect(status.stdout).toContain('these components do not agree');
      expect(status.stdout).toContain('hub      protocol 4');
      expect(status.stdout).toContain('server   protocol 3');
      // Reported, not failed: the exit code answers "did anything fail to run".
      expect(status.code).toBe(0);
    },
  );

  it(
    'refuses a directory that is not an agentplex prefix, on stderr',
    { timeout: RUN_TIMEOUT_MS },
    async () => {
      const status = await run('status', '--prefix', join(home, 'nothing'));

      expect(status.code).toBe(2);
      expect(status.stdout).toBe('');
      expect(status.stderr).toContain(join(home, 'nothing', 'agentplex.env'));
    },
  );
});

describe('agentplex start against a real prefix', () => {
  it(
    'prints the foreground command on a machine with no systemctl, and does not claim to have started anything',
    { timeout: RUN_TIMEOUT_MS },
    async () => {
      const started = await run('start');

      expect(started.stdout).toContain('There is no systemctl on this machine');
      // The interpreter this prefix owns, and the entry inside the package npm
      // put there. Both are real paths in the directory this test built.
      expect(started.stdout).toContain(
        `${join(prefix, 'node', 'bin', 'node')} ${join(
          prefix,
          'lib/node_modules/@softiesolutions/agentplex-hub/apps/hub/dist/main.js',
        )}`,
      );
      expect(started.code).toBe(1);
    },
  );

  it(
    'does not offer a foreground command to somebody stopping one',
    { timeout: RUN_TIMEOUT_MS },
    async () => {
      const stopped = await run('stop');

      expect(stopped.stdout).toContain('started by hand');
      expect(stopped.stdout).not.toContain('dist/main.js');
      expect(stopped.code).toBe(1);
    },
  );
});
