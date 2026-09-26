import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ProcessRunner, ProgramResolver } from '@agentplex/providers';
import type { ReleaseProtocol } from '@agentplex/release';
import {
  createFakeProcessRunner,
  printed,
  refused,
  type FakeProcessRunner,
} from '@agentplex/providers/testing';
import { createSystemd } from '../../installation/systemd.js';
import { VERSIONS_URL } from '../../versions/version-check.js';
import { NODE_DIST_URL } from './runtime.js';
import { createFakeNetwork, type FakeNetwork } from '../../installation/fake-write-machine.js';
import { createFakeUpdateMachine, type FakeUpdateMachine } from './fake-update-machine.js';
import { runUpdateCommand } from './update-command.js';

/**
 * `agentplex update` against a machine that is a table, a network that is a
 * lookup and a `systemctl` that is a process runner with an answer written
 * down.
 *
 * Nothing here reaches a network, spawns an npm, touches a prefix or asks a
 * real `systemctl`. That is not only hygiene: the three cases this command
 * exists to get right -- an unreachable manifest, a compile that would fail, a
 * unit that was already stopped -- cannot be arranged against real ones at all.
 *
 * **The ordering assertions all read one list.** `journal` is every child this
 * run would have started, every download and every change to the disk, in the
 * one order they happened -- so "the runtime moved before the packages", "every
 * package staged before any tree moved", "the command's own package went last"
 * and "only the units that were running came back" are assertions about the
 * sequence a real run would have produced. `runner.requests` alone would miss
 * half of it: a swap is renames, and a rename is not a child process.
 */

const HOME = '/home/alice';
const PREFIX = `${HOME}/.agentplex`;
const UNITS = `${HOME}/.config/systemd/user`;
const HUB = 'agentplex-hub.service';
const SERVER = 'agentplex-server.service';
const CACHE = `${HOME}/.cache/agentplex/versions.json`;
const NOW = 1_800_000_000_000;

const DOWNLOAD = 'https://github.com/SoftieSolutions/agentplex/releases/download';
const SUMS = `${NODE_DIST_URL}/SHASUMS256.txt`;

const SHOW_PROPERTIES =
  '--property=LoadState --property=ActiveState --property=SubState ' +
  '--property=UnitFileState --property=ActiveEnterTimestamp';

function show(unit: string): string {
  return `systemctl --user show ${unit} ${SHOW_PROPERTIES}`;
}

function state(active: string): ReturnType<typeof printed> {
  return printed(
    [
      'LoadState=loaded',
      `ActiveState=${active}`,
      'SubState=running',
      'UnitFileState=enabled',
      'ActiveEnterTimestamp=Thu 2026-09-11 09:12:03 UTC',
    ].join('\n'),
  );
}

function manifest(version: string, protocol: ReleaseProtocol | null): string {
  return JSON.stringify(protocol === null ? { version } : { version, agentplex: { protocol } });
}

/** The legs each component records, as packaging writes them. */
const LEGS: Readonly<Record<string, readonly ('client' | 'server')[]>> = {
  cli: [],
  hub: ['client', 'server'],
  server: ['server'],
  web: ['client', 'server'],
};

/** A component's legs, all at one number, or given outright. */
function legsOf(component: string, protocol: number | ReleaseProtocol): ReleaseProtocol {
  if (typeof protocol !== 'number') return protocol;
  return Object.fromEntries((LEGS[component] ?? []).map((leg) => [leg, protocol]));
}

function packageAt(name: string): string {
  return `${PREFIX}/lib/node_modules/${name}/package.json`;
}

/** A `both` machine with all four packages, a stamped runtime and two units. */
function wholeMachine(): Record<string, string> {
  return {
    [`${PREFIX}/agentplex.env`]: `AGENTPLEX_ROLE=both\nAGENTPLEX_PREFIX=${PREFIX}\n`,
    [packageAt('@softiesolutions/agentplex')]: manifest('1.4.0', legsOf('cli', 3)),
    [packageAt('@softiesolutions/agentplex-hub')]: manifest('1.2.0', legsOf('hub', 3)),
    [packageAt('@softiesolutions/agentplex-server')]: manifest('1.4.0', legsOf('server', 3)),
    [packageAt('@softiesolutions/agentplex-web')]: manifest('1.1.0', legsOf('web', 3)),
    [`${PREFIX}/node/.agentplex-node-version`]: 'v24.9.0\n',
  };
}

/**
 * The npm that came with the runtime this prefix owns.
 *
 * Present in every world but one, because it is the npm `npm_command` picks:
 * a runtime this install unpacked is on nobody's PATH, so an npm resolved off
 * PATH would be the machine's, running under the machine's Node -- which is the
 * failure `ensure_node` has a captured note about.
 */
const OWNED_NPM = `${PREFIX}/node/bin/npm`;

/**
 * Where that npm says its global config is, asked without `--prefix`.
 *
 * `--prefix` would move the answer to `<staging>/etc/npmrc`, a file that does
 * not exist, and the operator's mirror or proxy would silently stop applying.
 */
const GLOBALCONFIG = `${PREFIX}/node/etc/npmrc`;
const ASK_GLOBALCONFIG = `${OWNED_NPM} config get globalconfig`;

/** The one directory a run downloads into. The fake hands out the same one every time. */
const WORK = '/tmp/agentplex-update';

const PACKAGES = `${PREFIX}/lib/node_modules/@softiesolutions`;

/** One component's tree under the prefix, as npm lays out a global package. */
function tree(name: string): string {
  return `${PACKAGES}/${name}`;
}

/** The unpack a component's tarball gets, into the staging directory beside its tree. */
function unpack(component: string, name: string): string {
  return (
    `tar -xzf ${WORK}/${component}.tgz -C ${tree(name)}.new ` +
    '--strip-components=1 --no-same-owner'
  );
}

