import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HUB, metadataAsset, PACKAGES } from './assemble-package.js';

/**
 * `install.sh`, exercised the two ways it can be exercised without a machine to
 * throw away: `--dry-run`, which resolves every decision and performs none, and
 * `--print-unit`, which renders the systemd unit from those decisions.
 *
 * The rest -- downloading a runtime, installing a toolchain, creating a service
 * account -- is checked in the `bootstrap-check` Docker stage, on a stock
 * `debian:bookworm-slim`, because those steps are only true against a machine
 * that has none of them.
 *
 * Every run here goes through `nobody` when the suite itself is root, which it
 * is in the check container. That is not tidiness: the first rule this script
 * enforces is that it will not install as root, so a suite running as root
 * could otherwise only ever test the refusal.
 */

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = join(scriptsDirectory, '..');
const scriptPath = join(scriptsDirectory, 'install.sh');
// The script lives here and the page that tells people to fetch it lives with
// the package it installs, so the two are a directory apart rather than
// siblings. The assertions below are what keeps them saying the same thing.
const documentation = join(workspaceRoot, 'apps', 'cli', 'README.md');
const rootManifest = join(workspaceRoot, 'package.json');
const releaseWorkflow = join(workspaceRoot, '.github', 'workflows', 'release.yml');

/**
 * Only `engines`. The rest of the root manifest is somebody else's to change --
 * the package is being renamed on another branch -- and a schema that read more
 * than the one field this tie is about would fail on edits that have nothing to
 * do with the Node major.
 */
const enginesSchema = z.object({ engines: z.object({ node: z.string() }) });

const suiteIsRoot = process.getuid?.() === 0;

interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunOptions {
  /** Extra environment for the script, on top of HOME and PATH. */
  readonly environment?: Record<string, string>;
  /** Run as root even when an unprivileged run is available. */
  readonly asRoot?: boolean;
  /**
   * Feed the script to bash on stdin -- `bash -s --` rather than a path, which
   * is exactly the shape `curl -fsSL ... | bash -s -- --role=server` produces.
   */
  readonly piped?: boolean;
}

const temporaries: string[] = [];

afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true });
});

/**
 * A scratch machine: a copy of the script somewhere world-readable, a home
 * directory to install into, and the metadata half of a release to resolve
 * against.
 *
 * The copy is not caution about mutation -- nothing here writes to the script.
 * A checkout can live under a mode-0700 home, and `nobody` cannot read a script
 * it cannot traverse to.
 *
 * The versions directory is outside the home on purpose: several tests assert
 * that a run which was told to change nothing left the home empty, and a
 * fixture inside it would make every one of those assertions about the fixture.
 *
 * The stem is a parameter because the default one is a clock. `mkdtempSync`
 * derives its suffix from the time rather than from randomness, so which
 * directory a run gets is a fact about when it ran -- and a test that needs a
 * particular name states it here instead of waiting for the clock to produce
 * one. Six characters are still appended, so a stated name is as unique as the
 * default.
 */
function scratch(named = 'agentplex-install-'): {
  readonly script: string;
  readonly home: string;
  readonly versions: string;
} {
  const root = mkdtempSync(join(tmpdir(), named));
  temporaries.push(root);
  const script = join(root, 'install.sh');
  const home = join(root, 'home');
  const versions = join(root, 'versions');
  cpSync(scriptPath, script);
  mkdirSync(home);
  mkdirSync(versions);
  writeVersions(versions, CURRENT);
  chmodSync(root, 0o777);
  chmodSync(script, 0o755);
  chmodSync(home, 0o777);
  chmodSync(versions, 0o777);
  return { script, home, versions };
}

/**
 * What `versions.json` says is current, as a fixture.
 *
 * Four versions that differ from each other, because the failure worth catching
 * is a component resolved through another component's entry, and four equal
 * numbers would hide every one of those. The protocol is a number with no
 * meaning here beyond "they agree": this script never compares it with
 * `PROTOCOL_VERSION`, it only asks whether the components a machine installs
 * say the same thing.
 */
const CURRENT: Readonly<Record<string, string>> = {
  cli: '1.4.0',
  hub: '1.2.0',
  server: '1.5.0',
  web: '1.1.0',
};

const FIXTURE_PROTOCOL = 3;

/** The manifest the release publishes on the `v1` branch, as a fixture. */
function writeVersions(
  directory: string,
  versions: Readonly<Record<string, string>>,
  protocols: Readonly<Record<string, number>> = {},
): void {
  const entries = Object.entries(versions).map(([component, version]) => [
    component,
    { version, protocol: protocols[component] ?? FIXTURE_PROTOCOL },
  ]);
  writeFile(join(directory, 'versions.json'), JSON.stringify(Object.fromEntries(entries), null, 2));
}

/**
 * The metadata published beside one release's tarball, as a fixture, at the
 * path a release publishes it at: a directory per tag, holding the asset under
 * the name the assembler gave it.
 */
function writeReleaseMetadata(
  directory: string,
  component: string,
  version: string,
  protocol = FIXTURE_PROTOCOL,
): void {
  writeFile(
    releaseMetadataPath(directory, component, version),
    JSON.stringify({ component, version, protocol }),
  );
}

function releaseMetadataPath(directory: string, component: string, version: string): string {
  const target = PACKAGES.find((candidate) => candidate.component === component);
  if (target === undefined) throw new Error(`no package assembles ${component}`);
  const tag = join(directory, `${component}-v${version}`);
  mkdirSync(tag, { recursive: true });
  chmodSync(tag, 0o777);
  return join(tag, metadataAsset(target));
}

/** A fixture the script reads as `nobody`, so the mode is part of writing it. */
function writeFile(path: string, contents: string): void {
  writeFileSync(path, `${contents}\n`);
  chmodSync(path, 0o666);
}

/**
 * A fixture tree whoever the script runs as can write to, which where the suite
 * is root is not the user that made it. Only a test that removes for real needs
 * this: every other one reads a plan.
 */
function openToEveryone(directory: string): void {
  chmodSync(directory, 0o777);
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    chmodSync(join(entry.parentPath, entry.name), entry.isDirectory() ? 0o777 : 0o666);
  }
}

