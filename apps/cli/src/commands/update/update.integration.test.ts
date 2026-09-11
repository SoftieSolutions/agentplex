import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `agentplex update` and `agentplex status`, run as an operator runs them,
 * against a prefix laid out the way `install.sh` lays one out.
 *
 * Everything below the process level is covered by the suites beside this one,
 * with a filesystem that is a table and a network that is a lookup. What those
 * cannot answer is whether the paths and the environment are right: the cache
 * really goes where `$XDG_CACHE_HOME` says, the manifest really comes out of the
 * directory `AGENTPLEX_VERSIONS` names, and the two commands really read the
 * same file -- one writing it and the other reporting out of it.
 *
 * **Nothing here reaches a network.** `AGENTPLEX_VERSIONS` is `install.sh`'s own
 * seam: a directory laid out as a release is, with `versions.json` at its root.
 * That is what an air-gapped mirror uses, and it is what lets an end-to-end run
 * of a command whose whole subject is "what is published" assert on a manifest
 * this test wrote. `--check` is the one invocation used, because it is the one
 * that asks only about the manifest -- the runtime question would go to
 * nodejs.org, which is a real network and not a subject.
 *
 * The prefix is a throwaway under `$TMPDIR` and `$HOME` points into it, so the
 * run is hermetic: nothing reads the contributor's own `~/.agentplex` or their
 * cache, and nothing writes outside the directory `afterAll` removes.
 */

const BIN = fileURLToPath(new URL('../../../dist/main.js', import.meta.url));

/** Loading a few modules and reading a handful of small files is not slow. */
const RUN_TIMEOUT_MS = 20_000;

const INSTALLED = {
  '@softiesolutions/agentplex': '1.4.0',
  '@softiesolutions/agentplex-hub': '1.2.0',
  '@softiesolutions/agentplex-web': '1.1.0',
} as const;

let home: string;
let prefix: string;
let mirror: string;
let cacheHome: string;
/** A PATH with node on it and no systemctl: the no-systemd machine. */
let onlyNode: string;

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(...argv: readonly string[]): Promise<Run> {
  const child = spawn(process.execPath, [BIN, ...argv], {
    env: {
      HOME: home,
      PATH: onlyNode,
      XDG_CACHE_HOME: cacheHome,
      AGENTPLEX_VERSIONS: mirror,
    },
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

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'agentplex-update-'));
  prefix = join(home, '.agentplex');
  cacheHome = join(home, 'cache');
  mirror = join(home, 'mirror');
  await mkdir(prefix, { recursive: true });
  await mkdir(mirror, { recursive: true });

  onlyNode = join(home, 'runtime');
  await mkdir(onlyNode, { recursive: true });
  await symlink(process.execPath, join(onlyNode, 'node'));

  // A hub machine: no server package, which is the case a report must not call
  // broken. The manifests carry `agentplex.protocol` because the published ones
  // do -- packaging writes it into every one of them.
  await writeFile(
    join(prefix, 'agentplex.env'),
    ['AGENTPLEX_ROLE=hub', `AGENTPLEX_PREFIX=${prefix}`, ''].join('\n'),
  );
  for (const [name, version] of Object.entries(INSTALLED)) {
    const directory = join(prefix, 'lib', 'node_modules', name);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ name, version, agentplex: { protocol: 3 } }),
    );
  }
  await mkdir(join(prefix, 'node', 'bin'), { recursive: true });
  await writeFile(join(prefix, 'node', '.agentplex-node-version'), 'v24.9.0\n');

  const units = join(home, '.config', 'systemd', 'user');
  await mkdir(units, { recursive: true });
  await writeFile(join(units, 'agentplex-hub.service'), '[Unit]\n');

  // The release, one origin further down: the same file name at the same path,
  // read off a disk instead of off the `v1` branch.
  await writeFile(
    join(mirror, 'versions.json'),
    JSON.stringify(
      {
        cli: { version: '1.5.0', protocol: 3 },
        hub: { version: '1.2.0', protocol: 3 },
        server: { version: '1.5.0', protocol: 3 },
        web: { version: '1.1.0', protocol: 3 },
      },
      null,
      2,
    ),
  );
});

afterAll(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('agentplex update --check against a real prefix', () => {
  it(
    'reports what is available out of the manifest and writes the cache where XDG says',
    { timeout: RUN_TIMEOUT_MS },
    async () => {
      const checked = await run('update', '--check');

      expect(checked.code).toBe(0);
      expect(checked.stdout).toContain(`prefix=${prefix}`);
      expect(checked.stdout).toMatch(/^ {2}cli {6}1\.4\.0 {8}-> 1\.5\.0/m);
      expect(checked.stdout).toMatch(/^ {2}hub {6}1\.2\.0 {8}up to date/m);
      // A hub machine has no server package, and a correctly installed machine
      // must not read as a broken one.
      expect(checked.stdout).toMatch(/^ {2}server {3}absent/m);
      expect(checked.stdout).toContain(join(mirror, 'versions.json'));

      // The cache, at the path `$XDG_CACHE_HOME` names, holding what was read.
      const cached: unknown = JSON.parse(
        await readFile(join(cacheHome, 'agentplex', 'versions.json'), 'utf8'),
      );
      expect(cached).toMatchObject({
        source: join(mirror, 'versions.json'),
        manifest: { cli: { version: '1.5.0', protocol: 3 } },
      });

      // Nothing on stderr: the notice is silent when stderr is not a terminal,
      // which is every pipe, every log and this suite.
      expect(checked.stderr).toBe('');
    },
  );

  it(
    'gives agentplex status its available column, out of the file update wrote',
    { timeout: RUN_TIMEOUT_MS },
    async () => {
      // The run above wrote the cache; this one reports out of it, and reaches
      // no network to do it.
      const status = await run('status');

      expect(status.code).toBe(0);
      expect(status.stdout).toContain('1.5.0 available');
      expect(status.stdout).toContain('checked just now');
      expect(status.stdout).toContain(join(mirror, 'versions.json'));
      expect(status.stderr).toBe('');
    },
  );
});

describe('what update refuses, before it touches anything', () => {
  it('refuses a partial pin with the shape a pin takes', { timeout: RUN_TIMEOUT_MS }, async () => {
    const refused = await run('update', 'hub@1.3');

    expect(refused.code).toBe(2);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toContain('1.3.0 rather than 1.3');
  });

  it(
    'refuses a component this machine does not have, and points at setup',
    { timeout: RUN_TIMEOUT_MS },
    async () => {
      const refused = await run('update', 'server');

      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain('not installed here');
      expect(refused.stderr).toContain('agentplex setup');
    },
  );
});

describe('the bin', () => {
  it(
    'lists update in its usage and prints a version with nothing beside it',
    { timeout: RUN_TIMEOUT_MS },
    async () => {
      const usage = await run('--help');
      expect(usage.stdout).toContain('update');

      // `agentplex --version` inside `$(...)` is a real thing somebody writes,
      // and a notice on stdout would end up in the variable.
      const version = await run('--version');
      expect(version.code).toBe(0);
      expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
      expect(version.stderr).toBe('');
    },
  );
});