/** The install run in that staging directory, against the shrinkwrap it carries. */
function npmInstall(name: string): string {
  return (
    `${OWNED_NPM} install --prefix ${tree(name)}.new --globalconfig=${GLOBALCONFIG} ` +
    '--omit=dev --ignore-scripts=false --package-lock=true --no-save ' +
    '--install-strategy=hoisted --no-audit --no-fund'
  );
}

/** The swap that follows once every package in an invocation has staged. */
function swap(name: string): readonly string[] {
  return [
    `rm ${tree(name)}.old`,
    `mv ${tree(name)} ${tree(name)}.old`,
    `mv ${tree(name)}.new ${tree(name)}`,
    `rm ${tree(name)}.old`,
  ];
}

const SERVER_TARBALL = `${DOWNLOAD}/server-v1.5.0/agentplex-server.tgz`;
const CLI_TARBALL = `${DOWNLOAD}/cli-v1.5.0/agentplex.tgz`;

/** Every release tarball any test below moves a machine to. */
const RELEASES = [
  SERVER_TARBALL,
  CLI_TARBALL,
  `${DOWNLOAD}/hub-v1.3.0/agentplex-hub.tgz`,
  `${DOWNLOAD}/web-v1.2.0/agentplex-web.tgz`,
  `${DOWNLOAD}/hub-v1.9.0/agentplex-hub.tgz`,
];

/**
 * What the release branch is serving, in the shape a release writes.
 *
 * Stated as one release per component and expanded into the `{current,
 * releases}` shape here, because what every test below is saying is "this is
 * the version that is current" -- a history written out at each call site
 * would be the fixture asserting things no test is about.
 */
function published(
  entries: Readonly<Record<string, { version: string; protocol: number | ReleaseProtocol }>> = {},
): string {
  const current: Readonly<Record<string, { version: string; protocol: number | ReleaseProtocol }>> =
    {
      cli: { version: '1.5.0', protocol: 3 },
      hub: { version: '1.2.0', protocol: 3 },
      server: { version: '1.5.0', protocol: 3 },
      web: { version: '1.1.0', protocol: 3 },
      ...entries,
    };
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(current).map(([component, release]) => [
        component,
        {
          current: release.version,
          releases: { [release.version]: legsOf(component, release.protocol) },
        },
      ]),
    ),
  );
}

/**
 * The same manifest with more of the hub's history in it: releases published
 * before the current one, which is what a series pin resolves against. The
 * current release stays `1.2.0`, so an unpinned run is unchanged by them.
 */
function publishedWithHub(...older: readonly string[]): string {
  const manifest = z
    .record(
      z.string(),
      z.object({ current: z.string(), releases: z.record(z.string(), z.unknown()) }),
    )
    .parse(JSON.parse(published()));
  const hub = manifest['hub'];
  if (hub === undefined) throw new Error('the published manifest has no hub');
  for (const version of older) hub.releases[version] = legsOf('hub', 3);
  return JSON.stringify(manifest);
}

/** What nodejs.org serves, cut to the two lines that matter. */
const CHECKSUMS = [
  '3aa2...  node-v24.10.0-linux-arm64.tar.gz',
  `${'a'.repeat(64)}  node-v24.10.0-linux-x64.tar.gz`,
  `${'b'.repeat(64)}  node-v24.10.0-darwin-arm64.tar.gz`,
].join('\n');

const NODE_ARCHIVE = `${NODE_DIST_URL}/node-v24.10.0-linux-x64.tar.gz`;

interface Run {
  readonly code: number;
  readonly out: string;
  readonly errors: string;
  readonly runner: FakeProcessRunner;
  readonly machine: FakeUpdateMachine;
  readonly network: FakeNetwork;
  /** Every child started, every download and every change to the disk, in order. */
  readonly journal: readonly string[];
}

interface World {
  readonly files?: Readonly<Record<string, string>>;
  readonly units?: readonly string[];
  readonly running?: readonly string[];
  readonly systemd?: boolean;
  readonly served?: Readonly<Record<string, string>>;
  readonly outcomes?: Readonly<Record<string, ReturnType<typeof printed>>>;
  readonly answer?: 'yes' | 'no';
  readonly hashes?: Readonly<Record<string, string>>;
  readonly downloadable?: readonly string[];
  readonly toolchain?: boolean;
  readonly npm?: boolean;
  /** What nodejs.org serves, or `null` for a machine that cannot reach it. */
  readonly sums?: string | null;
  readonly cacheFile?: string | null;
  readonly unwritable?: Readonly<Record<string, string>>;
  readonly unremovable?: Readonly<Record<string, string>>;
  readonly refusedRenames?: Readonly<Record<string, string>>;
}