function run(
  script: string,
  home: string,
  args: readonly string[],
  options: RunOptions = {},
): RunResult {
  const environment = {
    HOME: home,
    // Passed through rather than inherited from `su`, which resets it: whether
    // this machine's node is found decides a line of the plan, and a test that
    // reads differently under `su` is a test about `su`.
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    // The metadata half of a release, off a disk. Nothing in a suite may reach
    // the network, and what is current is a fact this script reads off one --
    // so every run here is pointed at the fixture `scratch` wrote beside the
    // script, and a test that wants the no-seam behaviour passes an empty
    // string, which the script reads as unset.
    AGENTPLEX_VERSIONS: join(dirname(script), 'versions'),
    ...options.environment,
  };

  const command = [
    'env',
    ...Object.entries(environment).map(([name, value]) => `${name}=${quote(value)}`),
    'bash',
    ...(options.piped === true ? ['-s', '--'] : [quote(script)]),
    ...args.map(quote),
  ].join(' ');
  const input = options.piped === true ? readFileSync(script, 'utf8') : undefined;

  const unprivileged = suiteIsRoot && options.asRoot !== true;
  const result = unprivileged
    ? spawnSync('su', ['nobody', '-s', '/bin/bash', '-c', command], { encoding: 'utf8', input })
    : spawnSync('bash', ['-c', command], { encoding: 'utf8', input });

  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The value of one line of the plan, or `undefined` when it printed none. */
function planned(stdout: string, key: string): string | undefined {
  const line = stdout.split('\n').find((candidate) => candidate.startsWith(`${key} `));
  return line?.slice(key.length).trim();
}

/** What the `package` step will hand npm, and where it will put the result. */
interface PackagePlan {
  /**
   * The argv npm is given: one tarball spec per component, or -- where nothing
   * has been resolved yet -- the components and the root their tags hang under.
   */
  readonly source: string;
  /** The prefix it installs into, which under this suite is a scratch path. */
  readonly destination: string;
}

/**
 * The `package` line of the plan, split at its destination.
 *
 * Read this rather than the rendered line whenever the assertion is about what
 * npm is handed, because the rendered line also names the scratch prefix and a
 * scratch prefix is this suite's own invention rather than the script's answer.
 *
 * That distinction was not free. `mkdtempSync` derives its suffix from the
 * clock and not from randomness, so `agentplex-install-vJKSyf` and
 * `agentplex-install-vI0etU` are both names it really produced; a prefix under
 * either one renders `-v` into this line, and the assertion below that greps
 * for `-v` to prove no release tag was invented used to read the path instead.
 * It failed twice in six container runs, always looking like a regression in
 * argument handling and never being one.
 *
 * The needle is the part that varies. `-f`, `-y` and every other single-letter
 * flag an installer test might want to look for sit in the same trap, so the
 * fix is not a safer alphabet for the directory name -- it is to stop the
 * directory name reaching an assertion that was never about it.
 */
function packagePlan(stdout: string): PackagePlan {
  const line = planned(stdout, 'package');
  if (line === undefined) throw new Error('the plan named no package step');
  const at = line.lastIndexOf(DESTINATION);
  if (at === -1) throw new Error(`a package step with no destination: ${line}`);
  return { source: line.slice(0, at), destination: line.slice(at + DESTINATION.length) };
}

/** What the script prints between the packages and the prefix they land in. */
const DESTINATION = ' into ';

/** A literal path, as a fragment of a regular expression. */
function escaped(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/**
 * The compiled entry a unit's ExecStart names, for one daemon under one prefix.
 *
 * There is no `agentplex hub` any more, so a unit cannot start a daemon by
 * naming a command: it names the interpreter and this file. The path is the
 * workspace's inside the directory npm wrote, which is the same layout a
 * checkout, the image and the tarball all keep -- so this expression is the
 * whole of what packaging has to preserve for a unit to work.
 *
 * The directory is the daemon's *own* package. Each daemon is published
 * separately, so a hub machine has no server package to point into and a server
 * machine has no hub package -- naming the command's package here, as this did
 * while there was one, would be an ExecStart at a path that does not exist on
 * the machine the split was for.
 */
function daemonEntry(prefix: string, daemon: string): string {
  return `${prefix}/lib/node_modules/@softiesolutions/agentplex-${daemon}/apps/${daemon}/dist/main.js`;
}

/**
 * The components a role installs, in the order the script builds them.
 *
 * The command is in every row because `setup` and `doctor` belong on every
 * machine; the client is in every row a hub is in, because a hub without it
 * serves 503.
 */
function roleComponents(role: string): readonly string[] {
  if (role === 'hub') return ['cli', 'hub', 'web'];
  if (role === 'server') return ['cli', 'server'];
  return ['cli', 'hub', 'web', 'server'];
}

/**
 * One published tarball's URL.
 *
 * Written out here rather than read from the script, because this is the one
 * string a machine actually fetches and a test that derived it from the script
 * would agree with whatever the script happened to say. The asset names are
 * held against the assembler's own table separately, further down.
 */
function releaseUrl(component: string, version: string): string {
  const asset = component === 'cli' ? 'agentplex' : `agentplex-${component}`;
  return (
    `https://github.com/SoftieSolutions/agentplex/releases/download/` +
    `${component}-v${version}/${asset}.tgz`
  );
}

/** The URLs a role hands npm, in the order the script builds them. */
function packageSpecs(role: string, versions: Readonly<Record<string, string>> = CURRENT): string {
  return roleComponents(role)
    .map((component) => releaseUrl(component, versions[component] ?? ''))
    .join(' ');
}

/**
 * The ExecStart lines of a rendered unit, split into the interpreter and the
 * script.
 *
 * The interpreter is returned rather than asserted against a literal on
 * purpose. Which node the script settles on is the machine's answer -- one
 * already on PATH, or the one it unpacked into the prefix -- so writing a path
 * here would make these tests about the machine the suite runs on. What every
 * caller does assert is that it ends in `/node`: naming the interpreter rather
 * than leaving a `#!/usr/bin/env node` line to find one is the change, and an
 * ExecStart that had drifted back to a bare command word would fail this parse
 * rather than pass a weaker assertion.
 */
function execStarts(unit: string): readonly { interpreter: string; script: string }[] {
  return unit
    .split('\n')
    .filter((line) => line.startsWith('ExecStart='))
    .map((line) => {
      const match = /^ExecStart=(\S+) (\S+)$/.exec(line);
      if (match === null) throw new Error(`not an interpreter and a script: ${line}`);
      expect(match[1]).toMatch(/\/node$/);
      return { interpreter: match[1] ?? '', script: match[2] ?? '' };
    });
}

/** Every line of the plan the unit step printed. */
function unitLines(stdout: string): readonly string[] {
  return stdout.split('\n').filter((line) => line.startsWith('unit '));
}

/**
 * The script written back out with its last line dropped, so it can be sourced
 * for its functions instead of run for its effects.
 *
 * `main "$@"` being the last line is exactly what makes dropping it enough to
 * load the rest, and every driver below is built on that.
 */
function sourceableLibrary(script: string): string {
  const library = `${script}.lib`;
  writeFileSync(library, readFileSync(script, 'utf8').replace(/main "\$@"\s*$/, ''));
  chmodSync(library, 0o644);
  return library;
}

/**
 * A machine the script can be told it is running on.
 *
 * The installer draws three of them and not two, which is the whole point: a
 * Mac is not a Linux box missing systemctl, so it gets its own answer in both
 * of the places the platform is asked about -- the unit it cannot write, and
 * the compiler it does not need.
 */
interface Host {
  /** What `uname -s` answers on it. */
  readonly kernel: string;
  /** What `uname -m` answers on it. */
  readonly architecture: string;
  /** Whether `systemctl` is on its PATH. */
  readonly systemctl: boolean;
}

const LINUX_WITH_SYSTEMD: Host = { kernel: 'Linux', architecture: 'x86_64', systemctl: true };
const LINUX_WITHOUT_SYSTEMD: Host = { kernel: 'Linux', architecture: 'x86_64', systemctl: false };
const MACOS: Host = { kernel: 'Darwin', architecture: 'arm64', systemctl: false };

/**
 * A whole run, on a stated machine rather than on whoever is running the suite.
 *
 * This is the seam, and it is the shell's own: a function shadows a command for
 * every caller in the process, so declaring `uname` here is enough for the
 * script's real `detect_platform` to parse a stated kernel. Nothing about the
 * installer changes -- it still runs `uname -s`, still maps the answer itself,
 * and still dies on one it does not know -- which is why the two tests that
 * assert on its parsing below can exist at all. An environment variable that
 * set `PLATFORM` directly would have skipped exactly that code, and would have
 * left a real operator a way to lie to their own installer.
 *
 * `have systemctl` is the other machine fact, and the only one taken out of the
 * host's hands: every other `have` is still asked of the machine, because which
 * node this run adopts and whether a compiler is already here are answers a
 * suite has no business inventing.
 *
 * Anything not stated is still the real resolvers' to answer, which is the same
 * bargain the summary drivers strike further down.
 */
function runOn(script: string, home: string, host: Host, args: readonly string[]): RunResult {
  const library = sourceableLibrary(script);

  const driver = `${script}.host`;
  writeFileSync(
    driver,
    [
      `source ${quote(library)}`,
      `uname() {`,
      `  case "$1" in`,
      `    -s) printf '%s\\n' ${quote(host.kernel)} ;;`,
      `    -m) printf '%s\\n' ${quote(host.architecture)} ;;`,
      `    *) command uname "$@" ;;`,
      `  esac`,
      `}`,
      `have() {`,
      `  [ "$1" = 'systemctl' ] && return ${host.systemctl ? 0 : 1}`,
      `  command -v "$1" >/dev/null 2>&1`,
      `}`,
      `main "$@"`,
      '',
    ].join('\n'),
  );
  chmodSync(driver, 0o755);

  return run(driver, home, args);
}

/**
 * `summary` alone, on a machine that wrote no unit.
 *
 * The instruction block is the last thing a real install prints, and a dry run
 * deliberately prints `dry run: nothing above was done.` in its place -- so the
 * only way to read that block without an install to throw away is to load the
 * script's functions and call the one under test. `main "$@"` being the last
 * line is exactly what makes dropping it enough to load the rest.
 *
 * Everything but the one machine fact comes from the real resolvers. That fact
 * is forced, because a suite that only asked this where systemctl is missing
 * would never ask it on the machines most of these runs happen on.
 */
function summaryWithNoUnitWritten(reason: string): {
  readonly home: string;
  readonly result: RunResult;
} {
  const { script, home } = scratch();

  const library = sourceableLibrary(script);

  const driver = `${script}.summary`;
  writeFileSync(
    driver,
    [
      `source ${quote(library)}`,
      'parse_arguments --role=server',
      'resolve_layout',
      'detect_platform',
      `UNIT_SKIP_REASON=${quote(reason)}`,
      `DRY_RUN='no'`,
      'summary',
      '',
    ].join('\n'),
  );
  chmodSync(driver, 0o755);

  return { home, result: run(driver, home, []) };
}

/**
 * The summary on a machine that *did* get its units, which is the other half of
 * the same function and the half nothing reached before.
 *
 * The same `source` trick: the script with `main` removed, driven by a file
 * that sets up the state the summary reads and calls it. Reaching it through a
 * real install would mean a download and a compile for four lines of output.
 *
 * The unit files are made by hand, because `summary` names a daemon only when
 * its file is there -- the same "act only on what exists" rule the commands it
 * now points at follow.
 */
function summaryWithUnits(role: string): { readonly home: string; readonly result: RunResult } {
  const { script, home } = scratch();

  const units = join(home, '.config', 'systemd', 'user');
  mkdirSync(units, { recursive: true });
  for (const daemon of role === 'both' ? ['hub', 'server'] : [role]) {
    writeFileSync(join(units, `agentplex-${daemon}.service`), '');
  }

  const library = sourceableLibrary(script);

  const driver = `${script}.summary`;
  writeFileSync(
    driver,
    [
      `source ${quote(library)}`,
      `parse_arguments --role=${role}`,
      'resolve_layout',
      'detect_platform',
      `UNIT_SKIP_REASON=''`,
      `DRY_RUN='no'`,
      'summary',
      '',
    ].join('\n'),
  );
  chmodSync(driver, 0o755);

  return { home, result: run(driver, home, []) };
}

/**
 * `write_environment_file` alone, with the file it wrote read back.
 *
 * A dry run reports the settings file it would create and creates none, and the
 * contents are the point here: the installer records what it decided so that a
 * setup run later can be given the same prefix instead of guessing the default.
 * Loading the script's functions and calling the one under test is the same
 * trick the summary uses, and for the same reason.
 */
function environmentFileWritten(options: (home: string) => readonly string[]): {
  readonly home: string;
  readonly result: RunResult;
  readonly contents: (path: string) => string;
} {
  const { script, home } = scratch();

  const library = sourceableLibrary(script);

  const driver = `${script}.settings`;
  writeFileSync(
    driver,
    [
      `source ${quote(library)}`,
      `parse_arguments ${options(home).map(quote).join(' ')}`,
      'resolve_layout',
      `DRY_RUN='no'`,
      'write_environment_file',
      '',
    ].join('\n'),
  );
  chmodSync(driver, 0o755);

  return {
    home,
    result: run(driver, home, []),
    contents: (path) => readFileSync(path, 'utf8'),
  };
}

/**
 * A node that answers `--version` and nothing else, somewhere a PATH or a
 * prefix can point at.
 *
 * A real runtime is not needed for any of this: every decision the script makes
 * about Node it makes from the major that `node --version` prints, so the shim
 * is the whole of the input. A shim that prints a major below the floor is how
 * a machine with a node on it still reaches the install branch -- the check
 * container is the only place a real download is exercised.
 */
function nodeShim(directory: string, version: string): void {
  mkdirSync(directory, { recursive: true });
  const executable = join(directory, 'node');
  writeFileSync(executable, `#!/bin/sh\necho ${version}\n`);
  chmodSync(executable, 0o755);
}

/**
 * A machine this script has already installed on: the directories and the two
 * marker files `--uninstall` and the refresh read, and none of the several
 * hundred megabytes a real install would put in them.
 *
 * The markers are the point. The version record under the runtime directory is
 * what says that Node is this script's to replace and to remove, and the
 * package tree under `lib/node_modules` is what says the prefix is one this
 * script installed into -- neither is inferred from the path.
 */
function installedMachine(
  home: string,
  options: { readonly recordTheNodeVersion?: boolean } = {},
): {
  readonly prefix: string;
  readonly unitDirectory: string;
} {
  const prefix = join(home, '.agentplex');
  nodeShim(join(prefix, 'node', 'bin'), 'v24.9.0');
  if (options.recordTheNodeVersion !== false) {
    writeFileSync(join(prefix, 'node', '.agentplex-node-version'), 'v24.9.0\n');
  }
  mkdirSync(join(prefix, 'lib', 'node_modules', '@softiesolutions', 'agentplex'), {
    recursive: true,
  });
  mkdirSync(join(prefix, 'bin'), { recursive: true });
  writeFileSync(join(prefix, 'bin', 'agentplex'), '#!/bin/sh\n');
  writeFileSync(join(prefix, 'agentplex.env'), 'AGENTPLEX_ROLE=both\n');

  const unitDirectory = join(home, '.config', 'systemd', 'user');
  mkdirSync(unitDirectory, { recursive: true });
  for (const daemon of ['hub', 'server']) {
    writeFileSync(join(unitDirectory, `agentplex-${daemon}.service`), '[Unit]\n');
  }
  return { prefix, unitDirectory };
}

/**
 * An account to stand in for the one a `--system` install creates.
 *
 * A suite that made an `agentplex` account to chown to would be a suite that
 * left a service account behind on the machine that ran it, so it borrows one
 * that is already there. It has to be an account whose group is named after it,
 * because that is the shape `useradd --system` gives the real one and the shape
 * the chown under test is written in -- `nobody` is precisely the account that
 * is not that, since Debian puts it in `nogroup`. Undefined on a machine with
 * none of them, which skips the tests that need one rather than having them
 * assert something about `chown` argument parsing.
 */
const standInAccount = ['daemon', 'bin', 'sys'].find((name) => {
  const group = spawnSync('id', ['-gn', name], { encoding: 'utf8' });
  return group.status === 0 && group.stdout.trim() === name;
});

function accountId(flag: '-u' | '-g'): number {
  return Number(spawnSync('id', [flag, standInAccount ?? ''], { encoding: 'utf8' }).stdout.trim());
}

/**
 * One step of a `--system` run, called against a prefix in a temporary
 * directory rather than against `/opt` and `/etc`.
 *
 * The layout is set by hand instead of through `resolve_layout`, which is the
 * only way to ask what the step does without writing to the paths a real fleet
 * install owns on the machine running the suite. Root-only, because the whole
 * of what these steps do is a chown and a chmod.
 */
function systemStep(
  step: string,
  layout: (root: string) => readonly string[],
): { readonly root: string; readonly result: RunResult } {
  const { script, home } = scratch();
  const root = mkdtempSync(join(tmpdir(), 'agentplex-system-'));
  temporaries.push(root);

  const library = sourceableLibrary(script);

  const driver = `${script}.${step}`;
  writeFileSync(
    driver,
    [
      `source ${quote(library)}`,
      `UNIT_SCOPE='system'`,
      `SERVICE_USER=${quote(standInAccount ?? '')}`,
      `ROLE='hub'`,
      `DRY_RUN='no'`,
      ...layout(root),
      step,
      '',
    ].join('\n'),
  );
  chmodSync(driver, 0o755);

  return { root, result: run(driver, home, [], { asRoot: true }) };
}

/** The paths a `--system` step is pointed at, under one temporary directory. */
function systemLayout(root: string): readonly string[] {
  const prefix = join(root, 'prefix');
  return [
    `PREFIX=${quote(prefix)}`,
    `BIN_DIR=${quote(join(prefix, 'bin'))}`,
    `NODE_HOME=${quote(join(prefix, 'node'))}`,
    `STATE_DIR=${quote(join(root, 'state'))}`,
    `ENV_FILE=${quote(join(root, 'etc', 'agentplex.env'))}`,
  ];
}

describe('the options', () => {
  it('refuses an option it does not know rather than ignoring it', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--rle=server']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown option --rle=server');
    // The usage goes with the refusal: the flag that was meant is usually one
    // line away from the flag that was typed.
    expect(result.stderr).toContain('--role=<hub|server|both>');
  });

  it('refuses a role that is not one of the three', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--role=worker']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown role "worker"');
  });

  it('refuses a relative prefix, which would resolve against wherever it was run', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--prefix=agentplex']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--prefix must be an absolute path');
  });

  it('answers --help without touching anything', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('--no-setup');
    expect(readdirSync(home)).toEqual([]);
  });

  /**
   * `--version` is the flag every other command-line tool answers with its own
   * version, so this one answers with its own version. The pin that used to
   * live under this spelling is `--package-version` now.
   */
  it('answers --version with its own version, the line its usage leads with', () => {
    const { script, home } = scratch();
    const help = run(script, home, ['--help']).stdout;

    const result = run(script, home, ['--version']);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^agentplex install\.sh \S+\n$/);
    // The same line the usage leads with, so the two cannot drift apart.
    expect(help.startsWith(result.stdout)).toBe(true);
    expect(readdirSync(home)).toEqual([]);
  });

  /**
   * The old spelling of the package pin. Nothing was ever published under it
   * and no alias was kept, so it has to land on the unknown-option refusal
   * rather than quietly pinning something.
   */
  it('refuses the old --version=<version> pin rather than honouring it', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--version=1.2.3']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown option --version=1.2.3');
    expect(result.stderr).toContain('--package-version=<version>');
  });
});

