import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { serializeVersionsManifest, updateVersionsManifest } from '@agentplex/release';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `agentplex install`, run as an operator runs it, against a scratch home.
 *
 * The suites beside this one cover the grammar, the plan and the renderer with
 * a machine that is a table. What they cannot answer is whether the built bin
 * reaches the command, whether the real node lookup lands where
 * `resolve_node_directory` would, and whether the manifest really comes out of
 * the directory `AGENTPLEX_VERSIONS` names -- which is the one thing a dry run
 * reads.
 *
 * **Nothing here reaches a network.** A dry run fetches nothing, and the one
 * manifest it reads is a file this suite wrote.
 *
 * **It runs as somebody other than root.** A plain install refuses root, as
 * `resolve_layout` does, and the container this suite runs in is root; so there
 * the bin is started as `nobody`, the way `install.sh.integration.test.ts`
 * starts the script, and the scratch tree is opened up for it.
 */

const BIN = fileURLToPath(new URL('../../../dist/main.js', import.meta.url));

/** Loading a few modules and reading a handful of small files is not slow. */
const RUN_TIMEOUT_MS = 20_000;

const suiteIsRoot = process.getuid?.() === 0;

const BOTH_LEGS = { client: 3, server: 3 };

let root: string;
let home: string;
let mirror: string;
/** A PATH with a recent node on it and nothing else: no systemctl, no npm. */
let onlyNode: string;

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function run(...argv: readonly string[]): Promise<Run> {
  const environment = { HOME: home, PATH: onlyNode, AGENTPLEX_VERSIONS: mirror };
  const child = suiteIsRoot
    ? spawn(
        'su',
        [
          'nobody',
          '-s',
          '/bin/sh',
          '-c',
          [
            'env',
            '-i',
            ...Object.entries(environment).map(([name, value]) => `${name}=${quote(value)}`),
            quote(process.execPath),
            quote(BIN),
            ...argv.map(quote),
          ].join(' '),
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
    : spawn(process.execPath, [BIN, ...argv], {
        env: environment,
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

async function fixture(name: string): Promise<string> {
  const text = await readFile(
    fileURLToPath(new URL(`../../installation/fixtures/units/${name}`, import.meta.url)),
    'utf8',
  );
  // Captured with HOME=/home/alice; this suite's home is a scratch directory.
  return text.replaceAll('/home/alice', home);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentplex-install-'));
  // Open to whoever the bin runs as, which under root is `nobody`.
  await chmod(root, 0o777);
  home = join(root, 'home');
  mirror = join(root, 'mirror');
  onlyNode = join(root, 'runtime');
  for (const directory of [home, mirror, onlyNode]) {
    await mkdir(directory, { recursive: true });
    await chmod(directory, 0o777);
  }
  await symlink(process.execPath, join(onlyNode, 'node'));

  // The runtime install.sh unpacks into the prefix. It is the one the unit
  // names whatever PATH holds, which is what makes the output the fixture's.
  const runtime = join(home, '.agentplex', 'node', 'bin');
  await mkdir(runtime, { recursive: true });
  await symlink(process.execPath, join(runtime, 'node'));

  const releases = [
    ['cli', '1.4.0', {}],
    ['hub', '1.2.0', BOTH_LEGS],
    ['web', '1.1.0', BOTH_LEGS],
    ['server', '1.5.0', { server: 3 }],
  ] as const;
  await writeFile(
    join(mirror, 'versions.json'),
    serializeVersionsManifest(
      releases.reduce(
        (previous, [component, version, protocol]) =>
          updateVersionsManifest(previous, component, { version, protocol }),
        {},
      ),
    ),
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('agentplex install against a scratch home', () => {
  it(
    'prints the units install.sh --print-unit prints, both of them for --role=both',
    { timeout: RUN_TIMEOUT_MS },
    async () => {
      const printed = await run('install', '--print-unit', '--role=both');

      expect(printed.stderr).toBe('');
      expect(printed.code).toBe(0);
      expect(printed.stdout).toBe(await fixture('both-user.service'));
      expect(printed.stdout).toBe(
        (await fixture('hub-user.service')) + (await fixture('server-user.service')),
      );
    },
  );

  it(
    'plans a hub out of the manifest AGENTPLEX_VERSIONS names',
    { timeout: RUN_TIMEOUT_MS },
    async () => {
      const planned = await run('install', '--dry-run', '--role=hub');

      expect(planned.stderr).toBe('');
      expect(planned.code).toBe(0);
      expect(planned.stdout).toContain(
        `release    cli 1.4.0, hub 1.2.0, web 1.1.0 (from ${join(mirror, 'versions.json')})\n`,
      );
      expect(planned.stdout).toContain('client protocol 3, which hub and web agree on\n');
    },
  );

  it('refuses a bare run with exit 2', { timeout: RUN_TIMEOUT_MS }, async () => {
    const bare = await run('install');

    expect(bare.code).toBe(2);
    expect(bare.stdout).toBe('');
    expect(bare.stderr).toContain('install.sh is how to install agentplex');
  });
});