async function run(argv: readonly string[] = [], world: World = {}): Promise<Run> {
  const out: string[] = [];
  const errors: string[] = [];
  const journal: string[] = [];
  const units = world.units ?? [HUB, SERVER];
  const running = world.running ?? units;

  const outcomes: Record<string, ReturnType<typeof printed>> = {
    ...Object.fromEntries(
      units.map((unit) => [show(unit), state(running.includes(unit) ? 'active' : 'inactive')]),
    ),
    'systemctl --user stop agentplex-hub.service agentplex-server.service': printed(''),
    'systemctl --user start agentplex-hub.service agentplex-server.service': printed(''),
    'systemctl --user stop agentplex-hub.service': printed(''),
    'systemctl --user start agentplex-hub.service': printed(''),
    'systemctl --user stop agentplex-server.service': printed(''),
    'systemctl --user start agentplex-server.service': printed(''),
    [ASK_GLOBALCONFIG]: printed(`${GLOBALCONFIG}\n`),
    ...(world.outcomes ?? {}),
  };

  const runner = createFakeProcessRunner({ outcomes, fallback: printed('') });
  const journaled: ProcessRunner = {
    run: async (request) => {
      journal.push([request.file, ...request.args].join(' '));
      return runner.run(request);
    },
  };
  const present = new Set(['systemctl']);
  if (world.toolchain ?? true) {
    present.add('python3');
    present.add('make');
    present.add('g++');
  }
  if (world.npm ?? true) present.add('npm');
  const programs: ProgramResolver = {
    resolve: async (name) =>
      (world.systemd ?? true) || name !== 'systemctl'
        ? present.has(name)
          ? '/usr/bin'
          : null
        : null,
  };

  const machine = createFakeUpdateMachine({
    files: world.files ?? wholeMachine(),
    present: [
      ...units.map((unit) => `${UNITS}/${unit}`),
      ...((world.npm ?? true) ? [OWNED_NPM] : []),
    ],
    hashes: world.hashes ?? { '/tmp/agentplex-update/node.tar.gz': 'a'.repeat(64) },
    ...(world.answer === undefined ? {} : { answer: world.answer }),
    ...(world.unwritable === undefined ? {} : { unwritable: world.unwritable }),
    ...(world.unremovable === undefined ? {} : { unremovable: world.unremovable }),
    ...(world.refusedRenames === undefined ? {} : { refusedRenames: world.refusedRenames }),
    journal,
  });

  const network = createFakeNetwork({
    served: {
      [VERSIONS_URL]: published(),
      ...(world.sums === null ? {} : { [SUMS]: world.sums ?? CHECKSUMS }),
      ...(world.served ?? {}),
    },
    downloadable: world.downloadable ?? [NODE_ARCHIVE, ...RELEASES],
  });

  const code = await runUpdateCommand(argv, {
    home: HOME,
    machine,
    systemd: createSystemd({ runner: journaled, programs }),
    runner: journaled,
    programs,
    reader: network,
    downloader: {
      download: async (url, path) => {
        journal.push(`download ${url} -> ${path}`);
        return network.download(url, path);
      },
    },
    source: { kind: 'url', url: VERSIONS_URL },
    cacheFile: world.cacheFile === undefined ? CACHE : world.cacheFile,
    now: () => NOW,
    platform: 'linux',
    architecture: 'x64',
    write: (line) => out.push(line),
    writeError: (line) => errors.push(line),
  });

  return {
    code,
    out: out.join('\n'),
    errors: errors.join('\n'),
    runner,
    machine,
    network,
    journal,
  };
}

/** Every child this run would have started, as one line each, in order. */
function spawned(runner: FakeProcessRunner): readonly string[] {
  return runner.requests.map((request) => [request.file, ...request.args].join(' '));
}

describe('the order things happen in', () => {
  /**
   * The three ordering constraints, asserted on one list, because they are
   * about one sequence: a native addon has to be built against the runtime that
   * will load it, this command runs out of the package it overwrites, and only
   * what was running may be started again.
   */
  it('stops, swaps the runtime, installs the others, installs itself, and starts again', async () => {
    const updated = await run(['--node']);

    expect(updated.code).toBe(0);
    const acts = updated.journal.filter(
      (line) =>
        !line.includes(' show ') && !line.includes('daemon-reload') && !line.includes('/.cache/'),
    );
    expect(acts).toEqual([
      // Asked before anything is stopped: an npm that cannot answer this is an
      // npm that would not install anything either.
      ASK_GLOBALCONFIG,
      `systemctl --user stop ${HUB} ${SERVER}`,
      // The runtime first: npm is about to build an addon against it.
      `download ${NODE_ARCHIVE} -> ${WORK}/node.tar.gz`,
      `rm ${PREFIX}/node.old`,
      `rm ${PREFIX}/node.new`,
      `mkdir ${PREFIX}/node.new`,
      `tar -xzf ${WORK}/node.tar.gz -C ${PREFIX}/node.new --strip-components=1 --no-same-owner`,
      `write ${PREFIX}/node.new/.agentplex-node-version`,
      `mv ${PREFIX}/node ${PREFIX}/node.old`,
      `mv ${PREFIX}/node.new ${PREFIX}/node`,
      `rm ${PREFIX}/node.old`,
      `rm ${WORK}`,
      // The others, as one staged set: downloaded, unpacked beside the tree and
      // installed against the shrinkwrap it carries, and only then moved in.
      `download ${SERVER_TARBALL} -> ${WORK}/server.tgz`,
      `rm ${tree('agentplex-server')}.new`,
      `mkdir ${tree('agentplex-server')}.new`,
      unpack('server', 'agentplex-server'),
      npmInstall('agentplex-server'),
      ...swap('agentplex-server'),
      // Then the command's own package, last, and the link npm used to make.
      `download ${CLI_TARBALL} -> ${WORK}/cli.tgz`,
      `rm ${tree('agentplex')}.new`,
      `mkdir ${tree('agentplex')}.new`,
      unpack('cli', 'agentplex'),
      npmInstall('agentplex'),
      ...swap('agentplex'),
      `mkdir ${PREFIX}/bin`,
      `chmod 0755 ${tree('agentplex')}/apps/cli/dist/main.js`,
      `link ../lib/node_modules/@softiesolutions/agentplex/apps/cli/dist/main.js ${PREFIX}/bin/agentplex`,
      `rm ${WORK}`,
      `systemctl --user start ${HUB} ${SERVER}`,
    ]);
  });

  /**
   * All or nothing is about a set, so it has to be seen on one: a hub and its
   * client both staged before either tree moves, because a hub whose client
   * failed to install is a hub serving 503.
   */
  it('stages every package of an invocation before it moves any tree', async () => {
    const clientMoved = { client: 4, server: 3 };
    const updated = await run(['hub', 'web', '--no-node'], {
      served: {
        [VERSIONS_URL]: published({
          hub: { version: '1.3.0', protocol: clientMoved },
          web: { version: '1.2.0', protocol: clientMoved },
        }),
      },
    });

    expect(updated.code).toBe(0);
    const installed = updated.journal.indexOf(npmInstall('agentplex-web'));
    const firstMove = updated.journal.findIndex((line) => line.startsWith('mv '));
    expect(updated.journal.indexOf(npmInstall('agentplex-hub'))).toBeGreaterThan(-1);
    expect(installed).toBeGreaterThan(-1);
    expect(firstMove).toBeGreaterThan(installed);
    expect(updated.journal.filter((line) => line.startsWith('mv '))).toEqual([
      `mv ${tree('agentplex-hub')} ${tree('agentplex-hub')}.old`,
      `mv ${tree('agentplex-hub')}.new ${tree('agentplex-hub')}`,
      `mv ${tree('agentplex-web')} ${tree('agentplex-web')}.old`,
      `mv ${tree('agentplex-web')}.new ${tree('agentplex-web')}`,
    ]);
    // No command package moved, so there is no link to remake.
    expect(updated.journal.join('\n')).not.toContain('link ');
  });

  /**
   * Nothing here is a global install. `npm install --global <tarball>` is the
   * one form that ignores the packed shrinkwrap and resolves every range fresh
   * against whatever the registry calls newest that day.
   */
  it('never hands npm --global', async () => {
    const updated = await run(['--node']);

    expect(updated.code).toBe(0);
    expect(updated.runner.requests.length).toBeGreaterThan(0);
    for (const request of updated.runner.requests) expect(request.args).not.toContain('--global');
  });

  /**
   * The runtime is replaced by unpacking beside the old one, setting the old
   * one aside and renaming the new one in, so that the moment this machine has
   * no interpreter lies between two renames and the second failing is undone by
   * a third. The old runtime is removed only once the new one is in place, and
   * the stamp goes in before the move, so the directory that arrives is either
   * a complete runtime with its record or is not there at all.
   */
  it('leaves the prefix with a stamped runtime, moved into place rather than over', async () => {
    const updated = await run(['--node']);

    expect(updated.machine.acts.filter((act) => act.includes(`${PREFIX}/node`))).toEqual([
      // Both cleared first, because a staging directory left by an earlier
      // failed run is what would otherwise be unpacked over, and an old
      // runtime left behind is what the current one could not be set aside on.
      `rm ${PREFIX}/node.old`,
      `rm ${PREFIX}/node.new`,
      `mkdir ${PREFIX}/node.new`,
      `write ${PREFIX}/node.new/.agentplex-node-version`,
      `mv ${PREFIX}/node ${PREFIX}/node.old`,
      `mv ${PREFIX}/node.new ${PREFIX}/node`,
      `rm ${PREFIX}/node.old`,
    ]);
    expect(updated.machine.acts).not.toContain(`rm ${PREFIX}/node`);
    expect(updated.machine.contents.get(`${PREFIX}/node/.agentplex-node-version`)).toBe(
      'v24.10.0\n',
    );
  });

  /**
   * A unit somebody stopped this morning stays stopped. An update replaces
   * bytes; what an operator decided about which daemons run is not its
   * business, and `enable --now` would have decided it for them.
   */
  it('starts exactly the units it stopped, and no others', async () => {
    const updated = await run([], { running: [HUB] });

    const acts = spawned(updated.runner).filter((line) => line.includes('systemctl'));
    expect(acts).toContain(`systemctl --user stop ${HUB}`);
    expect(acts).toContain(`systemctl --user start ${HUB}`);
    expect(acts.join('\n')).not.toContain(`stop ${SERVER}`);
    expect(acts.join('\n')).not.toContain('enable');
    expect(acts.join('\n')).not.toContain('disable');
  });

  it('stops nothing on a machine where nothing is running', async () => {
    const updated = await run([], { running: [] });

    expect(spawned(updated.runner).join('\n')).not.toContain('stop');
    expect(updated.out).toContain('no unit here is running');
    expect(updated.code).toBe(0);
  });
});