/**
 * `detect_platform`, driven by a stated `uname` rather than by the machine.
 *
 * These are the tests the seam pays for. The kernel and the architecture are
 * words read out of another program, so they go through something that can say
 * no -- and the only way to watch it say no is to hand it a word this machine
 * would never produce. A seam that set `PLATFORM` directly would have skipped
 * this parser entirely.
 */
describe('the machines it will and will not install on', () => {
  it('refuses a kernel it has no answer for, rather than guessing one', () => {
    const { script, home } = scratch();
    const host: Host = { kernel: 'FreeBSD', architecture: 'x86_64', systemctl: false };

    const result = runOn(script, home, host, ['--dry-run', '--role=server']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unsupported system "FreeBSD"');
    // Which two it does install on, so the refusal is an answer and not a stop.
    expect(result.stderr).toContain('Linux and macOS');
    expect(readdirSync(home)).toEqual([]);
  });

  it('refuses an architecture it has no runtime to download for', () => {
    const { script, home } = scratch();
    const host: Host = { kernel: 'Linux', architecture: 'ppc64le', systemctl: true };

    const result = runOn(script, home, host, ['--dry-run', '--role=server']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unsupported architecture "ppc64le"');
    expect(readdirSync(home)).toEqual([]);
  });

  /**
   * The spellings a kernel actually uses, which are not the spellings the
   * script carries internally. Both of these are real `uname -m` answers.
   */
  it('takes the other spelling of each architecture it supports', () => {
    const { script, home } = scratch();

    for (const architecture of ['amd64', 'aarch64']) {
      const host: Host = { kernel: 'Linux', architecture, systemctl: true };
      const result = runOn(script, home, host, ['--dry-run', '--role=server']);
      expect(result.status, architecture).toBe(0);
    }
  });
});

describe('the plan a dry run prints', () => {
  it('installs into the user prefix, for the user who ran it', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--role=server']);

    expect(result.status).toBe(0);
    expect(planned(result.stdout, 'package')).toBe(
      `${packageSpecs('server')} into ${home}/.agentplex`,
    );
    expect(planned(result.stdout, 'settings')).toContain(`${home}/.agentplex/agentplex.env`);
  });

  /**
   * The unit line used to be asserted against whatever machine the suite was
   * running on, which made it a lottery: a Linux runner read one branch, a Mac
   * read a third the branch did not have, and the suite was red on one platform
   * and green on the other for the same commit. The machine is stated now, so
   * all three answers are asserted everywhere.
   *
   * The three stay apart because they send the operator to different places:
   * macOS wants launchd, a Linux box without systemctl wants systemd installed
   * or the daemon started by hand, and a Linux box with it gets a file.
   */
  it('plans a user unit where there is systemd, and gives each machine without one its own reason', () => {
    const { script, home } = scratch();
    const unit = (host: Host): string | undefined =>
      planned(runOn(script, home, host, ['--dry-run', '--role=server']).stdout, 'unit');

    expect(unit(LINUX_WITH_SYSTEMD)).toBe(
      `${home}/.config/systemd/user/agentplex-server.service (write, not enabled)`,
    );
    expect(unit(LINUX_WITHOUT_SYSTEMD)).toBe('skipped: no systemctl on this machine');
    // Not the systemctl reason with a different machine behind it: telling a Mac
    // user to install systemd would be wrong, and this is what says so.
    expect(unit(MACOS)).toBe('skipped: macOS has no systemd, hand the process to launchd');
  });

  /**
   * One line per step, which is the shape `report` exists to hold. The answer
   * used to be reported by the predicate that gave it, so the line came out
   * once per place that asked -- and a second place that asked was added, and
   * the plan grew a duplicate nobody had written.
   */
  it('reports the unit step once, whichever answer the machine gives', () => {
    const { script, home } = scratch();
    const lines = (host: Host, role: string): readonly string[] =>
      unitLines(runOn(script, home, host, ['--dry-run', `--role=${role}`]).stdout);

    expect(lines(LINUX_WITH_SYSTEMD, 'server')).toHaveLength(1);
    // A machine with systemd writes a file per daemon and names each file. A
    // machine without one has a single answer to give, not one answer per
    // daemon that will not be written -- and that holds for both of the machines
    // that have no unit to write, for their two different reasons.
    expect(lines(LINUX_WITH_SYSTEMD, 'both')).toHaveLength(2);
    expect(lines(LINUX_WITHOUT_SYSTEMD, 'both')).toHaveLength(1);
    expect(lines(MACOS, 'both')).toHaveLength(1);
  });

  it('changes nothing at all', () => {
    const { script, home } = scratch();
    run(script, home, ['--dry-run']);
    expect(readdirSync(home)).toEqual([]);
  });

  /**
   * `--package-version` is the command's pin and the command alone, which is
   * what it has always been: `setup` and `doctor` go on every machine whatever
   * it runs, so the one package every role installs is the one a flag with no
   * component in its name can mean. The daemons are pinned through --role now.
   */
  it('pins the command it was given a version for, and resolves the rest', () => {
    const { script, home, versions } = scratch();
    writeReleaseMetadata(versions, 'cli', '1.2.3');

    const result = run(script, home, ['--dry-run', '--role=hub', '--package-version=1.2.3']);

    expect(result.status).toBe(0);
    expect(planned(result.stdout, 'package')).toBe(
      `${packageSpecs('hub', { ...CURRENT, cli: '1.2.3' })} into ${home}/.agentplex`,
    );
  });

  /**
   * The two halves of what used to be one constant, asserted together because
   * the failure this guards against is one of them moving without the other.
   * The unscoped `agentplex` on npm is somebody else's, so the registry entry
   * is scoped; a `bin` key is not a package name, so the binary in the prefix,
   * the stem of the unit file names and every word an operator reads stay
   * `agentplex`.
   */
  it('names the scoped package to npm and the plain command to the operator', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--role=both']);

    expect(planned(result.stdout, 'package')).toContain(
      `/cli-v${CURRENT['cli'] ?? ''}/agentplex.tgz`,
    );

    const units = run(script, home, ['--print-unit', '--role=both']).stdout;
    expect(execStarts(units).map((line) => line.script)).toEqual([
      daemonEntry(`${home}/.agentplex`, 'hub'),
      daemonEntry(`${home}/.agentplex`, 'server'),
    ]);

    // The scope reaches the unit, and only there, and only because npm put it
    // in a directory name. There is no `agentplex hub` to run, so ExecStart
    // names the daemon's file, and that file is inside the tree npm wrote at
    // the name it was installed under. It is npm's spelling of where a package
    // lives rather than a word this script chose -- so every word this script
    // does choose is still unscoped: the binary, the unit file names, and
    // every line an operator reads.
    const scoped = units.split('\n').filter((line) => line.includes('softiesolutions'));
    expect(scoped).toHaveLength(2);
    expect(scoped.every((line) => line.startsWith('ExecStart='))).toBe(true);
    // The two unscoped words in the same file, so this says what stayed as well
    // as what moved.
    expect(units).toContain('Description=agentplex hub');
    expect(units).toContain('Description=agentplex server');
  });

  /**
   * The drain and the unit's stop timeout, which are one decision.
   *
   * The server waits for the turns it is holding to reach a boundary before it
   * closes them, and systemd sends SIGKILL after `TimeoutStopSec` whatever the
   * daemon is doing. A drain at or past that number is not a longer drain: it
   * is the same kill with a wait in front of it, and every session mid-turn
   * dies exactly where the drain was supposed to stop it dying. So the two
   * numbers have to be read together, and this is the place they can be --
   * `install.sh` renders both from one pair, and this is what says so.
   */
  it('gives the drain less time than systemd gives the whole stop', () => {
    const { script, home } = scratch();
    const unit = run(script, home, ['--print-unit', '--role=server']).stdout;

    const drain = /^Environment=AGENTPLEX_SERVER_DRAIN_SECONDS=(\d+)$/m.exec(unit);
    const stop = /^TimeoutStopSec=(\d+)s$/m.exec(unit);

    expect(drain?.[1], 'the unit sets no drain budget').toBeDefined();
    expect(stop?.[1], 'the unit sets no stop timeout').toBeDefined();
    expect(Number(drain?.[1])).toBeLessThan(Number(stop?.[1]));
    // And the margin is a real one, not a rounding error: what is left is what
    // the process has to kill the stragglers, close its sockets and exit.
    expect(Number(stop?.[1]) - Number(drain?.[1])).toBeGreaterThanOrEqual(5);
  });

  /**
   * The one role table, asserted as a table. `web` is not a role: it is part of
   * being a hub, because the hub finds the client by resolving that package
   * name and a hub without it serves 503. The command is in every row, because
   * `setup` and `doctor` belong on every machine whatever it runs.
   */
  it.each([
    ['hub', ['cli', 'hub', 'web'], ['server']],
    ['server', ['cli', 'server'], ['hub', 'web']],
    ['both', ['cli', 'hub', 'web', 'server'], []],
  ])('installs the packages --role=%s runs, and no others', (role, wanted, unwanted) => {
    const { script, home } = scratch();
    const { source: line } = packagePlan(run(script, home, ['--dry-run', `--role=${role}`]).stdout);

    for (const component of wanted) {
      expect(line, component).toContain(releaseUrl(component, CURRENT[component] ?? ''));
    }
    for (const component of unwanted) expect(line, component).not.toContain(`/${component}-v`);
  });

  /**
   * AGENTPLEX_PACKAGE is how the container check installs a build that has
   * never been published, and with four packages it names a directory of packed
   * tarballs rather than one spec.
   *
   * A directory rather than four variables, because four variables can be half
   * set: a machine that pinned the hub and let the command fall through to a
   * registry would report a green check of a build it had not installed. A
   * directory either holds what the role needs or the run stops.
   */
  it('installs the tarballs in the directory AGENTPLEX_PACKAGE names', () => {
    const { script, home } = scratch();
    const packages = join(home, 'package');
    mkdirSync(packages, { recursive: true });
    for (const name of ['agentplex', 'agentplex-hub', 'agentplex-server', 'agentplex-web']) {
      writeFileSync(join(packages, `softiesolutions-${name}-0.0.0.tgz`), '');
    }

    const { source: line } = packagePlan(
      run(script, home, ['--dry-run', '--role=hub'], {
        environment: { AGENTPLEX_PACKAGE: packages },
      }).stdout,
    );

    // The hub's three, by file. The `[0-9]` in the script's pattern is what
    // keeps the command's own tarball from also matching the hub, the server
    // and the client: every one of those names starts with the command's.
    expect(line).toContain(`${packages}/softiesolutions-agentplex-0.0.0.tgz`);
    expect(line).toContain(`${packages}/softiesolutions-agentplex-hub-0.0.0.tgz`);
    expect(line).toContain(`${packages}/softiesolutions-agentplex-web-0.0.0.tgz`);
    expect(line).not.toContain('softiesolutions-agentplex-server-0.0.0.tgz');
    // Nothing fell through to a release.
    expect(line).not.toContain('https://');
  });

  /**
   * Half a directory is the failure this seam has to name rather than paper
   * over: installing the rest and leaving one package to a registry would be a
   * check reporting on a build it did not install.
   */
  it('stops when the directory does not hold a package the role needs', () => {
    const { script, home } = scratch();
    const packages = join(home, 'package');
    mkdirSync(packages, { recursive: true });
    writeFileSync(join(packages, 'softiesolutions-agentplex-0.0.0.tgz'), '');

    const result = run(script, home, ['--dry-run', '--role=hub'], {
      environment: { AGENTPLEX_PACKAGE: packages },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('softiesolutions-agentplex-hub');
  });

  it('would hand over to setup, with the role it was given', () => {
    const { script, home } = scratch();
    // A dry run reports the handover it would make whether or not a terminal is
    // attached, because the question here is what it would run and not whether
    // this process has a tty.
    const result = run(script, home, ['--dry-run', '--role=hub']);
    expect(result.stdout).toMatch(
      /setup\s+(would run .*agentplex setup --role=hub|not run: no terminal)/,
    );
  });

  it('would hand the prefix it installed into over to setup, and not only the role', () => {
    // The split brain this closed: the unit reads `<prefix>/agentplex.env` and
    // resolves programs in `<prefix>/bin`, and a wizard that was told only the
    // role installed the provider under `$HOME/.agentplex` and recorded the
    // pairing there -- so the service came up unpaired, with nothing on its bin
    // path, and nothing reported a problem.
    const { script, home } = scratch();
    const prefix = join(home, 'custom');

    const result = run(script, home, ['--dry-run', '--role=hub', `--prefix=${prefix}`]);

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      new RegExp(
        `setup\\s+(would run ${escaped(prefix)}/bin/agentplex setup --role=hub ` +
          `--prefix=${escaped(prefix)}|not run: no terminal)`,
      ),
    );
    // The file that handover has to agree with, named in the same plan.
    expect(planned(result.stdout, 'settings')).toContain(`${prefix}/agentplex.env`);
  });

  /**
   * The same handover, asserted on a machine with no tty -- which is every
   * machine this suite runs on, including the check container. The test above
   * has to allow "not run: no terminal", so it cannot fail if the prefix stops
   * being passed; this loads the script's functions, says there is a terminal,
   * and reads the one line the step would print.
   */
  it('names the prefix in the handover it would make where there is a terminal', () => {
    const { script, home } = scratch();

    const library = sourceableLibrary(script);

    const driver = `${script}.setup`;
    writeFileSync(
      driver,
      [
        `source ${quote(library)}`,
        'parse_arguments --dry-run --role=hub',
        'resolve_layout',
        'have_terminal() { return 0; }',
        'run_setup',
        '',
      ].join('\n'),
    );
    chmodSync(driver, 0o755);

    const result = run(driver, home, []);

    expect(result.status).toBe(0);
    expect(planned(result.stdout, 'setup')).toBe(
      `would run ${home}/.agentplex/bin/agentplex setup --role=hub --prefix=${home}/.agentplex`,
    );
  });

  it('does not hand over to setup when told not to', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--no-setup']);
    expect(planned(result.stdout, 'setup')).toBe('not run: --no-setup');
  });
});

