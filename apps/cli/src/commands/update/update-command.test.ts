import { describe, expect, it } from 'vitest';
import type { ProgramResolver } from '@agentplex/providers';
import {
  createFakeProcessRunner,
  printed,
  refused,
  type FakeProcessRunner,
} from '@agentplex/providers/testing';
import { createSystemd } from '../../installation/systemd.js';
import { VERSIONS_URL } from '../../versions/version-check.js';
import { NODE_DIST_URL } from './runtime.js';
import { createFakeNetwork, createFakeUpdateMachine } from './fake-update-machine.js';
import type { FakeNetwork, FakeUpdateMachine } from './fake-update-machine.js';
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
 * **The ordering assertions all read one list.** `runner.requests` is every
 * child this run would have started, in order, from `systemctl` through `tar`
 * to `npm` -- so "the runtime moved before the packages", "the command's own
 * package went last" and "only the units that were running came back" are
 * assertions about the sequence of argv that a real run would have produced.
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

function manifest(version: string, protocol: number | null): string {
  return JSON.stringify(protocol === null ? { version } : { version, agentplex: { protocol } });
}

function packageAt(name: string): string {
  return `${PREFIX}/lib/node_modules/${name}/package.json`;
}

/** A `both` machine with all four packages, a stamped runtime and two units. */
function wholeMachine(): Record<string, string> {
  return {
    [`${PREFIX}/agentplex.env`]: `AGENTPLEX_ROLE=both\nAGENTPLEX_PREFIX=${PREFIX}\n`,
    [packageAt('@softiesolutions/agentplex')]: manifest('1.4.0', 3),
    [packageAt('@softiesolutions/agentplex-hub')]: manifest('1.2.0', 3),
    [packageAt('@softiesolutions/agentplex-server')]: manifest('1.4.0', 3),
    [packageAt('@softiesolutions/agentplex-web')]: manifest('1.1.0', 3),
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

/** What the release branch is serving, in the shape a release writes. */
function published(
  entries: Readonly<Record<string, { version: string; protocol: number }>> = {},
): string {
  return JSON.stringify({
    cli: { version: '1.5.0', protocol: 3 },
    hub: { version: '1.2.0', protocol: 3 },
    server: { version: '1.5.0', protocol: 3 },
    web: { version: '1.1.0', protocol: 3 },
    ...entries,
  });
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
}

async function run(argv: readonly string[] = [], world: World = {}): Promise<Run> {
  const out: string[] = [];
  const errors: string[] = [];
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
    ...(world.outcomes ?? {}),
  };

  const runner = createFakeProcessRunner({ outcomes, fallback: printed('') });
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
  });

  const network = createFakeNetwork({
    served: {
      [VERSIONS_URL]: published(),
      ...(world.sums === null ? {} : { [SUMS]: world.sums ?? CHECKSUMS }),
      ...(world.served ?? {}),
    },
    downloadable: world.downloadable ?? [NODE_ARCHIVE],
  });

  const code = await runUpdateCommand(argv, {
    home: HOME,
    machine,
    systemd: createSystemd({ runner, programs }),
    runner,
    programs,
    reader: network,
    downloader: network,
    source: { kind: 'url', url: VERSIONS_URL },
    cacheFile: world.cacheFile === undefined ? CACHE : world.cacheFile,
    now: () => NOW,
    platform: 'linux',
    architecture: 'x64',
    write: (line) => out.push(line),
    writeError: (line) => errors.push(line),
  });

  return { code, out: out.join('\n'), errors: errors.join('\n'), runner, machine, network };
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
    const acts = spawned(updated.runner).filter(
      (line) => !line.includes('show') && !line.includes('daemon-reload'),
    );
    expect(acts).toEqual([
      `systemctl --user stop ${HUB} ${SERVER}`,
      `tar -xzf /tmp/agentplex-update/node.tar.gz -C ${PREFIX}/node.new --strip-components=1 --no-same-owner`,
      `${OWNED_NPM} install --global --prefix ${PREFIX} --ignore-scripts=false ` +
        `${DOWNLOAD}/server-v1.5.0/agentplex-server.tgz`,
      `${OWNED_NPM} install --global --prefix ${PREFIX} --ignore-scripts=false ` +
        `${DOWNLOAD}/cli-v1.5.0/agentplex.tgz`,
      `systemctl --user start ${HUB} ${SERVER}`,
    ]);
  });

  /**
   * The runtime is replaced by unpacking beside the old one and renaming, so
   * that the moment this machine has no interpreter is one syscall long -- and
   * the stamp goes in before the move, so the directory that arrives is either
   * a complete runtime with its record or is not there at all.
   */
  it('leaves the prefix with a stamped runtime, moved into place rather than over', async () => {
    const updated = await run(['--node']);

    expect(updated.machine.acts.filter((act) => act.includes(`${PREFIX}/node`))).toEqual([
      // Cleared first, because a staging directory left by an earlier failed
      // run is what would otherwise be unpacked over.
      `rm ${PREFIX}/node.new`,
      `mkdir ${PREFIX}/node.new`,
      `write ${PREFIX}/node.new/.agentplex-node-version`,
      `rm ${PREFIX}/node`,
      `mv ${PREFIX}/node.new ${PREFIX}/node`,
    ]);
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
        [packageAt('@softiesolutions/agentplex')]: manifest('1.5.0', 3),
        [packageAt('@softiesolutions/agentplex-server')]: manifest('1.5.0', 3),
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
        [packageAt('@softiesolutions/agentplex')]: manifest('2.0.0', 3),
      },
    });

    expect(updated.out).toContain('ahead of 1.5.0');
    expect(spawned(updated.runner).join('\n')).not.toContain('cli-v');
  });

  /**
   * The tripwire `install.sh` carries, asked of the machine this run would
   * leave behind: a hub moved across a protocol change on its own is a hub and
   * a server that will connect and refuse each other's frames.
   */
  it('refuses to leave components that would not agree about the protocol', async () => {
    const updated = await run(['hub'], {
      served: { [VERSIONS_URL]: published({ hub: { version: '1.3.0', protocol: 4 } }) },
    });

    expect(updated.code).toBe(1);
    expect(updated.out).toContain('do not agree');
    expect(spawned(updated.runner).join('\n')).not.toContain('npm');
  });
});