describe('what the manifest says', () => {
  it('exits 0 and installs nothing when this machine is already current', async () => {
    const updated = await run(['--no-node'], {
      files: {
        ...wholeMachine(),
        [packageAt('@softiesolutions/agentplex')]: manifest('1.5.0', legsOf('cli', 3)),
        [packageAt('@softiesolutions/agentplex-server')]: manifest('1.5.0', legsOf('server', 3)),
      },
      sums: `${'c'.repeat(64)}  node-v24.9.0-linux-x64.tar.gz`,
    });

    expect(updated.code).toBe(0);
    expect(updated.out).toContain('Already current');
    expect(spawned(updated.runner).join('\n')).not.toContain('npm');
  });

  /**
   * The degrade that must not over-claim. `install.sh` says the same thing when
   * it cannot reach nodejs.org, and reporting an unreachable manifest as up to
   * date is the one answer that would be believed and wrong.
   */
  it('says it could not check rather than up to date when the manifest is unreachable', async () => {
    const updated = await run(['--no-node'], { served: { [VERSIONS_URL]: '' } });

    expect(updated.out).toContain('could not check');
    expect(updated.out).not.toContain('up to date');
    expect(updated.code).toBe(1);
    expect(spawned(updated.runner).join('\n')).not.toContain('npm');
  });

  it('refuses a manifest that is not one, naming where it came from', async () => {
    const updated = await run(['--check'], { served: { [VERSIONS_URL]: '{"cli":"1.5.0"}' } });

    expect(updated.code).toBe(1);
    expect(updated.out).toContain('could not check');
    expect(updated.out).toContain(VERSIONS_URL);
  });

  /** A machine ahead of the manifest is reported, never moved backwards. */
  it('reports a component newer than what is published rather than downgrading it', async () => {
    const updated = await run(['--no-node'], {
      files: {
        ...wholeMachine(),
        [packageAt('@softiesolutions/agentplex')]: manifest('2.0.0', {}),
      },
    });

    expect(updated.out).toContain('ahead of 1.5.0');
    expect(updated.journal.join('\n')).not.toContain('cli-v');
  });

  /**
   * The tripwire `install.sh` carries, asked of the machine this run would
   * leave behind: a hub moved across a server-leg change on its own is a hub
   * and a server that will connect and refuse each other at the handshake.
   */
  it('refuses to leave components that would not agree about a protocol leg', async () => {
    const updated = await run(['hub'], {
      served: {
        [VERSIONS_URL]: published({
          hub: { version: '1.3.0', protocol: { client: 3, server: 4 } },
        }),
      },
    });

    expect(updated.code).toBe(1);
    expect(updated.out).toContain('do not agree on the server protocol');
    expect(updated.out).toMatch(/^ {4}hub {6}server 4$/m);
    expect(updated.out).toMatch(/^ {4}server {3}server 3$/m);
    expect(spawned(updated.runner).join('\n')).not.toContain('npm');
  });

  /**
   * A client-only change releases the hub and the client together and leaves
   * the server where it is. Updating those two moves the client leg on both
   * and leaves the server leg agreeing, and the legs are never compared with
   * each other, so there is nothing to refuse.
   */
  it('updates the hub and its client across a client-leg change without the server', async () => {
    const clientMoved = { client: 4, server: 3 };
    const updated = await run(['hub', 'web', '--no-node'], {
      served: {
        [VERSIONS_URL]: published({
          hub: { version: '1.3.0', protocol: clientMoved },
          web: { version: '1.2.0', protocol: clientMoved },
        }),
      },
    });

    expect(updated.out).not.toContain('do not agree');
    const journal = updated.journal.join('\n');
    expect(journal).toContain('hub-v1.3.0');
    expect(journal).toContain('web-v1.2.0');
    expect(journal).not.toContain('server-v');
  });

  /** And the hub alone across that change is refused: its client would still be the old one. */
  it('refuses the hub alone across a client-leg change, naming its client', async () => {
    const updated = await run(['hub'], {
      served: {
        [VERSIONS_URL]: published({
          hub: { version: '1.3.0', protocol: { client: 4, server: 3 } },
        }),
      },
    });

    expect(updated.code).toBe(1);
    expect(updated.out).toContain('do not agree on the client protocol');
    expect(updated.out).toMatch(/^ {4}web {6}client 3$/m);
  });
});