/**
 * node-pty is what needs a C++ compiler, and only a server opens a
 * pseudoterminal. The hub was paying for both: the toolchain on every install,
 * and the source build that is the likeliest step of the whole install to fail.
 */
describe('the toolchain, which only one role needs', () => {
  it('plans no toolchain for a hub, and says why rather than going quiet', () => {
    const { script, home } = scratch();
    const planned_ = planned(run(script, home, ['--dry-run', '--role=hub']).stdout, 'toolchain');

    expect(planned_).toContain('not needed');
    // The reason, not just the verdict: an operator reading a plan that skipped
    // a step it used to take needs to know it was a decision.
    expect(planned_).toContain('hub');
    expect(planned_).toContain('node-pty');
    // Nothing that reads as a package install.
    expect(planned_).not.toContain('g++');
  });

  /**
   * The other half, and the reason this is not simply a deletion: for the two
   * roles that run a server the compiler is still required, and so is a node-pty
   * that actually builds. `optionalDependencies` lets npm exit 0 without it,
   * which on a server is the silent success the whole ticket is about.
   */
  it('still plans a toolchain for a server and for both on Linux, and says the build must succeed', () => {
    const { script, home } = scratch();

    for (const role of ['server', 'both']) {
      const line = planned(
        runOn(script, home, LINUX_WITH_SYSTEMD, ['--dry-run', `--role=${role}`]).stdout,
        'toolchain',
      );
      expect(line, role).not.toContain('not needed');
      // Either it is already here or it is about to be installed; what the line
      // must never say for these roles is that nothing needs it. Which of the
      // two it is stays the machine's answer -- a suite that stated a compiler
      // into or out of existence would be asserting about its own fixture.
      expect(line, role).toMatch(/present|install/);
      expect(line, role).toContain('node-pty');
    }
  });

  /**
   * The same two roles on a Mac, where the honest answer is the opposite one.
   *
   * node-pty ships prebuilt binaries for macOS -- `apps/server/README.md` says
   * so outright -- so there is nothing for a compiler to build and nothing to
   * install. This assertion was a Linux rule stated as a universal one, and on
   * a Mac it failed the installer for telling the truth.
   */
  it('needs no toolchain on macOS, where node-pty ships a prebuild', () => {
    const { script, home } = scratch();

    for (const role of ['server', 'both']) {
      const line = planned(
        runOn(script, home, MACOS, ['--dry-run', `--role=${role}`]).stdout,
        'toolchain',
      );
      expect(line, role).toContain('not needed');
      // The reason, and the right one of the two: a Mac is skipped for its
      // prebuild, not for being a machine that runs no server.
      expect(line, role).toContain('macOS');
      expect(line, role).toContain('node-pty');
      expect(line, role).not.toContain('g++');
    }
  });

  /**
   * What replaced AGENTPLEX_REQUIRE_PTY, which is nothing, on purpose.
   *
   * The variable existed because node-pty was optional in one tarball every
   * machine installed: npm exits 0 when an optional build fails, so a server
   * could report a clean install and then fail to open a session, and the
   * package's postinstall read the variable and turned that back into a failed
   * install. node-pty is a required dependency of the server package now, so
   * npm fails that install itself at the compile. The second mechanism has
   * nothing left to do, and machinery whose reason has gone is removed rather
   * than kept.
   */
  it('sets no environment variable to make npm require what npm already requires', () => {
    const source = readFileSync(scriptPath, 'utf8');
    // Executable lines only. The script still explains what that variable was
    // for and why it went, which is exactly where that argument belongs.
    const runs = source
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));

    expect(runs.filter((line) => line.includes('AGENTPLEX_REQUIRE_PTY'))).toEqual([]);
    // The question the toolchain step asks is still asked, and is still asked
    // of the daemons this machine runs rather than of the role word.
    expect(source).toContain('runs_a_server');
  });
});