describe('what was asked for', () => {
  it('updates only the component that was named', async () => {
    const updated = await run(['cli', '--no-node']);

    const npm = spawned(updated.runner).filter((line) => line.includes('npm'));
    expect(npm).toHaveLength(1);
    expect(npm[0]).toContain('cli-v1.5.0');
    expect(npm[0]).not.toContain('server-v');
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

    expect(spawned(updated.runner).join('\n')).toContain(
      `${DOWNLOAD}/hub-v1.9.0/agentplex-hub.tgz`,
    );
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
  });
});

describe('the runtime', () => {
  it('replaces it when the flag says so, and leaves it when the flag says not', async () => {
    const yes = await run(['--node']);
    const no = await run(['--no-node']);

    expect(spawned(yes.runner).join('\n')).toContain('tar -xzf');
    expect(spawned(no.runner).join('\n')).not.toContain('tar -xzf');
    expect(no.out).toContain('left alone (--no-node)');
  });

  it('asks when neither flag was given, and acts on the answer', async () => {
    const yes = await run([], { answer: 'yes' });
    const no = await run([], { answer: 'no' });

    expect(yes.machine.questions[0]).toContain('v24.9.0 with v24.10.0');
    expect(spawned(yes.runner).join('\n')).toContain('tar -xzf');
    expect(spawned(no.runner).join('\n')).not.toContain('tar -xzf');
  });

  /** Silence is not consent, and the line names the flag that answers in advance. */
  it('leaves the runtime alone when there is nobody to ask', async () => {
    const unattended = await run([]);

    expect(unattended.out).toContain('nobody to ask');
    expect(unattended.out).toContain('--node');
    expect(spawned(unattended.runner).join('\n')).not.toContain('tar -xzf');
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
    expect(spawned(updated.runner).join('\n')).not.toContain('tar -xzf');
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
    expect(spawned(updated.runner).join('\n')).not.toContain('tar -xzf');
    // And the units it stopped are running again: what is on this disk is what
    // was running a moment ago.
    expect(spawned(updated.runner).join('\n')).toContain(`systemctl --user start ${HUB}`);
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
  it('starts the units again when npm refuses, and says what npm said', async () => {
    const failed = await run(['--no-node'], {
      outcomes: {
        [`${OWNED_NPM} install --global --prefix ${PREFIX} --ignore-scripts=false ` +
        `${DOWNLOAD}/server-v1.5.0/agentplex-server.tgz`]: refused(1, 'gyp ERR! build error'),
      },
    });

    expect(failed.code).toBe(1);
    expect(failed.out).toContain('gyp ERR! build error');
    expect(spawned(failed.runner).join('\n')).toContain(`systemctl --user start ${HUB}`);
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
  it('refuses a partial pin, naming the shape it takes', async () => {
    const updated = await run(['hub@1.3']);

    expect(updated.code).toBe(2);
    expect(updated.errors).toContain('1.3.0 rather than 1.3');
    expect(updated.network.requests).toEqual([]);
  });
});