describe('what was asked for', () => {
  it('updates only the component that was named', async () => {
    const updated = await run(['cli', '--no-node']);

    const downloads = updated.journal.filter((line) => line.startsWith('download '));
    expect(downloads).toEqual([`download ${CLI_TARBALL} -> ${WORK}/cli.tgz`]);
    const installs = spawned(updated.runner).filter((line) => line.includes(' install '));
    expect(installs).toEqual([npmInstall('agentplex')]);
  });

  /**
   * `setup` installs what is missing and `update` updates what is there. A
   * silent no-op would leave somebody believing this machine runs a server.
   */
  it('refuses a component that is not installed here', async () => {
    const files = wholeMachine();
    delete files[packageAt('@softiesolutions/agentplex-server')];

    const updated = await run(['server'], { files });

    expect(updated.code).toBe(2);
    expect(updated.errors).toContain('not installed here');
    expect(spawned(updated.runner).join('\n')).not.toContain('npm');
  });

  it('installs the exact release a pin names', async () => {
    const updated = await run(['hub@1.9.0', '--no-node']);

    expect(updated.journal).toContain(
      `download ${DOWNLOAD}/hub-v1.9.0/agentplex-hub.tgz -> ${WORK}/hub.tgz`,
    );
    expect(spawned(updated.runner)).toContain(npmInstall('agentplex-hub'));
  });

  /**
   * `install.sh`'s series, resolved by the same rule: the newest release the
   * manifest lists under it, compared as numbers and never a prerelease.
   */
  it('resolves a series to the newest release the manifest lists under it', async () => {
    const updated = await run(['hub@1.3', '--dry-run', '--no-node'], {
      served: { [VERSIONS_URL]: publishedWithHub('1.3.9', '1.3.10', '1.3.2', '1.3.11-rc1') },
    });

    expect(updated.code).toBe(0);
    expect(updated.out).toMatch(/^ {2}hub +1\.2\.0 +-> 1\.3\.10$/m);
    expect(updated.out).toContain(`${DOWNLOAD}/hub-v1.3.10/agentplex-hub.tgz`);
  });

  /**
   * A series nothing is published under stops the run before anything is
   * stopped, naming the component and the series -- where `install.sh` stops
   * too, and with its words.
   */
  it('refuses a series the manifest lists nothing under, and stops nothing', async () => {
    const updated = await run(['hub@1.3', '--no-node'], {
      served: { [VERSIONS_URL]: publishedWithHub('1.30.0') },
    });

    expect(updated.code).toBe(1);
    expect(updated.errors).toContain(`${VERSIONS_URL} offers no hub release under 1.3`);
    expect(updated.errors).toContain('hub@1.3');
    expect(updated.out).toBe('');
    expect(spawned(updated.runner).join('\n')).not.toContain('stop');
  });

  /**
   * Resolving a series is exactly what needed the file, so a run that could not
   * read it has no answer to give -- and says which file, rather than guessing.
   */
  it('refuses a series when the manifest could not be read, naming the source', async () => {
    const updated = await run(['hub@1.3', '--no-node'], {
      served: { [VERSIONS_URL]: 'not a manifest' },
    });

    expect(updated.code).toBe(1);
    expect(updated.errors).toContain('hub@1.3');
    expect(updated.errors).toContain(VERSIONS_URL);
    expect(updated.out).toBe('');
    expect(spawned(updated.runner).join('\n')).not.toContain('stop');
  });
});