describe('the settings file it writes once', () => {
  it('records the prefix it chose, uncommented, beside the role and the bin path', () => {
    // The third fact the installer has, and the one a `agentplex setup` run by
    // hand on this machine months later cannot otherwise know: without it that
    // run owns `$HOME/.agentplex` while everything else on the machine points at
    // the prefix this install created.
    const { home, result, contents } = environmentFileWritten(() => ['--role=server']);
    const prefix = `${home}/.agentplex`;

    expect(result.status).toBe(0);
    const lines = contents(`${prefix}/agentplex.env`).split('\n');
    expect(lines).toContain(`AGENTPLEX_PREFIX=${prefix}`);
    expect(lines).toContain('AGENTPLEX_ROLE=server');
    expect(lines).toContain(`AGENTPLEX_BIN_PATH=${prefix}/bin`);
  });

  it('records the prefix it was given rather than the one it would have chosen', () => {
    const { home, result, contents } = environmentFileWritten((where) => [
      '--role=server',
      `--prefix=${where}/custom`,
    ]);

    expect(result.status).toBe(0);
    expect(contents(`${home}/custom/agentplex.env`).split('\n')).toContain(
      `AGENTPLEX_PREFIX=${home}/custom`,
    );
  });
});

describe('being piped into bash, which is the documented happy path', () => {
  /**
   * The hazard this covers, captured rather than reasoned about: under
   * `cat install.sh | bash` the script *is* bash's stdin, so a child that reads
   * stdin reads the script. A probe of exactly that shape had its `read` return
   * the text of the next line and bash then resumed from the line after it --
   * a check silently skipped, with nothing reporting a problem.
   *
   * So a piped run must reach its last line, and must not start a wizard on a
   * stdin that is the installer.
   */
  it('runs to its own last line and starts no wizard on the pipe', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--role=server'], { piped: true });

    expect(result.status).toBe(0);
    // The last thing the script prints. Reaching it means bash read the whole
    // stream, which is the property `main` on the final line exists to protect.
    expect(result.stdout).toContain('dry run: nothing above was done.');
    expect(planned(result.stdout, 'setup')).toBe('not run: no terminal to run a wizard on');
  });

  it('calls main on its last line, so a truncated download does nothing', () => {
    const source = readFileSync(scriptPath, 'utf8').trimEnd().split('\n');
    expect(source.at(-1)).toBe('main "$@"');
  });
});

describe('installing as the wrong user', () => {
  it.skipIf(!suiteIsRoot)('refuses root, because the agents it runs would be root too', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run'], { asRoot: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing to install as root');
    expect(result.stderr).toContain('--system');
  });

  it('refuses --system without root, because it has an account to create', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--system']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must run as root');
  });

  it.skipIf(!suiteIsRoot)('creates the service account before anything is owned by it', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--system'], { asRoot: true });
    const lines = result.stdout.split('\n');

    expect(planned(result.stdout, 'account')).toContain('create agentplex');
    // Order, not just presence. The environment file is chowned to this
    // account, and a chown to a user that does not exist yet ends the run after
    // the package has landed -- half an install, and the confusing half.
    expect(lines.findIndex((line) => line.startsWith('account '))).toBeLessThan(
      lines.findIndex((line) => line.startsWith('settings ')),
    );
  });

  it.skipIf(!suiteIsRoot)(
    'never opens a wizard on a --system machine, which has nobody to answer it',
    () => {
      const { script, home } = scratch();
      const result = run(script, home, ['--dry-run', '--system'], { asRoot: true });
      expect(result.status).toBe(0);
      expect(planned(result.stdout, 'setup')).toContain('take a plan');
    },
  );
});

/**
 * What a `--system` install hands to the service account.
 *
 * That account runs coding agents, which is the most exposed program on the
 * machine, so what it owns is the whole of what a compromised session can
 * rewrite. It used to own the prefix, which included the interpreter its own
 * unit is started through and the file holding the client token; it now owns
 * the directories npm writes into and the state directory, and nothing else.
 */
describe('what a --system install hands to the service account', () => {
  it.skipIf(!suiteIsRoot)('says in the plan what the account will own and what root keeps', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--system'], { asRoot: true });

    const ownership = planned(result.stdout, 'ownership');
    expect(ownership).toContain('agentplex owns /opt/agentplex/bin');
    expect(ownership).toContain('/opt/agentplex/lib/node_modules');
    // Not obvious, and therefore worth saying out loud: npm links a package's
    // man pages into `<prefix>/share/man`, so a provider install by this
    // account creates that directory or fails at the end.
    expect(ownership).toContain('/opt/agentplex/share');
    expect(ownership).toContain('/var/lib/agentplex');
    expect(ownership).toContain('root keeps /opt/agentplex/node and /etc/agentplex/agentplex.env');
  });

  it('hands nothing over on a user install, where the prefix is the account already', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--role=server']);
    expect(planned(result.stdout, 'ownership')).toBeUndefined();
  });

  it.skipIf(!suiteIsRoot || standInAccount === undefined)(
    'owns the directories npm writes and leaves the runtime and the prefix to root',
    () => {
      const { root, result } = systemStep('grant_service_account_ownership', (where) => {
        const prefix = join(where, 'prefix');
        // What npm leaves behind by the time this step runs, and no more:
        // `bin`, `share` and the state directory are deliberately absent, which
        // is the case a chown alone would die on.
        mkdirSync(join(prefix, 'lib', 'node_modules', '@softiesolutions', 'agentplex'), {
          recursive: true,
        });
        nodeShim(join(prefix, 'node', 'bin'), 'v24.9.0');
        return systemLayout(where);
      });

      expect(result.status).toBe(0);

      const prefix = join(root, 'prefix');
      const owner = (path: string): readonly [number, number] => {
        const stats = statSync(path);
        return [stats.uid, stats.gid];
      };
      const account = [accountId('-u'), accountId('-g')];

      expect(owner(join(prefix, 'bin'))).toEqual(account);
      expect(owner(join(prefix, 'lib', 'node_modules'))).toEqual(account);
      // Recursive: the package tree npm already wrote is inside the tree setup
      // has to be able to replace on an upgrade.
      expect(owner(join(prefix, 'lib', 'node_modules', '@softiesolutions', 'agentplex'))).toEqual(
        account,
      );
      expect(owner(join(prefix, 'share'))).toEqual(account);
      expect(owner(join(root, 'state'))).toEqual(account);

      // The point of the ticket. A session that gets out of the account it runs
      // as cannot rewrite the interpreter its own service is started through,
      // and cannot put anything new at the top of the prefix either.
      expect(owner(join(prefix, 'node'))).toEqual([0, 0]);
      expect(owner(join(prefix, 'node', 'bin', 'node'))).toEqual([0, 0]);
      expect(owner(prefix)).toEqual([0, 0]);
      expect(owner(join(prefix, 'lib'))).toEqual([0, 0]);
    },
  );

  it.skipIf(!suiteIsRoot || standInAccount === undefined)(
    'writes the settings file for the daemon to read and not to write',
    () => {
      const { root, result } = systemStep('write_environment_file', systemLayout);

      expect(result.status).toBe(0);
      const stats = statSync(join(root, 'etc', 'agentplex.env'));
      // 0640 root:account, and each third of that is load-bearing: the token in
      // this file is why nothing but root writes it, the daemon runs as the
      // account and has to read it, and nobody else on the machine is either.
      expect(stats.mode & 0o777).toBe(0o640);
      expect(stats.uid).toBe(0);
      expect(stats.gid).toBe(accountId('-g'));
    },
  );
});

