import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serializeVersionsManifest, updateVersionsManifest } from '@agentplex/release';
import type { ProcessOutcome, ProcessRunner, ProgramResolver } from '@agentplex/providers';
import { createFakeProcessRunner, printed, refused } from '@agentplex/providers/testing';
import { describe, expect, it } from 'vitest';
import { createFakeNetwork } from '../../installation/fake-write-machine.js';
import { VERSIONS_URL, type ManifestSource } from '../../versions/version-check.js';
import {
  createFakeInstallMachine,
  type FakeInstallMachineOptions,
} from './fake-install-machine.js';
import { runInstallCommand, type InstallCommandDependencies } from './install-command.js';

/**
 * `agentplex install`, run against a machine a test writes down.
 *
 * Two questions and the install. `--print-unit` prints what `install.sh
 * --print-unit` prints -- held here against the captured fixtures, through the
 * same node lookup the real command makes -- and `--dry-run` prints the plan as
 * `report()` lays it out. Anything else is the install itself, run against the
 * write-machine fake and a process runner with answers written down, so what
 * it did is read back as the order of its acts and what it left on the disk.
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
  /** Every child started, every download and every change to the disk, in order. */
  readonly journal: readonly string[];
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
  /** What the network serves, by URL. */
  readonly served?: Readonly<Record<string, string>>;
  /** The URLs a download succeeds from. */
  readonly downloadable?: readonly string[];
  /** What any child with no answer above says. Nothing, by default: no program is there. */
  readonly fallback?: ProcessOutcome;
}