describe('--check', () => {
  /**
   * One version-check mechanism rather than two: this is what the passive
   * notice's background refresh runs, and what `agentplex status` reads the
   * other end of.
   */
  it('writes the cache, reports what is available, and changes nothing', async () => {
    const checked = await run(['--check']);

    expect(checked.code).toBe(0);
    expect(checked.out).toContain('-> 1.5.0');
    expect(checked.machine.acts).toEqual([`mkdir ${HOME}/.cache/agentplex`, `write ${CACHE}`]);
    expect(spawned(checked.runner)).toEqual([]);
    // The runtime is not asked about, which is what keeps a background refresh
    // to one small fetch.
    expect(checked.network.requests).toEqual([VERSIONS_URL]);
  });

  /**
   * A `--system` machine runs this command as more than one identity, and a
   * cache one of them cannot write must cost that identity a notice rather than
   * the run.
   */
  it('says it could not cache rather than failing when the cache cannot be written', async () => {
    const checked = await run(['--check'], {
      unwritable: { [`${HOME}/.cache/agentplex`]: 'EACCES' },
    });

    expect(checked.code).toBe(0);
    expect(checked.out).toContain('not cached: ');
  });

  it('is refused together with --dry-run, because they are two questions', async () => {
    const refusedRun = await run(['--check', '--dry-run']);

    expect(refusedRun.code).toBe(2);
    expect(refusedRun.errors).toContain('two questions');
  });
});

describe('--dry-run', () => {
  it('prints the plan in order and starts nothing', async () => {
    const planned = await run(['--dry-run', '--node']);

    expect(planned.code).toBe(0);
    expect(planned.out).toContain('This run would, in this order:');
    expect(planned.out).toContain('replace v24.9.0 with v24.10.0');
    expect(planned.out).toContain('Nothing has been changed.');
    expect(spawned(planned.runner).join('\n')).not.toContain('npm');
    expect(spawned(planned.runner).join('\n')).not.toContain('tar');
    expect(planned.journal.join('\n')).not.toContain('download');
  });

  /**
   * What a real run does, described as that: a download, an unpack beside the
   * tree, an install against the shrinkwrap it carries and a move into place.
   * Not `npm install <url>`, which is a command this no longer runs and one
   * that would ignore the shrinkwrap if somebody copied it out of the plan.
   */
  it('describes the download, the unpack, the install and the move', async () => {
    const planned = await run(['--dry-run', '--no-node']);

    expect(planned.code).toBe(0);
    const server = tree('agentplex-server');
    expect(planned.out).toContain(`download ${SERVER_TARBALL}`);
    expect(planned.out).toContain(`unpack it into ${server}.new`);
    expect(planned.out).toContain('npm install --omit=dev there');
    expect(planned.out).toContain('npm-shrinkwrap.json');
    expect(planned.out).toContain(`move ${server}.new into place as ${server}`);
    expect(planned.out).toContain(`${PREFIX}/bin/agentplex`);
    expect(planned.out).toContain('staged together, so this machine gets the set or none of it');
    expect(planned.out).not.toMatch(/npm install https:/);
    // The server is described before the command, which goes last.
    expect(planned.out.indexOf(SERVER_TARBALL)).toBeLessThan(planned.out.indexOf(CLI_TARBALL));
  });
});

describe('the runtime', () => {
  /** The runtime's unpack, told apart from a package's. */
  const RUNTIME_UNPACK = `tar -xzf ${WORK}/node.tar.gz`;

  it('replaces it when the flag says so, and leaves it when the flag says not', async () => {
    const yes = await run(['--node']);
    const no = await run(['--no-node']);

    expect(spawned(yes.runner).join('\n')).toContain(RUNTIME_UNPACK);
    expect(spawned(no.runner).join('\n')).not.toContain(RUNTIME_UNPACK);
    expect(no.out).toContain('left alone (--no-node)');
  });

  it('asks when neither flag was given, and acts on the answer', async () => {
    const yes = await run([], { answer: 'yes' });
    const no = await run([], { answer: 'no' });

    expect(yes.machine.questions[0]).toContain('v24.9.0 with v24.10.0');
    expect(spawned(yes.runner).join('\n')).toContain(RUNTIME_UNPACK);
    expect(spawned(no.runner).join('\n')).not.toContain(RUNTIME_UNPACK);
  });

  /** Silence is not consent, and the line names the flag that answers in advance. */
  it('leaves the runtime alone when there is nobody to ask', async () => {
    const unattended = await run([]);

    expect(unattended.out).toContain('nobody to ask');
    expect(unattended.out).toContain('--node');
    expect(spawned(unattended.runner).join('\n')).not.toContain(RUNTIME_UNPACK);
    // The packages still move: a runtime nobody consented to is not a reason to
    // leave this machine on an old hub.
    expect(spawned(unattended.runner).join('\n')).toContain('npm install');
  });

  /** A Node this install did not unpack is somebody else's decision. */
  it('never touches a runtime the install adopted', async () => {
    const files = wholeMachine();
    delete files[`${PREFIX}/node/.agentplex-node-version`];

    const updated = await run(['--node'], { files });

    expect(updated.out).toContain("not this install's to replace");
    expect(updated.network.requests).not.toContain(SUMS);
  });

  it('keeps the runtime and says the question went unanswered when nodejs.org will not answer', async () => {
    const updated = await run(['--node'], { sums: null });

    expect(updated.out).toContain('whether a newer one exists is unknown');
    expect(spawned(updated.runner).join('\n')).not.toContain(RUNTIME_UNPACK);
  });

  /**
   * The one failure here worth an operator's attention on its own, and the one
   * that must never reach the disk: an archive that is not the one nodejs.org
   * published.
   */
  it('refuses an archive whose checksum does not match, and unpacks nothing', async () => {
    const updated = await run(['--node'], { hashes: {} });

    expect(updated.code).toBe(1);
    expect(updated.out).toContain('hashed to');
    expect(spawned(updated.runner).join('\n')).not.toContain(RUNTIME_UNPACK);
    // And the units it stopped are running again: what is on this disk is what
    // was running a moment ago.
    expect(spawned(updated.runner).join('\n')).toContain(`systemctl --user start ${HUB}`);
  });
});