describe('the systemd unit', () => {
  it('writes one unit per daemon the role runs, and both for --role=both', () => {
    const { script, home } = scratch();
    const both = run(script, home, ['--print-unit', '--role=both']).stdout;

    expect(execStarts(both).map((line) => line.script)).toEqual([
      daemonEntry(`${home}/.agentplex`, 'hub'),
      daemonEntry(`${home}/.agentplex`, 'server'),
    ]);
    expect(both).toContain('Description=agentplex hub');
    expect(both).toContain('Description=agentplex server');
  });

  it('runs as the invoking user by living in their own unit directory', () => {
    const { script, home } = scratch();
    const unit = run(script, home, ['--print-unit', '--role=server']).stdout;

    // No User= directive at all: a user unit runs as its user, and a line
    // naming one would be a claim this scope cannot make.
    expect(unit.split('\n').filter((line) => line.startsWith('User='))).toEqual([]);
    expect(execStarts(unit).map((line) => line.script)).toEqual([
      daemonEntry(`${home}/.agentplex`, 'server'),
    ]);
    expect(unit).not.toContain('apps/hub');
    expect(unit).toContain(`EnvironmentFile=${home}/.agentplex/agentplex.env`);
    expect(unit).toContain('WantedBy=default.target');
  });

  it('orders against no network-online.target in user scope, where that target does not exist', () => {
    const { script, home } = scratch();
    const unit = run(script, home, ['--print-unit']).stdout;

    // network-online.target is a unit of the system manager. The user
    // manager's search paths hold no such file, so these two lines in a user
    // unit name a unit that cannot be loaded: systemd orders against nothing
    // and the reader is told a guarantee that is not one.
    expect(unit).not.toContain('network-online.target');
    expect(unit.split('\n').filter((line) => line.startsWith('After='))).toEqual([]);
    expect(unit.split('\n').filter((line) => line.startsWith('Wants='))).toEqual([]);
  });

  it('puts the prefix in front of the PATH the unit gets', () => {
    const { script, home } = scratch();
    const unit = run(script, home, ['--print-unit']).stdout;
    // The spec's opening problem: a systemd PATH has no version-manager shims
    // in it, so the runtime and the agents have to be named rather than
    // inherited -- and in front of the machine rather than instead of it,
    // because a session also shells out to git and rg.
    expect(unit).toContain(`Environment=PATH=${home}/.agentplex/bin:`);
    expect(unit).toMatch(/^Environment=PATH=.*:\/usr\/local\/sbin:.*:\/bin$/m);
  });

  it('names the directory an adopted node came from, when nothing else would find it', () => {
    const { script, home } = scratch();
    const shims = join(home, 'shims');
    mkdirSync(shims);
    // A version manager's shim directory, which is where a developer's node
    // usually is and is somewhere a systemd unit has never heard of. Without
    // this line the service dies on the `#!/usr/bin/env node` of the program it
    // was pointed at.
    writeFileSync(join(shims, 'node'), '#!/bin/sh\necho v24.9.0\n');
    chmodSync(join(shims, 'node'), 0o755);
    chmodSync(shims, 0o777);

    const unit = run(script, home, ['--print-unit'], {
      environment: { PATH: `${shims}:/usr/bin:/bin` },
    }).stdout;

    expect(unit).toContain(`Environment=PATH=${home}/.agentplex/bin:${shims}:/usr/local/sbin`);
  });

  it('does not repeat a directory the unit already searches', () => {
    const { script, home } = scratch();
    // /usr/bin and /bin are already in the unit's PATH, so a node found in one
    // adds nothing: the same directory twice is a longer line saying the same
    // thing.
    const unit = run(script, home, ['--print-unit'], {
      environment: { PATH: '/usr/bin:/bin' },
    }).stdout;
    const searchPath = /^Environment=PATH=(.*)$/m.exec(unit)?.[1] ?? '';
    const directories = searchPath.split(':');
    expect(new Set(directories).size).toBe(directories.length);
  });

  it('stops rather than restarting when the configuration is what is wrong', () => {
    const { script, home } = scratch();
    const unit = run(script, home, ['--print-unit']).stdout;
    // Exit 2 is main.ts's EXIT_BAD_CONFIGURATION: restarting will not help.
    expect(unit).toContain('RestartPreventExitStatus=2');
    expect(unit).toContain('Restart=on-failure');
  });

  it('carries no sandboxing, because the service exists to reach the operator files', () => {
    const { script, home } = scratch();
    const unit = run(script, home, ['--print-unit']).stdout;
    for (const directive of ['ProtectHome=', 'ProtectSystem=', 'NoNewPrivileges=', 'PrivateTmp=']) {
      expect(unit.split('\n').filter((line) => line.startsWith(directive))).toEqual([]);
    }
  });

  it.skipIf(!suiteIsRoot)('names the service account when it is a system unit', () => {
    const { script, home } = scratch();
    const unit = run(script, home, ['--print-unit', '--system', '--role=both'], {
      asRoot: true,
    }).stdout;
    expect(unit).toContain('User=agentplex');
    expect(unit).toContain('Group=agentplex');
    expect(execStarts(unit).map((line) => line.script)).toEqual([
      daemonEntry('/opt/agentplex', 'hub'),
      daemonEntry('/opt/agentplex', 'server'),
    ]);
    expect(unit).toContain('EnvironmentFile=/etc/agentplex/agentplex.env');
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it.skipIf(!suiteIsRoot)(
    'waits for the network in system scope, where that target is real',
    () => {
      const { script, home } = scratch();
      const unit = run(script, home, ['--print-unit', '--system', '--role=both'], {
        asRoot: true,
      }).stdout;
      // The system manager has network-online.target, so here the ordering is
      // one systemd can actually honour.
      expect(unit).toContain('After=network-online.target');
      expect(unit).toContain('Wants=network-online.target');
    },
  );
});

describe('the summary on a machine that got its units', () => {
  /**
   * What replaced two lines of `systemctl`.
   *
   * The instructions were correct and they made the operator carry a fact the
   * machine already knows: whether their units belong to the user manager or
   * the system one, and therefore which of the two spellings reaches them.
   * `agentplex start` reads that off the settings file this same run wrote, in
   * the same branch that chose the unit directory, and does both steps.
   */
  it('tells the operator to run agentplex start rather than two systemctl lines', () => {
    const { home, result } = summaryWithUnits('both');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('deliberately not started');
    expect(result.stdout).toContain(`${home}/.agentplex/bin/agentplex start`);
    expect(result.stdout).toContain('agentplex status says what is installed here');
    // The whole vocabulary that moved into the command, gone from the summary.
    expect(result.stdout).not.toContain('systemctl --user daemon-reload');
    expect(result.stdout).not.toContain('enable --now');
  });

  /**
   * Lingering stays, and it is not an oversight that `agentplex start` does not
   * do it: it is a property of the account rather than of a unit, and enabling
   * it is a decision about whether this user's processes outlive their session.
   */
  it('keeps the linger line, which is the one thing agentplex start cannot do', () => {
    const { result } = summaryWithUnits('server');

    expect(result.stdout).toContain('loginctl enable-linger');
  });
});

describe('the summary on a machine that can hold no unit', () => {
  /**
   * The gap this closes: the instruction block was printed only when a unit
   * file existed, and on a machine with no systemd none does -- so the one
   * operator with nothing supervising the install was the one told nothing at
   * all about how to start it.
   */
  it('says no unit was written, why, and what to run instead', () => {
    const { home, result } = summaryWithNoUnitWritten('no systemctl on this machine');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No unit was written: no systemctl on this machine.');
    // The same command line the unit would have carried. There is no shorter
    // thing to tell this operator to type: a daemon is not a command, so what
    // they get is the interpreter and the file, which is also exactly what
    // launchd wants from them.
    expect(result.stdout).toContain(daemonEntry(`${home}/.agentplex`, 'server'));
    // The systemd instructions belong to the machine that got a unit, and this
    // one did not.
    expect(result.stdout).not.toContain('systemctl --user enable --now');
    expect(result.stdout).not.toContain('deliberately not started');
  });

  /**
   * The two reasons stay apart all the way to the operator: one says reach for
   * launchd, the other says install systemd or run the daemon yourself.
   */
  it('carries the macOS reason through rather than the systemctl one', () => {
    const { result } = summaryWithNoUnitWritten(
      'macOS has no systemd, hand the process to launchd',
    );

    expect(result.stdout).toContain('macOS has no systemd, hand the process to launchd');
    expect(result.stdout).not.toContain('no systemctl on this machine');
  });
});

describe('where the script says it is served from', () => {
  /**
   * The one constant, read out of the script rather than restated here: a copy
   * of the URL in this file would pass whatever the script said.
   */
  function declaredUrl(): string {
    const source = readFileSync(scriptPath, 'utf8');
    const declared = /^readonly INSTALL_SH_URL='([^']+)'$/m.exec(source)?.[1];
    expect(declared).toBeDefined();
    return declared ?? '';
  }

  /**
   * The open decision this ticket had to settle. The value is one constant in
   * the script; this is what makes it one constant rather than one constant and
   * three copies in prose that drift away from it.
   */
  it('prints the same URL the documentation tells people to fetch', () => {
    const declared = declaredUrl();
    expect(declared).toMatch(/^https:\/\//);
    expect(readFileSync(documentation, 'utf8')).toContain(declared);
  });

  /**
   * The failure this is here to stop is the one the documented entry point
   * actually had: a placeholder nobody substituted, served to every reader as a
   * command to run and answered by a 404. Nothing is fetched -- the branch is
   * created by the first release, the check container has no network, and a
   * test that needs either would be red for reasons that are not about this
   * constant. What can be asserted without the world in any particular state is
   * that the string is a location and not a template.
   */
  it('names a location rather than a template to fill in', () => {
    const declared = declaredUrl();
    expect(declared).not.toMatch(/[<>]/);
    const url = new URL(declared);
    expect(url.protocol).toBe('https:');
    expect(url.hostname).not.toBe('');
    expect(url.pathname.split('/').slice(1)).not.toContain('');
    expect(url.pathname).toMatch(/install\.sh$/);
  });

  it('pins the version the script calls itself in the path it is served from', () => {
    const source = readFileSync(scriptPath, 'utf8');
    const version = /^readonly INSTALL_SH_VERSION='([^']+)'$/m.exec(source)?.[1];
    expect(version).toBeDefined();
    // A URL that means different bytes on different days is the thing being
    // ruled out, and the major in the path is what rules it out. It is the
    // script's own version because a change that breaks a documented
    // invocation is a second path rather than an edit to this one.
    expect(new URL(declaredUrl()).pathname).toContain(`/v${version}/`);
  });

  /**
   * The other half of a URL that resolves: something has to put the script at
   * it. The release workflow's `v1` job is that something, so the ref the URL
   * names and the ref that job pushes are held together here rather than left
   * to agree by memory across two directories.
   */
  it('is served from the ref the release workflow moves', () => {
    const [, , ref] = new URL(declaredUrl()).pathname.split('/').slice(1);
    expect(ref).toBeDefined();
    expect(readFileSync(releaseWorkflow, 'utf8')).toContain(`refs/heads/${ref}`);
  });
});

describe('how the script reaches the network', () => {
  /**
   * Every path that can download the runtime, not just the one most machines
   * take. A machine with wget and no curl falls through to the fallback, and a
   * fallback that accepts whatever the other end offers is a floor set by
   * accident rather than by choice.
   */
  it('pins https and TLS 1.2 on both downloaders', () => {
    const source = readFileSync(scriptPath, 'utf8');
    const body = /^fetch\(\) \{$([\s\S]*?)^\}$/m.exec(source)?.[1] ?? '';
    const lines = body.split('\n').map((line) => line.trim());
    const curl = lines.find((line) => line.startsWith('curl '));
    expect(curl).toContain("--proto '=https'");
    expect(curl).toContain('--tlsv1.2');
    const wget = lines.find((line) => line.startsWith('wget '));
    expect(wget).toContain('--https-only');
    expect(wget).toContain('--secure-protocol=TLSv1_2');
  });
});