async function run(argv: readonly string[], setup: Setup = {}): Promise<Ran> {
  let stdout = '';
  let stderr = '';
  const journal: string[] = [];
  const machine = createFakeInstallMachine({ ...(setup.machine ?? {}), journal });
  const runner = createFakeProcessRunner({
    outcomes: setup.versions ?? {},
    ...(setup.fallback === undefined ? {} : { fallback: setup.fallback }),
  });
  const journaled: ProcessRunner = {
    run: async (request) => {
      journal.push([request.file, ...request.args].join(' '));
      return runner.run(request);
    },
  };
  const network = createFakeNetwork({
    served: setup.served ?? {},
    downloadable: setup.downloadable ?? [],
  });
  const found = setup.programs ?? { systemctl: '/usr/bin' };
  const programs: ProgramResolver = { resolve: async (name) => found[name] ?? null };
  const dependencies: InstallCommandDependencies = {
    home: setup.home ?? HOME,
    isRoot: setup.isRoot ?? false,
    machine,
    programs,
    runner: journaled,
    reader: network,
    downloader: {
      download: async (url, path) => {
        journal.push(`download ${url} -> ${path}`);
        return network.download(url, path);
      },
    },
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
    journal,
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

function settingsFixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../installation/fixtures/settings/${name}`, import.meta.url)),
    'utf8',
  );
}

const RELEASES = 'https://github.com/SoftieSolutions/agentplex/releases/download';
const CLI_TARBALL = `${RELEASES}/cli-v1.4.0/agentplex.tgz`;
const HUB_TARBALL = `${RELEASES}/hub-v1.2.0/agentplex-hub.tgz`;
const WEB_TARBALL = `${RELEASES}/web-v1.1.0/agentplex-web.tgz`;
const SERVER_TARBALL = `${RELEASES}/server-v1.5.0/agentplex-server.tgz`;
const EVERY_TARBALL = [CLI_TARBALL, HUB_TARBALL, WEB_TARBALL, SERVER_TARBALL];

/** The one directory a run downloads into: the fake hands out the same one every time. */
const WORK = '/tmp/agentplex-update';

const UNITS = `${HOME}/.config/systemd/user`;
const SETTINGS = `${PREFIX}/agentplex.env`;

/** One component's tree under a prefix, as npm lays out a global package. */
function tree(name: string, prefix = PREFIX): string {
  return `${prefix}/lib/node_modules/@softiesolutions/${name}`;
}

/** The staged install npm runs, against the shrinkwrap the package carries. */
function npmInstall(name: string, prefix = PREFIX): string {
  return (
    `${prefix}/node/bin/npm install --prefix ${tree(name, prefix)}.new ` +
    `--globalconfig=${prefix}/node/etc/npmrc --omit=dev --ignore-scripts=false ` +
    '--package-lock=true --no-save --install-strategy=hoisted --no-audit --no-fund'
  );
}

/**
 * A machine install.sh has put a runtime on and nothing else: the Node it
 * unpacked into the prefix, with the npm beside it, and a manifest to read.
 */
function freshMachine(prefix = PREFIX): Setup {
  return {
    machine: {
      files: { [VERSIONS]: CURRENT },
      present: [`${prefix}/node/bin/node`, `${prefix}/node/bin/npm`],
    },
    versions: {
      [`${prefix}/node/bin/node --version`]: printed('v24.9.0\n'),
      [`${prefix}/node/bin/npm config get globalconfig`]: printed(`${prefix}/node/etc/npmrc\n`),
    },
    downloadable: EVERY_TARBALL,
    fallback: printed(''),
  };
}

/** A fresh machine whose prefix already holds the command's package and the link that runs it. */
function cliInPrefix(manifest: string): Setup {
  const setup = freshMachine();
  return {
    ...setup,
    machine: {
      ...setup.machine,
      files: { [VERSIONS]: CURRENT, [`${tree('agentplex')}/package.json`]: manifest },
      present: [...(setup.machine?.present ?? []), `${PREFIX}/bin/agentplex`],
    },
  };
}

/** What `pnpm pack` leaves for a hub from a checkout: every package named 0.0.0. */
const LOCAL_BUILD = [
  'softiesolutions-agentplex-0.0.0.tgz',
  'softiesolutions-agentplex-hub-0.0.0.tgz',
  'softiesolutions-agentplex-web-0.0.0.tgz',
];

/** The lines of the journal that change something: downloads, moves, links, writes, owners. */
function changes(journal: readonly string[]): readonly string[] {
  return journal.filter((line) => /^(download|mv|link|write|chown|chmod) /.test(line));
}

describe('agentplex install, the run', () => {
  /**
   * The order is the design: the role's packages as one staged set, then the
   * command's own package in a set of its own, then what the account owns, then
   * the settings file, then the units -- `install.sh`'s order after its runtime.
   */
  it('installs the set, then itself, then writes the settings file and the units', async () => {
    const result = await run(['--role=hub'], freshMachine());

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(changes(result.journal)).toEqual([
      `download ${HUB_TARBALL} -> ${WORK}/hub.tgz`,
      `download ${WEB_TARBALL} -> ${WORK}/web.tgz`,
      `mv ${tree('agentplex-hub')}.new ${tree('agentplex-hub')}`,
      `mv ${tree('agentplex-web')}.new ${tree('agentplex-web')}`,
      `download ${CLI_TARBALL} -> ${WORK}/cli.tgz`,
      `mv ${tree('agentplex')}.new ${tree('agentplex')}`,
      `chmod 0755 ${tree('agentplex')}/apps/cli/dist/main.js`,
      `link ../lib/node_modules/@softiesolutions/agentplex/apps/cli/dist/main.js ${PREFIX}/bin/agentplex`,
      `write ${SETTINGS}`,
      `write ${UNITS}/agentplex-hub.service`,
    ]);
    // Both of the set installed before either moved: all or nothing.
    const journal = result.journal;
    expect(journal.indexOf(npmInstall('agentplex-web'))).toBeLessThan(
      journal.indexOf(`mv ${tree('agentplex-hub')}.new ${tree('agentplex-hub')}`),
    );
    expect(result.stdout).toContain(`settings   ${SETTINGS} (create)\n`);
    expect(result.stdout).toContain(
      `unit       ${UNITS}/agentplex-hub.service (write, not enabled)\n`,
    );
  });

  it('writes the settings file install.sh writes, 0600 before anything is in it', async () => {
    const result = await run(['--role=hub'], freshMachine());

    expect(result.machine.contents.get(SETTINGS)).toBe(settingsFixture('user.env'));
    expect(result.machine.modes.get(SETTINGS)).toBe(0o600);
    expect(result.machine.acts).toContain(`mkdir ${PREFIX}`);
  });

  it("writes renderUnit's unit, the one --print-unit prints", async () => {
    const result = await run(['--role=hub'], freshMachine());

    expect(result.machine.contents.get(`${UNITS}/agentplex-hub.service`)).toBe(
      fixture('hub-user.service'),
    );
    // Written, never enabled or started: nothing asks systemctl anything.
    expect(result.probes.join('\n')).not.toContain('systemctl');
  });

  /**
   * Whether the command's own package moves is the target prefix's answer: the
   * version its tree says it is, and the link that runs it. The process running
   * this may be another install's, or a local build every one of which is
   * 0.0.0, so its own version says nothing about what is in the prefix.
   */
  it('leaves its own package alone when the prefix holds that version and links it', async () => {
    const result = await run(['--role=hub'], {
      ...cliInPrefix('{"version":"1.4.0"}'),
    });

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.journal.join('\n')).not.toContain(CLI_TARBALL);
    expect(result.journal.join('\n')).not.toContain('link ');
    expect(result.stdout).toContain(
      `agentplex 1.4.0 is already in ${tree('agentplex')}, and ${PREFIX}/bin/agentplex is there: ` +
        'left as it is\n',
    );
    expect(result.journal.join('\n')).toContain(HUB_TARBALL);
  });

  it('installs its own package when the prefix holds another version', async () => {
    const result = await run(['--role=hub'], {
      ...cliInPrefix('{"version":"1.2.0"}'),
    });

    expect(result.code).toBe(0);
    expect(changes(result.journal)).toContain(`download ${CLI_TARBALL} -> ${WORK}/cli.tgz`);
    expect(changes(result.journal)).toContain(`mv ${tree('agentplex')}.new ${tree('agentplex')}`);
    expect(result.stdout).not.toContain('left as it is');
  });

  it('installs its own package when the prefix has none', async () => {
    const result = await run(['--role=hub'], freshMachine());

    expect(result.code).toBe(0);
    expect(result.journal.join('\n')).toContain(CLI_TARBALL);
  });

  it('installs its own package when the prefix holds that version and no link to run it', async () => {
    const setup = cliInPrefix('{"version":"1.4.0"}');
    const result = await run(['--role=hub'], {
      ...setup,
      machine: { ...setup.machine, present: freshMachine().machine?.present ?? [] },
    });

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(changes(result.journal)).toContain(`download ${CLI_TARBALL} -> ${WORK}/cli.tgz`);
    expect(changes(result.journal)).toContain(
      `link ../lib/node_modules/@softiesolutions/agentplex/apps/cli/dist/main.js ` +
        `${PREFIX}/bin/agentplex`,
    );
  });

  it('installs its own package when the tree in the prefix cannot say what version it is', async () => {
    const malformed = await run(['--role=hub'], {
      ...cliInPrefix('{"name":"@softiesolutions/agentplex"}'),
    });
    const garbled = await run(['--role=hub'], {
      ...cliInPrefix('1.4.0'),
    });
    const setup = cliInPrefix('{"version":"1.4.0"}');
    const unreadable = await run(['--role=hub'], {
      ...setup,
      machine: {
        ...setup.machine,
        files: { [VERSIONS]: CURRENT },
        unreadable: { [`${tree('agentplex')}/package.json`]: 'EACCES: permission denied' },
      },
    });

    for (const result of [malformed, garbled, unreadable]) {
      expect(result.code).toBe(0);
      expect(result.journal.join('\n')).toContain(CLI_TARBALL);
    }
  });

  it('always installs its own package from AGENTPLEX_PACKAGE, whose builds are all 0.0.0', async () => {
    const setup = cliInPrefix('{"version":"0.0.0"}');
    const result = await run(['--role=hub'], {
      ...setup,
      packageDirectory: '/build/packages',
      machine: { ...setup.machine, directories: { '/build/packages': LOCAL_BUILD } },
    });

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.probes).toContain(
      `tar -xzf /build/packages/softiesolutions-agentplex-0.0.0.tgz -C ` +
        `${tree('agentplex')}.new --strip-components=1 --no-same-owner`,
    );
    expect(changes(result.journal)).toContain(`mv ${tree('agentplex')}.new ${tree('agentplex')}`);
    expect(result.stdout).not.toContain('left as it is');
  });

  it('leaves the trees it found, and writes no settings file and no unit, when npm refuses', async () => {
    const setup = freshMachine();
    const before = {
      [VERSIONS]: CURRENT,
      [`${tree('agentplex-hub')}/package.json`]: '{"version":"1.1.0"}',
      [`${tree('agentplex-web')}/package.json`]: '{"version":"1.0.0"}',
    };
    const result = await run(['--role=hub'], {
      ...setup,
      machine: { ...setup.machine, files: before },
      versions: {
        ...setup.versions,
        [npmInstall('agentplex-web')]: refused(1, 'npm error code ETARGET'),
      },
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('npm error code ETARGET');
    expect(result.machine.acts.filter((act) => act.startsWith('mv '))).toEqual([]);
    expect(result.machine.contents.get(`${tree('agentplex-hub')}/package.json`)).toBe(
      '{"version":"1.1.0"}',
    );
    expect(result.machine.contents.get(`${tree('agentplex-web')}/package.json`)).toBe(
      '{"version":"1.0.0"}',
    );
    expect(result.machine.acts.filter((act) => act.startsWith('write '))).toEqual([]);
    expect(result.journal.join('\n')).not.toContain(CLI_TARBALL);
    expect(result.stderr).toContain('no settings file and no unit were written');
  });

  it('writes nothing when a package of the set will not move in, and puts the set back', async () => {
    const hub = tree('agentplex-hub');
    const web = tree('agentplex-web');
    const setup = freshMachine();
    const result = await run(['--role=hub'], {
      ...setup,
      machine: {
        ...setup.machine,
        refusedRenames: { [`${web}.new -> ${web}`]: 'EXDEV: cross-device link' },
      },
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain('EXDEV: cross-device link');
    // A fresh machine had no hub, so the hub that moved in is taken back out.
    expect(await result.machine.exists(hub)).toBe(false);
    expect(await result.machine.exists(`${hub}.new`)).toBe(false);
    expect(result.machine.acts.filter((act) => act.startsWith('write '))).toEqual([]);
  });

  it('leaves a settings file and a unit that are there byte for byte alone, and says so', async () => {
    const setup = freshMachine();
    const mine = 'AGENTPLEX_ROLE=hub\n# edited by hand\n';
    const unit = '[Unit]\n# edited by hand\n';
    const result = await run(['--role=hub'], {
      ...setup,
      machine: {
        ...setup.machine,
        files: {
          [VERSIONS]: CURRENT,
          [SETTINGS]: mine,
          [`${UNITS}/agentplex-hub.service`]: unit,
        },
      },
    });

    expect(result.code).toBe(0);
    expect(result.machine.contents.get(SETTINGS)).toBe(mine);
    expect(result.machine.contents.get(`${UNITS}/agentplex-hub.service`)).toBe(unit);
    expect(result.machine.acts.filter((act) => act.startsWith('write '))).toEqual([]);
    expect(result.stdout).toContain(`settings   ${SETTINGS} (already there, left alone)\n`);
    expect(result.stdout).toContain(
      `unit       ${UNITS}/agentplex-hub.service (already there, left alone; --print-unit ` +
        'shows this version)\n',
    );
  });

  it('skips the units with the reason on a machine with no systemd', async () => {
    const mac = await run(['--role=hub'], { ...freshMachine(), platform: 'darwin' });
    const bare = await run(['--role=hub'], { ...freshMachine(), programs: {} });

    expect(mac.code).toBe(0);
    expect(mac.stdout).toContain(
      'unit       skipped: macOS has no systemd, hand the process to launchd\n',
    );
    expect(bare.stdout).toContain('unit       skipped: no systemctl on this machine\n');
    for (const result of [mac, bare]) {
      expect(result.machine.acts.join('\n')).not.toContain(UNITS);
      expect(result.machine.contents.has(SETTINGS)).toBe(true);
    }
  });

  it('gives nothing to any account on a per-user install', async () => {
    const result = await run(['--role=hub'], freshMachine());

    expect(result.probes.join('\n')).not.toMatch(/^(chown|id) /m);
    expect(result.stdout).not.toContain('ownership');
  });

  it('installs from the tarballs AGENTPLEX_PACKAGE names, downloading nothing', async () => {
    const setup = freshMachine();
    const result = await run(['--role=hub'], {
      ...setup,
      packageDirectory: '/build/packages',
      source: { kind: 'url', url: VERSIONS_URL },
      machine: {
        ...setup.machine,
        directories: {
          '/build/packages': [
            'softiesolutions-agentplex-0.0.0.tgz',
            'softiesolutions-agentplex-hub-0.0.0.tgz',
            'softiesolutions-agentplex-web-0.0.0.tgz',
          ],
        },
      },
    });

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.journal.join('\n')).not.toContain('download ');
    expect(result.probes).toContain(
      `tar -xzf /build/packages/softiesolutions-agentplex-hub-0.0.0.tgz -C ` +
        `${tree('agentplex-hub')}.new --strip-components=1 --no-same-owner`,
    );
  });

  it('stops naming AGENTPLEX_VERSIONS when the manifest cannot be reached, having changed nothing', async () => {
    const result = await run(['--role=hub'], {
      ...freshMachine(),
      source: { kind: 'url', url: VERSIONS_URL },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`agentplex install: could not reach ${VERSIONS_URL}`);
    expect(result.stderr).toContain('Point AGENTPLEX_VERSIONS at a directory holding a copy of it');
    expect(result.machine.acts).toEqual([]);
  });

  it('stops naming AGENTPLEX_VERSIONS when the directory it names holds no manifest', async () => {
    const setup = freshMachine();
    const result = await run(['--role=hub'], {
      ...setup,
      machine: { ...setup.machine, files: {} },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `AGENTPLEX_VERSIONS names "${MIRROR}", which holds no versions.json`,
    );
    expect(result.machine.acts).toEqual([]);
  });

  it('reads the manifest off the network for a real run, and installs what it names', async () => {
    const setup = freshMachine();
    const result = await run(['--role=hub'], {
      ...setup,
      source: { kind: 'url', url: VERSIONS_URL },
      served: { [VERSIONS_URL]: CURRENT },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      `release    cli 1.4.0, hub 1.2.0, web 1.1.0 (from ${VERSIONS_URL})`,
    );
  });
});

describe('agentplex install --system, the run', () => {
  const SYSTEM_PREFIX = '/opt/agentplex';
  const OWNED = [
    `${SYSTEM_PREFIX}/bin`,
    `${SYSTEM_PREFIX}/lib/node_modules`,
    `${SYSTEM_PREFIX}/share`,
    '/var/lib/agentplex',
  ];

  function fleet(): Setup {
    const setup = freshMachine(SYSTEM_PREFIX);
    return {
      ...setup,
      isRoot: true,
      versions: { ...setup.versions, 'id -u agentplex': printed('998\n') },
    };
  }

  it('gives the account exactly the four paths, after the packages and before the settings', async () => {
    const result = await run(['--role=hub', '--system'], fleet());

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const owners = result.journal.filter((line) => line.startsWith('chown -R '));
    expect(owners).toEqual(OWNED.map((path) => `chown -R agentplex:agentplex ${path}`));
    const journal = result.journal;
    expect(journal.indexOf(owners[0] ?? '')).toBeGreaterThan(
      journal.indexOf(
        `link ../lib/node_modules/@softiesolutions/agentplex/apps/cli/dist/main.js ${SYSTEM_PREFIX}/bin/agentplex`,
      ),
    );
    expect(journal.indexOf(owners[3] ?? '')).toBeLessThan(
      journal.indexOf('write /etc/agentplex/agentplex.env'),
    );
    expect(result.stdout).toContain(
      `ownership  agentplex owns ${SYSTEM_PREFIX}/bin, ${SYSTEM_PREFIX}/lib/node_modules, ` +
        `${SYSTEM_PREFIX}/share and /var/lib/agentplex; root keeps ${SYSTEM_PREFIX}/node and ` +
        '/etc/agentplex/agentplex.env\n',
    );
  });

  it('writes the fleet settings file, root:agentplex at 0640, in that order', async () => {
    const result = await run(['--role=hub', '--system'], fleet());

    const file = '/etc/agentplex/agentplex.env';
    expect(result.machine.contents.get(file)).toBe(settingsFixture('system.env'));
    const journal = result.journal;
    const written = journal.indexOf(`write ${file}`);
    const owned = journal.indexOf(`chown root:agentplex ${file}`);
    const narrowed = journal.indexOf(`chmod 0640 ${file}`);
    expect(written).toBeGreaterThan(-1);
    expect(owned).toBeGreaterThan(written);
    expect(narrowed).toBeGreaterThan(owned);
    expect(result.machine.modes.get(file)).toBe(0o640);
    expect(result.machine.contents.get('/etc/systemd/system/agentplex-hub.service')).toBe(
      fixture('hub-system.service'),
    );
  });

  it('stops before anything is installed when the service account is not there, naming it', async () => {
    const result = await run(['--role=hub', '--system'], {
      ...fleet(),
      versions: {
        ...fleet().versions,
        'id -u agentplex': refused(1, "id: 'agentplex': no such user"),
      },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('agentplex install: there is no agentplex service account');
    expect(result.journal.join('\n')).not.toContain('download ');
    expect(result.machine.acts).toEqual([]);
  });
});