describe('the runtime swap, when a move fails', () => {
  const STAMP = `${PREFIX}/node/.agentplex-node-version`;

  /** Every act on the runtime's directories, in order. */
  function runtimeActs(machine: FakeUpdateMachine): readonly string[] {
    return machine.acts.filter((act) => act.includes(`${PREFIX}/node`));
  }

  /**
   * The failure the old order could not recover from: the old runtime was
   * already deleted when the new one would not move in. Set aside instead, it
   * is moved back, and the units come back on exactly what they were running.
   */
  it('puts the old runtime back when the new one will not move into place', async () => {
    const updated = await run(['--node'], {
      refusedRenames: { [`${PREFIX}/node.new -> ${PREFIX}/node`]: 'EXDEV: cross-device link' },
    });

    expect(updated.code).toBe(1);
    expect(updated.out).toContain('EXDEV: cross-device link');
    expect(updated.out).toContain(`v24.9.0 put back in ${PREFIX}/node`);
    const acts = runtimeActs(updated.machine);
    expect(acts.at(-1)).toBe(`mv ${PREFIX}/node.old ${PREFIX}/node`);
    expect(acts).not.toContain(`rm ${PREFIX}/node`);
    expect(updated.machine.contents.get(STAMP)).toBe('v24.9.0\n');
    expect(spawned(updated.runner)).toContain(`systemctl --user start ${HUB} ${SERVER}`);
  });

  /**
   * An old runtime an earlier run left behind is cleared before the current
   * one is set aside, because a rename onto a directory with something in it
   * is refused.
   */
  it('clears an old runtime an earlier run left behind, then swaps', async () => {
    const updated = await run(['--node'], {
      files: { ...wholeMachine(), [`${PREFIX}/node.old/.agentplex-node-version`]: 'v24.8.0\n' },
    });

    expect(updated.code).toBe(0);
    expect(runtimeActs(updated.machine)[0]).toBe(`rm ${PREFIX}/node.old`);
    expect(updated.machine.contents.get(STAMP)).toBe('v24.10.0\n');
    expect(updated.machine.contents.has(`${PREFIX}/node.old/.agentplex-node-version`)).toBe(false);
  });

  /**
   * The one state this can still leave a machine in without a runtime: neither
   * the new one nor the old one would move into place. Said with the command
   * that fixes it, because until somebody runs it this install has no stamp
   * and reads its runtime as adopted, so no later update would put one back.
   */
  it('names both problems and the command that restores the runtime when neither will move', async () => {
    const updated = await run(['--node'], {
      unwritable: { [`${PREFIX}/node`]: 'EROFS: read-only file system' },
    });

    expect(updated.code).toBe(1);
    const acts = runtimeActs(updated.machine);
    expect(acts.slice(-2)).toEqual([
      `mv ${PREFIX}/node.new ${PREFIX}/node`,
      `mv ${PREFIX}/node.old ${PREFIX}/node`,
    ]);
    const setAside = acts.indexOf(`mv ${PREFIX}/node ${PREFIX}/node.old`);
    expect(setAside).toBeGreaterThan(-1);
    expect(acts.slice(setAside)).not.toContain(`rm ${PREFIX}/node.old`);
    expect(updated.out.match(/EROFS: read-only file system/g)).toHaveLength(2);
    expect(updated.out).toContain(`mv ${PREFIX}/node.old ${PREFIX}/node`);
    expect(updated.machine.contents.get(`${PREFIX}/node.old/.agentplex-node-version`)).toBe(
      'v24.9.0\n',
    );
  });

  /**
   * The new runtime is in place and stamped, so the run did what it was for.
   * The old one left behind costs a line, not the run, and the next run clears
   * it before it sets the current one aside.
   */
  it('succeeds and names the old runtime when it cannot be removed afterwards', async () => {
    const updated = await run(['--node'], {
      unremovable: { [`${PREFIX}/node.old`]: 'EBUSY: resource busy' },
    });

    expect(updated.code).toBe(0);
    expect(updated.machine.contents.get(STAMP)).toBe('v24.10.0\n');
    expect(updated.out).toContain(`${PREFIX}/node.old`);
    expect(updated.out).toContain('EBUSY: resource busy');
    expect(updated.out).toContain('the next run removes it');
  });
});

describe('the preflight', () => {
  /**
   * Asked before anything is stopped. The same machine met after the daemons
   * are down is an operator reading node-gyp's output with their services off.
   */
  it('refuses a server machine with no compiler, with nothing stopped', async () => {
    const blocked = await run(['--no-node'], { toolchain: false });

    expect(blocked.code).toBe(1);
    expect(blocked.out).toContain('npm compiles node-pty');
    expect(blocked.out).toContain('Nothing has been stopped or replaced');
    expect(spawned(blocked.runner).join('\n')).not.toContain('stop');
  });

  it('asks for no compiler on a machine with no server package', async () => {
    const files = wholeMachine();
    delete files[packageAt('@softiesolutions/agentplex-server')];

    const hub = await run(['--no-node'], { files, toolchain: false, units: [HUB] });

    expect(hub.out).toContain('no package on this machine carries node-pty');
    expect(hub.code).toBe(0);
  });
});