describe('where the runtime goes', () => {
  /**
   * The problem this closed: the tarball is laid out as a prefix of its own --
   * bin/, include/, lib/, share/ -- and `--strip-components=1` into $PREFIX
   * spread it over the directory that also holds the settings file, the server
   * identity and, for a --system install, the hub database. Two lifetimes in
   * one directory, and neither "what did this install put here" nor "what is
   * safe to delete" had an answer.
   */
  it('unpacks Node into a directory of its own, not over the prefix', () => {
    const { script, home } = scratch();
    // A node too old for the floor, in front of whatever this machine has, so
    // the run reaches the install branch wherever the suite happens to run.
    const shims = join(home, 'shims');
    nodeShim(shims, 'v20.11.0');

    const result = run(script, home, ['--dry-run', '--role=server'], {
      environment: { PATH: `${shims}:/usr/bin:/bin` },
    });

    expect(result.status).toBe(0);
    expect(planned(result.stdout, 'node')).toContain(`into ${home}/.agentplex/node`);
    // The prefix is still where npm links globals, because that is where the
    // binary and any provider the wizard installs appear, and it is what
    // AGENTPLEX_BIN_PATH and the unit's PATH already name.
    expect(planned(result.stdout, 'package')).toBe(
      `${packageSpecs('server')} into ${home}/.agentplex`,
    );
  });

  it('gives the unit the bin directory and the Node directory, once each', () => {
    const { script, home } = scratch();
    const shims = join(home, 'shims');
    nodeShim(shims, 'v20.11.0');

    const unit = run(script, home, ['--print-unit'], {
      environment: { PATH: `${shims}:/usr/bin:/bin` },
    }).stdout;

    const searchPath = /^Environment=PATH=(.*)$/m.exec(unit)?.[1] ?? '';
    // Both directories, and not for ExecStart: that line names the interpreter
    // outright and resolves nothing through this. It is for what the daemon
    // starts -- the coding agents setup installs into the prefix's bin, every
    // one of them a script looking for a `node` that lives somewhere systemd
    // would never search.
    expect(searchPath).toBe(
      `${home}/.agentplex/bin:${home}/.agentplex/node/bin:` +
        '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    );
    const directories = searchPath.split(':');
    expect(new Set(directories).size).toBe(directories.length);
  });
});

describe('refreshing a Node this script installed', () => {
  /**
   * A dry run downloads nothing, and the version that answers "is this current"
   * is read out of a file on nodejs.org -- so the honest plan line is the
   * runtime that is here plus the fact that the question went unasked. Claiming
   * it would keep the runtime, or that it would replace it, would both be
   * claims this run has no way to make.
   */
  it('says under --dry-run that it did not ask, because asking is a download', () => {
    const { script, home } = scratch();
    installedMachine(home);

    const node = planned(
      run(script, home, ['--dry-run', '--role=server'], {
        environment: { PATH: '/usr/bin:/bin' },
      }).stdout,
      'node',
    );

    expect(node).toContain('v24.9.0');
    expect(node).toContain(`${home}/.agentplex/node`);
    expect(node).toContain('not checked');
  });

  /**
   * The record, and not the directory, is what makes a runtime this script's to
   * replace. A Node an operator unpacked there themselves is their decision,
   * and silently installing over it is the failure `resolve_node_directory`'s
   * own comment argues against one paragraph up.
   */
  it('adopts a Node under the prefix it has no record of installing', () => {
    const { script, home } = scratch();
    installedMachine(home, { recordTheNodeVersion: false });

    const result = run(script, home, ['--dry-run', '--role=server'], {
      environment: { PATH: '/usr/bin:/bin' },
    });

    expect(planned(result.stdout, 'node')).toBe(`adopt v24.9.0 from ${home}/.agentplex/node/bin`);
  });
});

describe('undoing an install', () => {
  it('names the units and the directories it would remove, and removes none of them', () => {
    const { script, home } = scratch();
    const { prefix, unitDirectory } = installedMachine(home);

    const result = run(script, home, ['--uninstall', '--dry-run']);

    expect(result.status).toBe(0);
    const units = unitLines(result.stdout).join('\n');
    expect(units).toContain(`${unitDirectory}/agentplex-hub.service`);
    expect(units).toContain(`${unitDirectory}/agentplex-server.service`);
    expect(planned(result.stdout, 'node')).toContain(`${prefix}/node`);
    expect(planned(result.stdout, 'package')).toContain(
      `${prefix}/lib/node_modules/@softiesolutions/agentplex`,
    );

    expect(existsSync(join(prefix, 'node', 'bin', 'node'))).toBe(true);
    expect(existsSync(join(prefix, 'lib', 'node_modules', '@softiesolutions', 'agentplex'))).toBe(
      true,
    );
    expect(existsSync(join(unitDirectory, 'agentplex-hub.service'))).toBe(true);
  });

  /**
   * The line the whole flag is drawn along: a runtime comes back from one more
   * run of this script, and a settings file, an identity file and a database do
   * not. So they stay -- and they are printed, because the operator who wants
   * the machine actually empty has no other list.
   */
  it('names the state it is leaving, and where it is', () => {
    const { script, home } = scratch();
    const { prefix } = installedMachine(home);

    const result = run(script, home, ['--uninstall', '--dry-run']);

    expect(result.stdout).toContain('Left in place');
    expect(result.stdout).toContain(`${prefix}/agentplex.env`);
    // The one thing this script has never known, said rather than implied.
    expect(result.stdout).toContain('store');
  });

  it('leaves a Node it has no record of installing, and says why', () => {
    const { script, home } = scratch();
    const { prefix } = installedMachine(home, { recordTheNodeVersion: false });

    const result = run(script, home, ['--uninstall', '--dry-run']);

    expect(result.status).toBe(0);
    expect(planned(result.stdout, 'node')).toBe(
      `${prefix}/node left alone: no record here that this script installed it`,
    );
    // The package it did install still goes, so this is a line about the
    // runtime and not a run that gave up.
    expect(planned(result.stdout, 'package')).toContain(
      `${prefix}/lib/node_modules/@softiesolutions/agentplex`,
    );
  });

  /**
   * npm puts a scoped package under a directory named for the scope, and that
   * directory is npm's rather than this package's -- nothing above removes it
   * by name. Left behind it would make `lib/node_modules` non-empty, the
   * `rmdir` sweep would decline every directory above it, and an uninstall
   * that reported success would leave the prefix standing.
   */
  it('takes the scope directory with the package, so the prefix can go', () => {
    const { script, home } = scratch();
    const { prefix, unitDirectory } = installedMachine(home);
    // The one file in the prefix that is state rather than installation, so
    // that what is asserted below is the sweep and not an empty directory.
    rmSync(join(prefix, 'agentplex.env'));
    // This is the suite's only removal that actually removes, and where the
    // suite is root it runs the script as `nobody` -- so the tree the test
    // process just made has to be one that user can take apart.
    openToEveryone(prefix);
    openToEveryone(unitDirectory);

    const result = run(script, home, ['--uninstall']);

    expect(result.status).toBe(0);
    expect(existsSync(join(prefix, 'lib', 'node_modules', '@softiesolutions'))).toBe(false);
    expect(existsSync(prefix)).toBe(false);
  });

  it('says there is nothing to remove rather than reporting removals it did not make', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--uninstall', '--dry-run']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Nothing of');
    expect(unitLines(result.stdout)).toEqual([]);
  });

  it.skipIf(!suiteIsRoot)('refuses root the way an install does, for the same reason', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--uninstall', '--dry-run'], { asRoot: true });
    // root's HOME is not the operator's, so a root run would be looking in the
    // wrong prefix -- the same fact that makes a root install wrong.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refusing to install as root');
  });

  it('refuses --uninstall --system without root, as an install does', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--uninstall', '--dry-run', '--system']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must run as root');
  });
});

describe('the --role grammar, which is repeatable and takes a pin', () => {
  /**
   * Every accepted form, read as the plan it produces rather than as an exit
   * code: the thing that can go wrong here is a pin landing on the wrong
   * component, and an exit code cannot see that.
   */
  it('installs hub and server at what is current for --role=both', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--role=both']);

    expect(result.status).toBe(0);
    expect(planned(result.stdout, 'package')).toBe(
      `${packageSpecs('both')} into ${home}/.agentplex`,
    );
  });

  it('pins each component independently when both are named', () => {
    const { script, home, versions } = scratch();
    writeReleaseMetadata(versions, 'hub', '1.3.0');
    writeReleaseMetadata(versions, 'server', '1.4.0');

    const result = run(script, home, ['--dry-run', '--role=hub@1.3.0', '--role=server@1.4.0']);

    expect(result.status).toBe(0);
    expect(planned(result.stdout, 'package')).toBe(
      `${packageSpecs('both', { ...CURRENT, hub: '1.3.0', server: '1.4.0' })} ` +
        `into ${home}/.agentplex`,
    );
  });

  /**
   * A hub pinned alone still takes the client, and the client is still resolved
   * rather than pinned with it. They are separate release trains: a version of
   * the hub says nothing about which build of the client is current, which is
   * the whole reason the protocol is checked across the set below.
   */
  it('pins one component and resolves the rest around it', () => {
    const { script, home, versions } = scratch();
    writeReleaseMetadata(versions, 'hub', '1.3.0');

    const result = run(script, home, ['--dry-run', '--role=hub@1.3.0']);

    expect(result.status).toBe(0);
    expect(planned(result.stdout, 'package')).toBe(
      `${packageSpecs('hub', { ...CURRENT, hub: '1.3.0' })} into ${home}/.agentplex`,
    );
  });

  /**
   * A version names one component and `both` names two, so there is nothing
   * `--role=both@1.2.0` could mean that is not either two pins written once or
   * one version imposed on two independent trains -- which is exactly the
   * coupling per-component releases exist to remove.
   */
  it('refuses a version on --role=both, and says how to write what was meant', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--role=both@1.2.0']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--role=both names two components and a version names one');
    expect(result.stderr).toContain('--role=hub@<version> --role=server@<version>');
  });

  /**
   * Not last-wins. Two answers to one question is a contradiction, and the
   * argument is the one this script already makes about `--rle`: installing the
   * wrong thing because something was quietly dropped is worse than not
   * installing.
   */
  it('refuses a component named twice rather than taking the last one', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--role=hub@1.3.0', '--role=hub@1.4.0']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--role names hub twice');
  });

  /** `both` is two components, so it collides with either of them by name. */
  it('refuses a component --role=both already named', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--role=both', '--role=server']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--role names server twice');
  });

  it('refuses a component that is not a role, naming the three that are', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--role=worker@1.0.0']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown role "worker"');
    expect(result.stderr).toContain('hub, server, both');
  });

  /**
   * `cli` and `web` are components and neither is a role, and somebody typing
   * one has a reasonable idea and the wrong word for it -- so they get their
   * own answer rather than falling through to "unknown role".
   */
  it.each(['cli', 'web'])('says why --role=%s is not a role', (component) => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', `--role=${component}`]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`"${component}" is not a role`);
    expect(result.stderr).toContain('--package-version=<version>');
  });

  it('refuses a pin with nothing after the @, which is usually an unset variable', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--role=hub@']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('nothing after it');
    expect(result.stderr).toContain('--role=hub@1.4.0');
  });

  /**
   * The one place this grammar is narrower than an npm range, and it is
   * narrower because delivery changed. A pin names the release tag
   * `hub-v1.3.0`; there is no registry to resolve `1.3` against and no
   * per-version history to resolve it from, so accepting it would mean either
   * guessing which release was meant or building a URL that 404s partway
   * through an install.
   */
  it.each(['1.3', 'latest', '^1.3.0', '1.3.x'])('refuses the pin %s, which names no tag', (pin) => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', `--role=hub@${pin}`]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`"${pin}" is not a version this can install`);
    expect(result.stderr).toContain('hub-v<version>');
  });

  it('refuses the same shape on --package-version', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--package-version=1.3']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not a version this can install');
  });

  /**
   * The role is a property of the machine and the pins are a choice made at
   * install time, so the settings file keeps recording the one and never the
   * other. A machine reinstalled from this file has to come back as the same
   * machine, not at the versions somebody happened to pin two years ago.
   */
  it('records the role in the settings file and never the pins', () => {
    const { home, result, contents } = environmentFileWritten(() => [
      '--role=hub@1.3.0',
      '--role=server@1.4.0',
    ]);

    expect(result.status).toBe(0);
    const written = contents(join(home, '.agentplex', 'agentplex.env'));
    expect(written).toContain('AGENTPLEX_ROLE=both');
    expect(written).not.toContain('1.3.0');
    expect(written).not.toContain('1.4.0');
  });

  /** Two components named one at a time is the same machine as `both`. */
  it('records both when hub and server were named separately', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--role=hub', '--role=server']);

    expect(result.status).toBe(0);
    expect(planned(result.stdout, 'package')).toBe(
      `${packageSpecs('both')} into ${home}/.agentplex`,
    );
    expect(result.stdout).toMatch(/setup\s+(would run .*--role=both|not run: no terminal)/);
  });
});

