import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serializeVersionsManifest, updateVersionsManifest } from '@agentplex/release';
import type { ProcessOutcome, ProgramResolver } from '@agentplex/providers';
import { createFakeProcessRunner, printed } from '@agentplex/providers/testing';
import { describe, expect, it } from 'vitest';
import type { ManifestSource } from '../../versions/version-check.js';
import {
  createFakeInstallMachine,
  type FakeInstallMachineOptions,
} from './fake-install-machine.js';
import { runInstallCommand, type InstallCommandDependencies } from './install-command.js';

/**
 * `agentplex install`, run against a machine a test writes down.
 *
 * Two questions and a refusal. `--print-unit` prints what `install.sh
 * --print-unit` prints -- held here against the captured fixtures, through the
 * same node lookup the real command makes -- and `--dry-run` prints the plan as
 * `report()` lays it out. Anything else is the install itself, which this
 * command does not do yet and says so.
 */

const HOME = '/home/alice';
const PREFIX = `${HOME}/.agentplex`;
const MIRROR = '/mirror';
const VERSIONS = `${MIRROR}/versions.json`;

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../installation/fixtures/units/${name}`, import.meta.url)),
    'utf8',
  );
}

const CURRENT = serializeVersionsManifest(
  [
    ['cli', '1.4.0', {}],
    ['hub', '1.2.0', { client: 3, server: 3 }],
    ['web', '1.1.0', { client: 3, server: 3 }],
    ['server', '1.5.0', { server: 3 }],
  ].reduce(
    (previous, [component, version, protocol]) =>
      updateVersionsManifest(previous, component as string, {
        version: version as string,
        protocol: protocol as { client?: number; server?: number },
      }),
    {},
  ),
);

interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly probes: readonly string[];
  readonly machine: ReturnType<typeof createFakeInstallMachine>;
}

interface Setup {
  readonly machine?: FakeInstallMachineOptions;
  readonly isRoot?: boolean;
  readonly home?: string;
  readonly source?: ManifestSource;
  readonly packageDirectory?: string | null;
  readonly programs?: Readonly<Record<string, string>>;
  readonly versions?: Readonly<Record<string, ProcessOutcome>>;
  readonly platform?: string;
}

async function run(argv: readonly string[], setup: Setup = {}): Promise<Ran> {
  let stdout = '';
  let stderr = '';
  const machine = createFakeInstallMachine(setup.machine ?? {});
  const runner = createFakeProcessRunner({ outcomes: setup.versions ?? {} });
  const found = setup.programs ?? { systemctl: '/usr/bin' };
  const programs: ProgramResolver = { resolve: async (name) => found[name] ?? null };
  const dependencies: InstallCommandDependencies = {
    home: setup.home ?? HOME,
    isRoot: setup.isRoot ?? false,
    machine,
    programs,
    runner,
    platform: setup.platform ?? 'linux',
    source: setup.source ?? { kind: 'file', path: VERSIONS },
    packageDirectory: setup.packageDirectory ?? null,
    write: (text) => void (stdout += text),
    writeError: (line) => void (stderr += `${line}\n`),
  };
  const code = await runInstallCommand(argv, dependencies);
  return {
    code,
    stdout,
    stderr,
    probes: runner.requests.map((one) => [one.file, ...one.args].join(' ')),
    machine,
  };
}

/** A prefix holding the runtime install.sh unpacks, at a recent major. */
const OWNED_RUNTIME: Setup = {
  machine: { present: [`${PREFIX}/node/bin/node`] },
  versions: { [`${PREFIX}/node/bin/node --version`]: printed('v24.9.0\n') },
};

describe('agentplex install --print-unit', () => {
  it('prints the units install.sh prints for the same role and scope', async () => {
    for (const role of ['hub', 'server', 'both']) {
      const result = await run(['--print-unit', `--role=${role}`], OWNED_RUNTIME);

      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(fixture(`${role}-user.service`));
    }
  });

  it('prints the fleet units under --system, as root', async () => {
    const result = await run(['--print-unit', '--role=both', '--system'], {
      isRoot: true,
      machine: { present: ['/opt/agentplex/node/bin/node'] },
      versions: { '/opt/agentplex/node/bin/node --version': printed('v24.9.0\n') },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(fixture('both-system.service'));
  });

  it('names the node a PATH lookup adopts when the prefix holds none', async () => {
    const result = await run(['--print-unit', '--role=server'], {
      programs: { node: '/usr/local/bin' },
      versions: { '/usr/local/bin/node --version': printed('v24.21.0\n') },
    });

    expect(result.stdout).toBe(fixture('server-user-adopted.service'));
  });

  it('touches nothing: no manifest, no package directory, no settings or unit file', async () => {
    const result = await run(['--print-unit', '--role=hub', '--dry-run'], {
      ...OWNED_RUNTIME,
      packageDirectory: '/build/packages',
    });

    expect(result.stdout).toBe(fixture('hub-user.service'));
    expect(result.machine.asked).toEqual([`isFile ${PREFIX}/node/bin/node`]);
    expect(result.probes).toEqual([`${PREFIX}/node/bin/node --version`]);
  });
});

describe('agentplex install --dry-run', () => {
  it('prints the plan as report() lays it out, a padded label and the text', async () => {
    const result = await run(['--dry-run', '--role=hub'], {
      machine: { files: { [VERSIONS]: CURRENT } },
    });

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout.split('\n')).toEqual([
      `release    cli 1.4.0, hub 1.2.0, web 1.1.0 (from ${VERSIONS})`,
      'client protocol 3, which hub and web agree on',
      'server protocol 3, which hub and web agree on',
      'package    ' +
        [
          'https://github.com/SoftieSolutions/agentplex/releases/download/cli-v1.4.0/agentplex.tgz',
          'https://github.com/SoftieSolutions/agentplex/releases/download/hub-v1.2.0/agentplex-hub.tgz',
          'https://github.com/SoftieSolutions/agentplex/releases/download/web-v1.1.0/agentplex-web.tgz',
        ].join(' ') +
        ` into ${PREFIX}`,
      `settings   ${PREFIX}/agentplex.env (create)`,
      `unit       ${HOME}/.config/systemd/user/agentplex-hub.service (write, not enabled)`,
      '',
    ]);
    // A dry run asks no interpreter anything: nothing it prints names one.
    expect(result.probes).toEqual([]);
  });

  it('reads what is on the machine: a settings file and a unit that are there', async () => {
    const result = await run(['--dry-run', '--role=hub'], {
      machine: {
        files: { [VERSIONS]: CURRENT },
        present: [`${PREFIX}/agentplex.env`, `${HOME}/.config/systemd/user/agentplex-hub.service`],
      },
    });

    expect(result.stdout).toContain(
      `settings   ${PREFIX}/agentplex.env (already there, left alone)`,
    );
    expect(result.stdout).toContain(
      'agentplex-hub.service (already there, left alone; --print-unit shows this version)',
    );
  });

  it('skips the units on a machine with no systemd, saying which kind', async () => {
    const mac = await run(['--dry-run', '--role=hub'], {
      machine: { files: { [VERSIONS]: CURRENT } },
      platform: 'darwin',
    });
    const bare = await run(['--dry-run', '--role=hub'], {
      machine: { files: { [VERSIONS]: CURRENT } },
      programs: {},
    });

    expect(mac.stdout).toContain(
      'unit       skipped: macOS has no systemd, hand the process to launchd\n',
    );
    expect(bare.stdout).toContain('unit       skipped: no systemctl on this machine\n');
  });

  it('fetches nothing when the manifest is a URL, and says the versions went unresolved', async () => {
    const result = await run(['--dry-run', '--role=hub'], {
      source: {
        kind: 'url',
        url: 'https://raw.githubusercontent.com/SoftieSolutions/agentplex/v1/versions.json',
      },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      'release    cli (not resolved), hub (not resolved), web (not resolved): a dry run downloads nothing',
    );
    expect(result.machine.asked).not.toContain(`readFile ${VERSIONS}`);
  });

  it('takes the tarballs AGENTPLEX_PACKAGE names instead of any release', async () => {
    const result = await run(['--dry-run', '--role=server'], {
      packageDirectory: '/build/packages',
      machine: {
        directories: {
          '/build/packages': [
            'softiesolutions-agentplex-server-0.0.0.tgz',
            'softiesolutions-agentplex-0.0.0.tgz',
          ],
        },
      },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('release    the tarballs in /build/packages;');
    expect(result.stdout).not.toMatch(/^(client|server) protocol /m);
    expect(result.machine.asked).not.toContain(`readFile ${VERSIONS}`);
  });

  it('stops with install.sh sentence when AGENTPLEX_VERSIONS holds no manifest', async () => {
    const result = await run(['--dry-run', '--role=hub']);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      `agentplex install: AGENTPLEX_VERSIONS names "${MIRROR}", which holds no versions.json: it ` +
        'is the directory holding a copy of the manifest the release publishes\n',
    );
  });

  it('stops on a manifest it cannot read as one, naming the file', async () => {
    const result = await run(['--dry-run', '--role=hub'], {
      machine: { files: { [VERSIONS]: '{"cli":' } },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`agentplex install: ${VERSIONS} is not JSON`);
  });

  it('stops, printing no plan, when the plan stops', async () => {
    const result = await run(['--dry-run', '--role=hub@1.9.0'], {
      machine: { files: { [VERSIONS]: CURRENT } },
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      `agentplex install: ${VERSIONS} offers no hub release at 1.9.0`,
    );
  });
});

describe('agentplex install, refusing', () => {
  it('refuses a bare run with exit 2, naming install.sh as the way to install', async () => {
    const result = await run(['--role=hub']);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'agentplex install: the install itself is not in this command yet: install.sh is how to ' +
        'install agentplex, and this command answers --dry-run and --print-unit',
    );
  });

  it('refuses --system without root and a plain run as root, as resolve_layout does', async () => {
    const system = await run(['--print-unit', '--system'], { isRoot: false });
    const root = await run(['--dry-run'], { isRoot: true });
    const homeless = await run(['--print-unit'], { home: '' });

    expect(system.code).toBe(2);
    expect(system.stderr).toBe(
      'agentplex install: --system installs a service account and a system unit, so it must run ' +
        'as root\n',
    );
    expect(root.code).toBe(2);
    expect(root.stderr).toBe(
      'agentplex install: refusing to install as root: agentplex runs coding agents as you, and ' +
        'root-owned stores are tedious to undo. Run this as your own user, or pass --system to ' +
        'install under a service account\n',
    );
    expect(homeless.stderr).toBe(
      'agentplex install: HOME is not set, so there is no user prefix to install into\n',
    );
  });

  it('refuses a flag install.sh refuses, with the usage', async () => {
    const result = await run(['--rle=hub', '--dry-run']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('agentplex install: unknown option --rle=hub\n');
    expect(result.stderr).toContain('Usage: agentplex install');
  });
});