describe('when something fails part way', () => {
  /**
   * A refused install costs its staging and nothing else: no tree has moved,
   * so the units come back on exactly what they were running, and the line
   * that says why is npm's own.
   */
  it('starts the units again when npm refuses, and says what npm said', async () => {
    const failed = await run(['--no-node'], {
      outcomes: {
        [npmInstall('agentplex-server')]: refused(1, 'npm error\ngyp ERR! build error'),
      },
    });

    expect(failed.code).toBe(1);
    expect(failed.out).toContain('gyp ERR! build error');
    const acts = failed.machine.acts;
    expect(acts.filter((act) => act.startsWith('mv '))).toEqual([]);
    expect(acts.at(-2)).toBe(`rm ${tree('agentplex-server')}.new`);
    // The command's own package was never staged: the set before it failed.
    expect(failed.journal.join('\n')).not.toContain(CLI_TARBALL);
    expect(acts.join('\n')).not.toContain(`${tree('agentplex')}.new`);
    expect(spawned(failed.runner)).toContain(`systemctl --user start ${HUB} ${SERVER}`);
  });

  /** Every package of a set, including the ones that had already installed. */
  it('removes every staged package of the set when one of them is refused', async () => {
    const clientMoved = { client: 4, server: 3 };
    const failed = await run(['hub', 'web', '--no-node'], {
      served: {
        [VERSIONS_URL]: published({
          hub: { version: '1.3.0', protocol: clientMoved },
          web: { version: '1.2.0', protocol: clientMoved },
        }),
      },
      outcomes: { [npmInstall('agentplex-web')]: refused(1, 'npm error code ETARGET') },
    });

    expect(failed.code).toBe(1);
    expect(failed.out).toContain('npm error code ETARGET');
    const acts = failed.machine.acts;
    expect(acts.filter((act) => act.startsWith('mv '))).toEqual([]);
    expect(acts).toContain(`rm ${tree('agentplex-hub')}.new`);
    expect(acts.lastIndexOf(`rm ${tree('agentplex-hub')}.new`)).toBeGreaterThan(
      acts.indexOf(`mkdir ${tree('agentplex-web')}.new`),
    );
    expect(acts.lastIndexOf(`rm ${tree('agentplex-web')}.new`)).toBeGreaterThan(
      acts.indexOf(`mkdir ${tree('agentplex-web')}.new`),
    );
  });

  /**
   * A download that fails costs the fetch. Nothing has been unpacked, so
   * there is nothing to take back, and the line names the URL that failed.
   */
  it('names the URL that would not download and stages nothing', async () => {
    const failed = await run(['--no-node'], { downloadable: [NODE_ARCHIVE] });

    expect(failed.code).toBe(1);
    expect(failed.out).toContain(SERVER_TARBALL);
    expect(spawned(failed.runner).join('\n')).not.toContain('tar -xzf');
    expect(spawned(failed.runner).join('\n')).not.toContain(' install ');
    expect(failed.machine.acts.join('\n')).not.toContain('.new');
    expect(spawned(failed.runner)).toContain(`systemctl --user start ${HUB} ${SERVER}`);
  });

  /**
   * An archive that will not unpack is refused before npm is asked anything,
   * and the staging directory it was going into is taken back.
   */
  it('takes back the staging directory when the archive will not unpack', async () => {
    const failed = await run(['--no-node'], {
      outcomes: {
        [unpack('server', 'agentplex-server')]: refused(2, 'gzip: stdin: not in gzip format'),
      },
    });

    expect(failed.code).toBe(1);
    expect(failed.out).toContain('not in gzip format');
    expect(spawned(failed.runner).join('\n')).not.toContain(' install ');
    expect(failed.machine.acts.at(-2)).toBe(`rm ${tree('agentplex-server')}.new`);
  });

  /**
   * The move is two renames per package, and the second failing is undone by
   * a third: the tree that was set aside goes back, so the units restart on
   * what they ran before.
   */
  it('puts a tree back when its new one will not move into place', async () => {
    const server = tree('agentplex-server');
    const failed = await run(['--no-node'], {
      refusedRenames: { [`${server}.new -> ${server}`]: 'EXDEV: cross-device link' },
    });

    expect(failed.code).toBe(1);
    expect(failed.out).toContain('EXDEV: cross-device link');
    const acts = failed.machine.acts;
    expect(acts).toContain(`mv ${server}.old ${server}`);
    expect(
      acts.indexOf(`rm ${server}.new`, acts.indexOf(`mv ${server}.old ${server}`)),
    ).toBeGreaterThan(-1);
    expect(failed.machine.contents.has(`${server}/package.json`)).toBe(true);
    expect(failed.journal.join('\n')).not.toContain(CLI_TARBALL);
  });

  /**
   * A run killed between the two renames leaves a package under a name
   * nothing starts, and no tree where the units look. It goes back before
   * anything is staged, which is also what stops the swap's first step --
   * clearing an old tree -- from removing the only copy there is.
   */
  it('puts back a package an interrupted run set aside, before it stages anything', async () => {
    const files = wholeMachine();
    const hub = tree('agentplex-hub');
    files[`${hub}.old/package.json`] = files[`${hub}/package.json`] ?? '';
    delete files[`${hub}/package.json`];

    const updated = await run(['--no-node'], { files });

    expect(updated.code).toBe(0);
    expect(updated.out).toContain(`restored ${hub}`);
    const acts = updated.machine.acts;
    expect(acts.indexOf(`mv ${hub}.old ${hub}`)).toBeLessThan(
      acts.indexOf(`mkdir ${tree('agentplex-server')}.new`),
    );
    expect(updated.machine.contents.has(`${hub}/package.json`)).toBe(true);
  });

  it('refuses, having stopped nothing, when npm cannot say where its global config is', async () => {
    const failed = await run(['--no-node'], {
      outcomes: { [ASK_GLOBALCONFIG]: refused(1, 'npm error could not read config') },
    });

    expect(failed.code).toBe(1);
    expect(failed.out).toContain('npm error could not read config');
    expect(spawned(failed.runner).join('\n')).not.toContain('stop');
  });

  it('refuses when there is no npm at all, having changed nothing', async () => {
    const failed = await run(['--no-node'], { npm: false });

    expect(failed.code).toBe(1);
    expect(failed.out).toContain('there is no npm here');
    expect(spawned(failed.runner).join('\n')).not.toContain('stop');
  });
});

describe('what update refuses to do', () => {
  it('refuses a prefix that is not an agentplex install, on stderr', async () => {
    const updated = await run(['--prefix', '/srv/nothing'], { files: {} });

    expect(updated.code).toBe(2);
    expect(updated.errors).toContain('/srv/nothing/agentplex.env');
  });

  /** The whole grammar of a pin, refused at the flag rather than at a 404. */
  it('refuses a word that is neither a release nor a series, before reading anything', async () => {
    const updated = await run(['hub@latest']);

    expect(updated.code).toBe(2);
    expect(updated.errors).toContain('<major>.<minor> or <major>');
    expect(updated.network.requests).toEqual([]);
  });
});