describe('the versions manifest, which is read off the network and parsed', () => {
  it('names every component it resolved, its versions, and where they came from', () => {
    const { script, home, versions } = scratch();
    const result = run(script, home, ['--dry-run', '--role=hub']);

    expect(planned(result.stdout, 'release')).toBe(
      `cli 1.4.0, hub 1.2.0, web 1.1.0 (from ${versions}/versions.json)`,
    );
    expect(planned(result.stdout, 'protocol')).toContain(`${FIXTURE_PROTOCOL},`);
  });

  it('refuses something that is not a JSON object at all', () => {
    const { script, home, versions } = scratch();
    writeFileSync(join(versions, 'versions.json'), 'not json\n');

    const result = run(script, home, ['--dry-run', '--role=hub']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not a versions manifest');
  });

  /**
   * A missing entry is a release that did not finish, and the machine that
   * carried on would install three quarters of a set. `web` is the one to ask
   * about: it is not a role, so nobody typed it, and it is exactly the entry a
   * reader would be tempted to treat as optional.
   */
  it('refuses a manifest missing a component this machine installs', () => {
    const { script, home, versions } = scratch();
    const { web: _web, ...withoutWeb } = CURRENT;
    writeVersions(versions, withoutWeb);

    const result = run(script, home, ['--dry-run', '--role=hub']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('names no web');
  });

  it.each([
    ['a version that is not one', { cli: 'latest', hub: '1.2.0', web: '1.1.0' }, 'not a version'],
  ])('refuses %s', (_name, entries, message) => {
    const { script, home, versions } = scratch();
    writeVersions(versions, entries);

    const result = run(script, home, ['--dry-run', '--role=hub']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it('refuses an entry with no protocol number', () => {
    const { script, home, versions } = scratch();
    writeFile(
      join(versions, 'versions.json'),
      JSON.stringify({
        cli: { version: '1.4.0' },
        hub: { version: '1.2.0', protocol: FIXTURE_PROTOCOL },
        web: { version: '1.1.0', protocol: FIXTURE_PROTOCOL },
      }),
    );

    const result = run(script, home, ['--dry-run', '--role=hub']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no protocol number');
  });

  /**
   * The tripwire, and the reason it is a tripwire rather than a resolver. A
   * protocol change releases every affected component together, so the entries
   * always agree; a set that does not is a release process that broke, and
   * working out "the newest set that happens to agree" would paper over exactly
   * the mistake this is here to report.
   */
  it('refuses a set whose components disagree, naming both numbers', () => {
    const { script, home, versions } = scratch();
    writeVersions(versions, CURRENT, { hub: FIXTURE_PROTOCOL + 1 });

    const result = run(script, home, ['--dry-run', '--role=hub']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`cli speaking protocol ${FIXTURE_PROTOCOL}`);
    expect(result.stderr).toContain(`hub speaking protocol ${FIXTURE_PROTOCOL + 1}`);
    expect(result.stderr).toContain('nothing has been installed');
  });

  /**
   * Asked of what this machine installs and not of the whole manifest. A hub
   * install refused because the `server` entry disagrees would be refusing over
   * a package this machine will never download.
   */
  it('ignores a disagreement in a component this machine does not install', () => {
    const { script, home, versions } = scratch();
    writeVersions(versions, CURRENT, { server: FIXTURE_PROTOCOL + 1 });

    const result = run(script, home, ['--dry-run', '--role=hub']);

    expect(result.status).toBe(0);
  });

  /**
   * The rule `ensure_node` already keeps about the Node release file. "Would
   * install 1.4.0" is a claim a run that performed no download cannot make, so
   * the plan says the question went unasked instead of printing a guess.
   */
  it('asks nothing at all in a dry run with nowhere local to read it from', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--role=hub'], {
      environment: { AGENTPLEX_VERSIONS: '' },
    });

    expect(result.status).toBe(0);
    expect(planned(result.stdout, 'release')).toContain('a dry run downloads nothing');
    expect(planned(result.stdout, 'protocol')).toContain('not checked');
    // No URL was built for a version this run never learned: the download root
    // is named, and no tag inside it is. Asked of what npm is handed, because
    // the rest of the line is a prefix this suite chose and nothing the script
    // decided.
    const { source } = packagePlan(result.stdout);
    expect(source).not.toContain('-v');
    expect(source).toContain('cli hub web from');
  });

  /**
   * The same claim, made from a scratch directory that sets the trap on
   * purpose.
   *
   * `agentplex-install-vJKSyf` is a directory `mkdtempSync` really returned.
   * Its suffix comes from the clock, so the failure was always there and only
   * sometimes observed -- two of six container runs, each reported as an
   * argument-handling regression. Stating the name is what turns that into a
   * test: the assertion above passes on a lucky clock either way, and this one
   * cannot.
   */
  it('says nothing about a version from a scratch directory named like a flag', () => {
    const { script, home } = scratch('agentplex-install-vJKSyf');

    const result = run(script, home, ['--dry-run', '--role=hub'], {
      environment: { AGENTPLEX_VERSIONS: '' },
    });

    expect(result.status).toBe(0);
    // The trap is set: the rendered line does carry `-v`, in the prefix.
    expect(planned(result.stdout, 'package')).toContain('-v');
    // And the half that is the script's answer does not.
    expect(packagePlan(result.stdout).source).not.toContain('-v');
  });

  /**
   * Nothing to resolve, so nothing is read. The manifest describes what is
   * current, and a run that asked for something else has nothing to learn from
   * it.
   */
  it('is not read when every component this machine installs is pinned', () => {
    const { script, home, versions } = scratch();
    writeReleaseMetadata(versions, 'cli', '1.2.3');
    writeReleaseMetadata(versions, 'server', '1.4.0');
    rmSync(join(versions, 'versions.json'));

    const result = run(script, home, [
      '--dry-run',
      '--role=server@1.4.0',
      '--package-version=1.2.3',
    ]);

    expect(result.status).toBe(0);
    expect(planned(result.stdout, 'release')).toContain('every component pinned');
    expect(planned(result.stdout, 'package')).toBe(
      `${packageSpecs('server', { cli: '1.2.3', server: '1.4.0' })} into ${home}/.agentplex`,
    );
  });
});

describe('the protocol a pinned release speaks, checked before anything is installed', () => {
  /**
   * The judgement call in this grammar. `versions.json` describes what is
   * current and a pin is by definition a request for something else, so the
   * only place a pinned release's protocol exists is at its own tag. Installing
   * first and checking after ends at the machine this is trying to prevent: a
   * hub and a server that are installed, running and unable to pair.
   */
  it('refuses a pinned component that speaks a different protocol', () => {
    const { script, home, versions } = scratch();
    writeReleaseMetadata(versions, 'hub', '1.3.0', FIXTURE_PROTOCOL + 1);

    const result = run(script, home, ['--dry-run', '--role=hub@1.3.0']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`cli speaking protocol ${FIXTURE_PROTOCOL}`);
    expect(result.stderr).toContain(`hub speaking protocol ${FIXTURE_PROTOCOL + 1}`);
  });

  /**
   * A pin naming a release nobody published is the other thing this catches,
   * and it catches it before the first tarball rather than at a 404 partway
   * through an npm install.
   */
  it('stops when the pinned release has no metadata beside it', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--role=hub@9.9.9']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`hub-v9.9.9/${metadataAsset(HUB)}`);
  });

  /** Metadata served from the wrong tag parses perfectly and describes something else. */
  it('refuses metadata describing another component', () => {
    const { script, home, versions } = scratch();
    writeFile(
      releaseMetadataPath(versions, 'hub', '1.3.0'),
      JSON.stringify({ component: 'server', version: '1.3.0', protocol: FIXTURE_PROTOCOL }),
    );

    const result = run(script, home, ['--dry-run', '--role=hub@1.3.0']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('describes the server component');
  });
});

describe('the release assets, which two directories have to agree about', () => {
  /**
   * The script builds a download URL out of a component and an asset name, and
   * the assembler decides what that asset is called. Neither can read the
   * other, so the tie is a test: a rename in `assemble-package.ts` fails here
   * rather than at a 404 on somebody's machine.
   */
  it.each(PACKAGES.map((target) => [target.component, target.asset] as const))(
    'builds the %s URL against the asset the assembler names',
    (component, asset) => {
      expect(releaseUrl(component, '1.0.0')).toContain(`/${component}-v1.0.0/${asset}`);
    },
  );

  it('reads the pinned metadata at the path the release publishes it at', () => {
    const { script, home, versions } = scratch();
    writeReleaseMetadata(versions, 'hub', '1.3.0');

    const result = run(script, home, ['--dry-run', '--role=hub@1.3.0']);

    expect(result.status).toBe(0);
    // Written at the assembler's own name for the metadata asset, inside the
    // tag directory -- which is the shape of the published URL with the host
    // taken off the front.
    expect(existsSync(join(versions, 'hub-v1.3.0', metadataAsset(HUB)))).toBe(true);
  });
});

describe('the shape a prefix has to have, because --uninstall takes one', () => {
  /**
   * `--uninstall --prefix=...` is a removal driven by a flag, so the flag is
   * parsed rather than taken. These three are refused for every run and not
   * only for the uninstall: an install that put a tree somewhere an uninstall
   * would decline to touch is its own trap.
   */
  it('refuses a top-level prefix, which is a directory of the machine itself', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--uninstall', '--dry-run', '--prefix=/usr']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('at least two directories deep');
  });

  it('refuses a prefix with nothing after it, which is usually an unset variable', () => {
    const { script, home } = scratch();
    // Without --uninstall in it, so that the refusal is the prefix's and not
    // the flag's: an empty value used to fall silently through to the default
    // prefix, which is not the directory the command that produced it meant.
    const result = run(script, home, ['--dry-run', '--prefix=']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('nothing after it');
  });

  it('refuses a prefix that walks through ..', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', `--prefix=${home}/.agentplex/../../etc`]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('..');
  });

  it('trims a trailing slash rather than carrying it into every path it prints', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--role=server', `--prefix=${home}/custom/`]);
    expect(result.status).toBe(0);
    expect(planned(result.stdout, 'package')).toBe(`${packageSpecs('server')} into ${home}/custom`);
  });
});

describe('the Node major the script installs', () => {
  /**
   * The major is named twice and cannot be named once: a shell script has no
   * way to read a constant out of a package.json, and the manifest has no way
   * to read one out of the script. So the tie is a test.
   *
   * Both directions fail quietly on a real machine rather than here. Raise the
   * manifest floor alone and the script installs a runtime the published
   * package then refuses. Raise the script alone and the package keeps
   * accepting a runtime nobody installs onto a fresh machine or tests against.
   */
  it('matches the major the root manifest declares in engines.node', () => {
    const source = readFileSync(scriptPath, 'utf8');
    const script = /^readonly NODE_MAJOR='(\d+)'$/m.exec(source)?.[1];
    expect(script, `no readonly NODE_MAJOR='<major>' line in ${scriptPath}`).toBeDefined();

    const { engines } = enginesSchema.parse(JSON.parse(readFileSync(rootManifest, 'utf8')));
    // A range, not a number: `>=24` is the only shape this tie knows how to
    // read, and a different one is a decision to make deliberately rather than
    // a case to guess at, so it fails instead of passing on a major it did not
    // actually extract.
    const manifest = /^>=(\d+)$/.exec(engines.node)?.[1];
    expect(
      manifest,
      `engines.node in ${rootManifest} is '${engines.node}', which is not the '>=<major>' ` +
        'shape this test reads; widen it deliberately if that shape has changed',
    ).toBeDefined();

    expect(
      script,
      `the Node major disagrees between two places that have to agree: ` +
        `NODE_MAJOR='${script}' in ${scriptPath} and engines.node '${engines.node}' in ` +
        `${rootManifest}. Raise both or neither.`,
    ).toBe(manifest);
  });
});
