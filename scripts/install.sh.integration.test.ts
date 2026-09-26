import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  serializeVersionsManifest,
  updateVersionsManifest,
  type ReleaseProtocol,
  type VersionsManifest,
} from '@agentplex/release';
import { PIN_GRAMMAR_CASES, SERIES_RESOLUTION_CASES } from '@agentplex/release/testing';
import { CLI_PACKAGE, ENTRYPOINT, PACKAGES } from './assemble-package.js';

/**
 * `install.sh`, exercised the two ways it can be exercised without a machine to
 * throw away: `--dry-run`, which resolves every decision the script still makes
 * and performs none, and `--print-unit`, which it answers by handing over.
 *
 * The script is the bootstrap now. It gets a runtime, a toolchain, a service
 * account and the command's own package onto the machine, and then hands the
 * rest to `agentplex install`: the role's other packages, the protocol check,
 * ownership, the settings file and the units are that command's, and its own
 * suites hold them. What is asserted here is the script's half, and the
 * handover itself -- against a stand-in for the command that prints the
 * arguments it was given, because the command's behaviour is not this suite's
 * to assert.
 *
 * The rest -- downloading a runtime, installing a toolchain, creating a service
 * account, and the real command taking over -- is checked in the
 * `bootstrap-check` Docker stage, on a stock `debian:bookworm-slim`, because
 * those steps are only true against a machine that has none of them.
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
// The third place the same URL is printed: the first-run wizard offers it as a
// command to copy, so a reader who never opens a README still gets the fetch
// that resolves. Read as a file rather than imported, because this suite runs
// outside that app and the tie being tested is that the string is there.
const clientInstallCommand = join(
  workspaceRoot,
  'apps',
  'web',
  'src',
  'onboarding',
  'install-command.ts',
);
const rootManifest = join(workspaceRoot, 'package.json');
const releaseWorkflow = join(workspaceRoot, '.github', 'workflows', 'release.yml');
// What the release workflow's `v1` job runs to push the branch.
const advanceScript = join(scriptsDirectory, 'advance-v1.sh');
// The two Docker stages that run this script against a machine it can really
// install onto, and the two files that have to agree about how they are built.
const checkWorkflow = join(workspaceRoot, '.github', 'workflows', 'ci.yml');
const composeFile = join(workspaceRoot, 'docker-compose.test.yml');

/**
 * Only `engines`. The rest of the root manifest is somebody else's to change --
 * the package is being renamed on another branch -- and a schema that read more
 * than the one field this tie is about would fail on edits that have nothing to
 * do with the Node major.
 */
const enginesSchema = z.object({ engines: z.object({ node: z.string() }) });

/**
 * One script, for the same reason: the rest of the manifest is somebody else's
 * to change, and a schema that read more than the command this tie is about
 * would fail on edits that have nothing to do with it.
 */
const bootstrapScriptSchema = z.object({
  scripts: z.object({ 'docker:bootstrap': z.string() }),
});

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
 * meaning here beyond "they agree": this script never compares it with either
 * leg's constant, it only asks whether the components a machine installs say
 * the same thing on each leg.
 */
const CURRENT: Readonly<Record<string, string>> = {
  cli: '1.4.0',
  hub: '1.2.0',
  server: '1.5.0',
  web: '1.1.0',
};

const FIXTURE_PROTOCOL = 3;

/**
 * The legs each component's package records, as `assemble-package.ts` writes
 * them: the hub and the client both, the server its own, the CLI none.
 */
const COMPONENT_LEGS: Readonly<Record<string, readonly ('client' | 'server')[]>> = {
  cli: [],
  hub: ['client', 'server'],
  server: ['server'],
  web: ['client', 'server'],
};

/**
 * What a component's release records, given either its legs outright or one
 * number for every leg it speaks -- which is what a release that bumped nothing
 * but its own version looks like, and what most of these tests mean.
 */
function legsOf(component: string, protocol: number | ReleaseProtocol): ReleaseProtocol {
  if (typeof protocol !== 'number') return protocol;
  return Object.fromEntries((COMPONENT_LEGS[component] ?? []).map((leg) => [leg, protocol]));
}

/**
 * The manifest a run of releases leaves on the `v1` branch, as a fixture.
 *
 * Folded through `updateVersionsManifest`, which is the code the release job
 * really writes this file with, rather than assembled out of an object literal.
 * A hand-built fixture can be a shape no release could ever produce, and this
 * one was: the prerelease test below described a history the workflow had no
 * way to emit, so it passed against a file that could not exist. Going through
 * the writer means a fixture is a manifest some sequence of releases would
 * really leave behind, and that `current` is whatever that code decides rather
 * than whatever a test asserted.
 *
 * `history` is what a pin resolves against. The manifest lists every release a
 * component has published and the installer refuses a pin it does not list, so
 * a test about a pin says which release it is pinning to rather than naming one
 * out of the air. Those releases are published *before* the one in `latest`,
 * which is the order a fixture has to state because the merge is order
 * sensitive in exactly one way -- a re-cut tag overwrites its own protocol.
 */
function writeVersions(
  directory: string,
  latest: Readonly<Record<string, string>> = CURRENT,
  options: {
    /** The protocol each component's last release speaks; see `legsOf`. */
    readonly protocols?: Readonly<Record<string, number | ReleaseProtocol>>;
    /** Releases published before it, as `<version>: <protocol>`. */
    readonly history?: Readonly<Record<string, Readonly<Record<string, number | ReleaseProtocol>>>>;
  } = {},
): void {
  let manifest: VersionsManifest = {};
  for (const [component, version] of Object.entries(latest)) {
    for (const [older, protocol] of Object.entries(options.history?.[component] ?? {})) {
      manifest = updateVersionsManifest(manifest, component, {
        version: older,
        protocol: legsOf(component, protocol),
      });
    }
    manifest = updateVersionsManifest(manifest, component, {
      version,
      protocol: legsOf(component, options.protocols?.[component] ?? FIXTURE_PROTOCOL),
    });
  }
  writeFile(join(directory, 'versions.json'), serializeVersionsManifest(manifest).trimEnd());
}

/** The same manifest, with releases published before each component's last one. */
function writeHistory(
  directory: string,
  history: Readonly<Record<string, Readonly<Record<string, number | ReleaseProtocol>>>>,
): void {
  writeVersions(directory, CURRENT, { history });
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

/**
 * What the script's own `package` step hands npm: the command's tarball, and
 * nothing else. Every other package a role needs is `agentplex install`'s to
 * resolve and fetch.
 */
function cliSpec(version = CURRENT['cli'] ?? ''): string {
  return releaseUrl('cli', version);
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

/** The directory every package of ours lands in, under one prefix. */
function scopeDirectory(prefix: string): string {
  return join(prefix, 'lib', 'node_modules', '@softiesolutions');
}

/**
 * The directory each component's package lands in: its published name with
 * the scope taken off, which is also what `npm pack` flattens it to.
 */
const PACKAGE_DIRECTORIES: Readonly<Record<string, string>> = {
  cli: 'agentplex',
  hub: 'agentplex-hub',
  server: 'agentplex-server',
  web: 'agentplex-web',
};

/** The flags every component's npm install is given after its `--prefix`. */
function npmInstallFlags(globalconfig: string): string {
  return (
    `--globalconfig=${globalconfig} --omit=dev --ignore-scripts=false --package-lock=true ` +
    '--no-save --install-strategy=hoisted --no-audit --no-fund'
  );
}

/**
 * Four tarballs shaped the way `npm pack` shapes ours: everything under
 * `package/`, a manifest and a shrinkwrap at its root, and the command's entry
 * packed `-rw-r--r--`, which is how the real one is packed.
 *
 * Real archives rather than empty files, because the unpack is under test, and
 * an empty file would fail it for a reason that is not the one being asked.
 */
function packTarballs(directory: string): void {
  mkdirSync(directory, { recursive: true });
  for (const name of Object.values(PACKAGE_DIRECTORIES)) {
    const staging = mkdtempSync(join(tmpdir(), 'agentplex-pack-'));
    temporaries.push(staging);
    const root = join(staging, 'package');
    mkdirSync(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: `@softiesolutions/${name}`, version: '0.0.0' }),
    );
    writeFileSync(join(root, 'npm-shrinkwrap.json'), JSON.stringify({ lockfileVersion: 3 }));
    if (name === PACKAGE_DIRECTORIES['cli']) {
      const entry = join(root, ENTRYPOINT);
      mkdirSync(dirname(entry), { recursive: true });
      writeFileSync(entry, '#!/usr/bin/env node\n');
      chmodSync(entry, 0o644);
    }
    const packed = spawnSync(
      'tar',
      ['-czf', join(directory, `softiesolutions-${name}-0.0.0.tgz`), '-C', staging, 'package'],
      // No AppleDouble entries: a Mac's tar otherwise packs a `._` file beside
      // anything carrying an extended attribute.
      { encoding: 'utf8', env: { ...process.env, COPYFILE_DISABLE: '1' } },
    );
    if (packed.status !== 0) throw new Error(`tar could not pack ${name}: ${packed.stderr}`);
  }
}

/**
 * An npm that records every call and installs nothing.
 *
 * `config get` answers a stand-in path, so the test can see that exact path
 * handed back as `--globalconfig`. `install` refuses a directory holding no
 * shrinkwrap -- which is what proves the tarball was unpacked into the
 * directory npm was pointed at -- marks that directory, and fails outright for
 * the one package it is told to fail.
 */
function npmShim(directory: string): void {
  mkdirSync(directory, { recursive: true });
  const executable = join(directory, 'npm');
  writeFileSync(
    executable,
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >>"$NPM_SHIM_LOG"',
      'if [ "$1" = config ]; then printf "%s\\n" "$NPM_SHIM_GLOBALCONFIG"; exit 0; fi',
      "prefix=''",
      "previous=''",
      'for argument in "$@"; do',
      '  if [ "$previous" = --prefix ]; then prefix="$argument"; fi',
      '  previous="$argument"',
      'done',
      'case "$prefix" in',
      '  */"$NPM_SHIM_FAIL".new) echo "npm error stand-in failure in $prefix" >&2; exit 1 ;;',
      'esac',
      '[ -f "$prefix/npm-shrinkwrap.json" ] || { echo "no shrinkwrap in $prefix" >&2; exit 1; }',
      'mkdir -p "$prefix/node_modules"',
      ': >"$prefix/node_modules/.installed"',
      '',
    ].join('\n'),
  );
  chmodSync(executable, 0o755);
}

/**
 * `install_package` alone, for real, against tarballs this suite packed and an
 * npm that installs nothing.
 *
 * The same `source` trick the settings file uses, and here it is the only way
 * in: a dry run stops before the step under test, and a whole run would
 * download a runtime and compile an addon. Everything the step reads comes
 * from the real resolvers -- the role table, the layout, the AGENTPLEX_PACKAGE
 * seam -- except npm, which is put where `npm_command` looks first.
 */
function packagesInstalled(options: {
  readonly role: string;
  /** The directory name whose npm install fails, when one should. */
  readonly failing?: string;
  /** What the prefix held before the run, made by the test. */
  readonly before?: (prefix: string) => void;
}): {
  readonly prefix: string;
  readonly result: RunResult;
  readonly npmCalls: readonly string[];
  readonly globalconfig: string;
} {
  const { script, home } = scratch();
  const prefix = join(home, '.agentplex');
  const packages = join(home, 'package');
  const shims = join(home, 'npm-shim');
  const log = join(home, 'npm.log');
  const globalconfig = join(home, 'stand-in-npmrc');
  packTarballs(packages);
  npmShim(shims);
  if (options.before !== undefined) {
    options.before(prefix);
    // Made by the test process, which is root in the check container, and
    // taken apart by the script, which is `nobody` there.
    openToEveryone(prefix);
  }

  const library = sourceableLibrary(script);
  const driver = `${script}.package`;
  writeFileSync(
    driver,
    [
      `source ${quote(library)}`,
      `parse_arguments --role=${options.role} --no-setup`,
      'resolve_layout',
      `NODE_DIR=${quote(shims)}`,
      `DRY_RUN='no'`,
      'resolve_release',
      'install_package',
      '',
    ].join('\n'),
  );
  chmodSync(driver, 0o755);

  const result = run(driver, home, [], {
    environment: {
      AGENTPLEX_PACKAGE: packages,
      NPM_SHIM_LOG: log,
      NPM_SHIM_GLOBALCONFIG: globalconfig,
      NPM_SHIM_FAIL: options.failing ?? '',
    },
  });
  const npmCalls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  return { prefix, result, npmCalls, globalconfig };
}

/**
 * An installed tree as an earlier run left it: a manifest, and a marker the new
 * package does not carry, so a test can tell the old tree from the new one.
 */
function oldTree(prefix: string, name: string): string {
  const tree = join(scopeDirectory(prefix), name);
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, 'package.json'), '{}');
  writeFileSync(join(tree, 'old-marker'), '');
  return tree;
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
 * A stand-in for the command, where the script looks for it: the entry under
 * `<prefix>/lib/node_modules/@softiesolutions/agentplex`, beside the manifest
 * whose version the script reads.
 *
 * It prints the arguments it was given and the one variable the handover has
 * to pass through, and nothing else, because what is under test is what the
 * script hands it. `install --help` answers with `help`, which is how a
 * command too old to have `install` is stood in for, and every other call
 * exits with `exit`. The script runs it through the Node this run settled on,
 * which for the suite is the one on PATH -- plain CommonJS, so any Node of the
 * right major runs it.
 */
function fakeCli(
  prefix: string,
  version: string,
  options: { readonly help?: number; readonly exit?: number } = {},
): void {
  const tree = join(scopeDirectory(prefix), 'agentplex');
  const entry = join(tree, ENTRYPOINT);
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(join(tree, 'package.json'), JSON.stringify({ name: CLI_PACKAGE, version }));
  writeFileSync(
    entry,
    [
      'const argv = process.argv.slice(2);',
      `if (argv[0] === 'install' && argv[1] === '--help') process.exit(${String(options.help ?? 0)});`,
      "console.log(`fake-cli ${argv.join(' ')}`);",
      "console.log(`fake-cli AGENTPLEX_VERSIONS=${process.env.AGENTPLEX_VERSIONS ?? ''}`);",
      `process.exit(${String(options.exit ?? 0)});`,
      '',
    ].join('\n'),
  );
  openToEveryone(prefix);
}

/**
 * `hand_over` alone, as a real run reaches it: after the command's package has
 * landed, with the version it resolved. The same `source` trick the package
 * step uses, because a whole run would download a runtime first.
 */
function handedOver(
  args: readonly string[],
  cli: { readonly version: string; readonly help?: number; readonly exit?: number },
): { readonly home: string; readonly versions: string; readonly result: RunResult } {
  const { script, home, versions } = scratch();
  fakeCli(join(home, '.agentplex'), cli.version, cli);

  const library = sourceableLibrary(script);
  const driver = `${script}.handover`;
  writeFileSync(
    driver,
    [
      `source ${quote(library)}`,
      `parse_arguments ${args.map(quote).join(' ')}`,
      'resolve_layout',
      `DRY_RUN='no'`,
      `CLI_VERSION=${quote(cli.version)}`,
      'hand_over',
      '',
    ].join('\n'),
  );
  chmodSync(driver, 0o755);

  return { home, versions, result: run(driver, home, []) };
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
  it('installs the command into the user prefix, for the user who ran it', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--role=server']);

    expect(result.status).toBe(0);
    expect(planned(result.stdout, 'package')).toBe(`${cliSpec()} into ${home}/.agentplex`);
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
   * component in its name can mean. It is also the one pin this script still
   * resolves, because the command is the one package it still installs.
   */
  it('pins the command it was given a version for', () => {
    const { script, home, versions } = scratch();
    writeHistory(versions, { cli: { '1.2.3': FIXTURE_PROTOCOL } });

    const result = run(script, home, ['--dry-run', '--role=hub', '--package-version=1.2.3']);

    expect(result.status).toBe(0);
    expect(planned(result.stdout, 'package')).toBe(`${cliSpec('1.2.3')} into ${home}/.agentplex`);
  });

  /**
   * The two halves of what used to be one constant, asserted together because
   * the failure this guards against is one of them moving without the other.
   * The unscoped `agentplex` on npm is somebody else's, so the registry entry
   * is scoped; a `bin` key is not a package name, so the binary in the prefix
   * and every word an operator reads stay `agentplex`.
   */
  it('names the scoped package to npm and the plain command to the operator', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--role=both']);

    expect(planned(result.stdout, 'package')).toContain(
      `/cli-v${CURRENT['cli'] ?? ''}/agentplex.tgz`,
    );
    expect(planned(result.stdout, 'install')).toContain(
      `${home}/.agentplex/bin/agentplex install --dry-run --role=both`,
    );
    // The scope reaches only npm's own directory names, never a word this
    // script chose.
    expect(planned(result.stdout, 'install')).not.toContain('softiesolutions');
  });

  /**
   * Whatever the role, the script's own package step is the command's. A
   * hub's client, a server's native addon and every pin on them are what the
   * command resolves and installs once it is here, so a role changes what the
   * handover is told and nothing about what this step fetches.
   */
  it.each(['hub', 'server', 'both'])(
    'installs the command alone for --role=%s, and leaves the rest to it',
    (role) => {
      const { script, home } = scratch();
      const { source } = packagePlan(run(script, home, ['--dry-run', `--role=${role}`]).stdout);

      expect(source.trim()).toBe(cliSpec());
      for (const component of ['hub', 'server', 'web']) {
        expect(source, component).not.toContain(`/${component}-v`);
      }
    },
  );

  /**
   * AGENTPLEX_PACKAGE is how the container check installs a build that has
   * never been published: a directory of packed tarballs rather than one spec.
   * The script takes the command's out of it; the command, handed the same
   * variable, takes the rest.
   */
  it('installs the command tarball in the directory AGENTPLEX_PACKAGE names', () => {
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

    // The `[0-9]` in the script's pattern is what keeps the command's own
    // tarball from also matching the hub, the server and the client: every one
    // of those names starts with the command's.
    expect(line.trim()).toBe(`${packages}/softiesolutions-agentplex-0.0.0.tgz`);
    expect(line).not.toContain('https://');
  });

  /**
   * The command's tarball is the one this script cannot do without, so a
   * directory missing it stops the run here. A directory missing the hub's is
   * the command's to refuse, and it refuses it in the same sentence.
   */
  it("stops when the directory does not hold the command's tarball", () => {
    const { script, home } = scratch();
    const packages = join(home, 'package');
    mkdirSync(packages, { recursive: true });
    writeFileSync(join(packages, 'softiesolutions-agentplex-hub-0.0.0.tgz'), '');

    const result = run(script, home, ['--dry-run', '--role=hub'], {
      environment: { AGENTPLEX_PACKAGE: packages },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('no softiesolutions-agentplex-<version>.tgz');
  });

  /**
   * How the command lands, as a line of its own beside the `package` line: it
   * is unpacked beside the tree it replaces and installed there against the
   * shrinkwrap it carries -- the only way npm reads one -- then moved into
   * place and linked.
   */
  it('plans the command as staged, installed against its shrinkwrap, then moved', () => {
    const { script, home } = scratch();
    const prefix = `${home}/.agentplex`;
    const result = run(script, home, ['--dry-run', '--role=server']);

    expect(result.status).toBe(0);
    const method = planned(result.stdout, 'method') ?? '';
    expect(method).toContain(`unpack into ${scopeDirectory(prefix)}/agentplex.new;`);
    for (const name of ['agentplex-hub', 'agentplex-server', 'agentplex-web']) {
      expect(method, name).not.toContain(`/${name}.new`);
    }

    const install = method.indexOf('npm install --omit=dev');
    const shrinkwrap = method.indexOf('npm-shrinkwrap.json');
    const link = method.indexOf(
      `link ${prefix}/bin/agentplex -> ../lib/node_modules/${CLI_PACKAGE}/${ENTRYPOINT}`,
    );
    expect(install).toBeGreaterThan(0);
    expect(shrinkwrap).toBeGreaterThan(install);
    expect(link).toBeGreaterThan(shrinkwrap);
    expect(method).toContain('move it into place');
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
    // The command that writes the settings file setup then reads is handed the
    // same prefix, in the same plan.
    expect(planned(result.stdout, 'install')).toContain(`--prefix=${prefix}`);
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
 * The handover, which is the new half of this script.
 *
 * Everything the script used to do after the runtime -- the role's other
 * packages, the protocol check, ownership, the settings file and the units --
 * is `agentplex install`'s now, run through the interpreter this run settled on
 * with the operator's own arguments. What these assert is that it is handed the
 * right words, that the variables reach it, and what a dry run says when there
 * is no command yet to hand to.
 */
describe('handing over to agentplex install', () => {
  /**
   * A first dry run has no command to run: nothing has been installed, and a
   * dry run installs nothing. So it plans its own steps -- the command's
   * release, the toolchain, the runtime and the command's package -- and names
   * the command that plans the rest, with the arguments it would be given, as
   * what it would have run. It does not refuse a hub pin the manifest does not
   * list: resolving that is the command's, and the command is what refuses it.
   */
  it('plans its own steps on an empty prefix, and names the command that plans the rest', () => {
    const { script, home, versions } = scratch();
    const prefix = join(home, 'custom');

    const result = run(script, home, ['--dry-run', '--role=hub@1.3.0', `--prefix=${prefix}`]);

    expect(result.status).toBe(0);
    expect(planned(result.stdout, 'release')).toBe(`cli 1.4.0 (from ${versions}/versions.json)`);
    expect(planned(result.stdout, 'toolchain')).toBeDefined();
    expect(planned(result.stdout, 'node')).toBeDefined();
    expect(planned(result.stdout, 'package')).toBe(`${cliSpec()} into ${prefix}`);
    expect(planned(result.stdout, 'install')).toContain(
      `${prefix}/bin/agentplex install --dry-run --role=hub@1.3.0 --prefix=${prefix}`,
    );
    expect(planned(result.stdout, 'install')).toContain('not run');
    // The lines the command prints, and the script no longer does.
    for (const label of ['client protocol', 'server protocol', 'ownership', 'settings', 'unit']) {
      expect(planned(result.stdout, label), label).toBeUndefined();
    }
    expect(result.stdout).not.toContain('fake-cli');
    expect(result.stdout).toContain('dry run: nothing above was done.');
    expect(readdirSync(home)).toEqual([]);
  });

  /**
   * As typed, and only the ones that are the command's: `--role`, each with its
   * pin, `--package-version`, `--prefix` and `--system`. `--no-setup` is the
   * script's, because handing over to setup is. The default role is the
   * command's default too, so nothing is added for it.
   */
  it('passes the operator arguments through as typed, and keeps its own', () => {
    const { script, home, versions } = scratch();
    writeHistory(versions, { cli: { '1.2.3': FIXTURE_PROTOCOL } });

    const pinned = run(script, home, [
      '--dry-run',
      '--no-setup',
      '--role=hub',
      '--role=server@1.5',
      '--package-version=1.2.3',
    ]);
    expect(pinned.status).toBe(0);
    expect(planned(pinned.stdout, 'install')).toContain(
      'agentplex install --dry-run --role=hub --role=server@1.5 --package-version=1.2.3 ',
    );
    expect(planned(pinned.stdout, 'install')).not.toContain('--no-setup');

    const bare = run(script, home, ['--dry-run']);
    expect(planned(bare.stdout, 'install')).toContain('agentplex install --dry-run ');
    expect(planned(bare.stdout, 'install')).not.toContain('--role');
  });

  /**
   * A re-run: the command is already in the prefix, at the version this run
   * would install, so there is something to ask. The dry run asks it for the
   * rest of the plan, and the manifest seam reaches it, because the plan it
   * prints is read out of the same file.
   */
  it('runs agentplex install --dry-run where the command is here at that version', () => {
    const { script, home, versions } = scratch();
    const prefix = join(home, '.agentplex');
    fakeCli(prefix, CURRENT['cli'] ?? '');

    const result = run(script, home, ['--dry-run', '--role=hub']);

    expect(result.status).toBe(0);
    expect(planned(result.stdout, 'install')).toBe(
      `${prefix}/bin/agentplex install --dry-run --role=hub`,
    );
    expect(result.stdout).toContain('fake-cli install --dry-run --role=hub\n');
    expect(result.stdout).toContain(`fake-cli AGENTPLEX_VERSIONS=${versions}\n`);
    // Setup is still the script's, so its line still follows.
    expect(planned(result.stdout, 'setup')).toBeDefined();
  });

  /**
   * A command at another version is not the command this run would leave
   * here, so its plan would be the plan of a different install. It is not
   * asked, and the line says why.
   */
  it('does not ask a command at another version for the plan', () => {
    const { script, home } = scratch();
    fakeCli(join(home, '.agentplex'), '1.3.0');

    const result = run(script, home, ['--dry-run', '--role=hub']);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('fake-cli');
    expect(planned(result.stdout, 'install')).toContain('not run');
  });

  /**
   * `--print-unit` renders nothing in bash any more: the units are the
   * command's, and so is the one renderer. With nothing installed there is no
   * command to ask, so the run stops and names the one that renders them. It
   * still reaches no network on the way.
   */
  it('stops --print-unit with nothing installed, naming agentplex install --print-unit', () => {
    const { script, home } = scratch();

    const result = run(script, home, ['--print-unit', '--role=both'], {
      environment: { AGENTPLEX_VERSIONS: '' },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${home}/.agentplex/bin/agentplex install --print-unit --role=both`,
    );
    expect(result.stdout).toBe('');
    expect(readdirSync(home)).toEqual([]);
  });

  it('hands --print-unit to the command when it is here, with the arguments as typed', () => {
    const { script, home } = scratch();
    const prefix = join(home, 'custom');
    fakeCli(prefix, '1.3.0');

    const result = run(script, home, ['--print-unit', '--role=server', `--prefix=${prefix}`], {
      environment: { AGENTPLEX_VERSIONS: '' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `fake-cli install --print-unit --role=server --prefix=${prefix}\n`,
    );
  });

  /**
   * A real run, from the point the command's package has landed: the command
   * is asked whether it has `install`, then run with the operator's arguments
   * and the environment the script was started with.
   */
  it('runs agentplex install with the arguments and the environment it was given', () => {
    const { home, versions, result } = handedOver(['--role=server', '--no-setup'], {
      version: '1.4.0',
    });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(planned(result.stdout, 'install')).toBe(
      `${home}/.agentplex/bin/agentplex install --role=server`,
    );
    expect(result.stdout).toContain('fake-cli install --role=server\n');
    expect(result.stdout).toContain(`fake-cli AGENTPLEX_VERSIONS=${versions}\n`);
  });

  /**
   * A pin can name a release older than the handover. That command has no
   * `install`, and running it would be a usage error from a program the
   * operator did not know they were asking; the script says what it installed
   * and what to pin instead.
   */
  it('stops, naming the version, when the command it installed has no install', () => {
    const { result } = handedOver(['--role=server', '--no-setup'], { version: '1.4.0', help: 2 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('agentplex 1.4.0');
    expect(result.stderr).toContain('agentplex install');
    expect(result.stderr).toContain('--package-version');
    expect(result.stdout).not.toContain('fake-cli install --role=server');
  });

  it('stops with the exit the command stopped with, and says the command is still here', () => {
    const { home, result } = handedOver(['--role=server', '--no-setup'], {
      version: '1.4.0',
      exit: 1,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('fake-cli install --role=server\n');
    expect(result.stdout).toContain(`${home}/.agentplex/bin/agentplex`);
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

  it.skipIf(!suiteIsRoot)('creates the service account before it hands over', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--system'], { asRoot: true });
    const lines = result.stdout.split('\n');

    expect(planned(result.stdout, 'account')).toContain('create agentplex');
    // Order, not just presence. `agentplex install --system` gives this account
    // the directories it writes into and checks it is there before it installs
    // anything, so an account made after the handover is a handover that stops.
    expect(lines.findIndex((line) => line.startsWith('account '))).toBeLessThan(
      lines.findIndex((line) => line.startsWith('install ')),
    );
    expect(planned(result.stdout, 'install')).toContain('--system');
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
   *
   * What to run is each unit's ExecStart line, and the units are the command's
   * to render now, on any machine -- so the summary names the command that
   * prints them, with the arguments this run was given, rather than keeping a
   * second copy of the line in bash.
   */
  it('says no unit was written, why, and what prints the command to run instead', () => {
    const { home, result } = summaryWithNoUnitWritten('no systemctl on this machine');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No unit was written: no systemctl on this machine.');
    expect(result.stdout).toContain(
      `${home}/.agentplex/bin/agentplex install --print-unit --role=server`,
    );
    expect(result.stdout).toContain('ExecStart');
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
   * The one constant, read out of the script rather than copied here: a copy
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
   * And the same URL the client hands somebody who has no server yet. Three
   * printers of one string, so the constant that can drift is held against the
   * script from both sides rather than from the documentation alone -- a wizard
   * offering a 404 is the same failure as a README offering one, reached by
   * somebody less likely to go looking for the real address.
   */
  it('prints the same URL the first-run wizard offers to copy', () => {
    expect(readFileSync(clientInstallCommand, 'utf8')).toContain(declaredUrl());
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
   * it. The release workflow's `v1` job is that something, by running
   * `advance-v1.sh`, so the ref the URL names and the ref that script pushes
   * are held together here rather than left to agree by memory across two
   * directories -- and so is the job running the script at all.
   */
  it('is served from the ref the release workflow moves', () => {
    const [, , ref] = new URL(declaredUrl()).pathname.split('/').slice(1);
    expect(ref).toBeDefined();
    expect(readFileSync(releaseWorkflow, 'utf8')).toContain('run: scripts/advance-v1.sh ');
    expect(readFileSync(advanceScript, 'utf8')).toContain(`refs/heads/${ref}`);
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
    // The prefix is still where the command's package goes, because that is
    // where the binary and any provider the wizard installs appear.
    expect(planned(result.stdout, 'package')).toBe(`${cliSpec()} into ${home}/.agentplex`);
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

describe("installing the command's package against the shrinkwrap it carries", () => {
  /**
   * The mechanism, end to end on a disk: the command's tarball unpacked into
   * `<tree>.new`, npm pointed at that directory, the tree swapped in, and the
   * command linked by hand. The same step `agentplex install` then runs for
   * every other package a role needs, as a set of its own.
   *
   * `npm install --global <tarball>` is what this replaced, and it is asserted
   * absent by argument rather than by grepping the script: the script's
   * comments still say those words about how `setup` installs a provider,
   * which is true and not this.
   */
  it('stages the command, installs it against its shrinkwrap, and swaps it in', () => {
    const { prefix, result, npmCalls, globalconfig } = packagesInstalled({
      role: 'hub',
      before: (where) => oldTree(where, 'agentplex'),
    });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const scope = scopeDirectory(prefix);
    expect(npmCalls).toEqual([
      'config get globalconfig',
      `install --prefix ${scope}/agentplex.new ${npmInstallFlags(globalconfig)}`,
    ]);
    expect(npmCalls.flatMap((call) => call.split(' '))).not.toContain('--global');

    // Swapped, with nothing left staged or set aside, and nothing of the
    // role's other packages: those are the command's to install.
    expect(readdirSync(scope)).toEqual(['agentplex']);
    expect(existsSync(join(scope, 'agentplex', 'node_modules', '.installed'))).toBe(true);
    expect(existsSync(join(scope, 'agentplex', 'npm-shrinkwrap.json'))).toBe(true);
    expect(existsSync(join(scope, 'agentplex', 'old-marker'))).toBe(false);

    // The link npm used to make, made the way npm makes it: relative, and to a
    // target with its executable bit back, because the tarball packs it 0644.
    const link = join(prefix, 'bin', 'agentplex');
    expect(readlinkSync(link)).toBe(`../lib/node_modules/${CLI_PACKAGE}/${ENTRYPOINT}`);
    expect(statSync(link).mode & 0o777).toBe(0o755);
  });

  /**
   * When npm will not install it, the tree and the link the machine was
   * running on are not touched, and nothing staged is left beside them.
   */
  it('leaves the installed tree and the link alone when the install fails', () => {
    let linkTarget = '';
    const { prefix, result } = packagesInstalled({
      role: 'hub',
      failing: 'agentplex',
      before: (where) => {
        const cli = oldTree(where, 'agentplex');
        const entry = join(cli, 'main.js');
        writeFileSync(entry, '');
        mkdirSync(join(where, 'bin'), { recursive: true });
        linkTarget = `../lib/node_modules/${CLI_PACKAGE}/main.js`;
        symlinkSync(linkTarget, join(where, 'bin', 'agentplex'));
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('@softiesolutions/agentplex');
    const scope = scopeDirectory(prefix);
    expect(readdirSync(scope)).toEqual(['agentplex']);
    expect(existsSync(join(scope, 'agentplex', 'old-marker'))).toBe(true);
    expect(readlinkSync(join(prefix, 'bin', 'agentplex'))).toBe(linkTarget);
  });

  /**
   * A run killed between the two renames of the swap leaves `<tree>.old` and
   * no `<tree>`: the machine's command is intact, under a name nothing starts.
   * The next run puts it back before it stages anything, so that run failing
   * too still leaves the machine with the command it had -- and a `.new` a
   * killed run left is discarded rather than taken for this run's.
   */
  it('puts back a tree an interrupted swap set aside, and discards a stale staging', () => {
    const { prefix, result } = packagesInstalled({
      role: 'hub',
      failing: 'agentplex',
      before: (where) => {
        oldTree(where, 'agentplex.old');
        oldTree(where, 'agentplex.new');
      },
    });

    expect(result.status).not.toBe(0);
    const scope = scopeDirectory(prefix);
    expect(readdirSync(scope)).toEqual(['agentplex']);
    expect(existsSync(join(scope, 'agentplex', 'old-marker'))).toBe(true);
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

  /**
   * An install stages each package beside its tree as `<tree>.new` and moves
   * the old one aside as `<tree>.old` for the length of a rename. A run
   * interrupted in between leaves either behind, and both are ours: they are
   * named for our packages under our scope, and nothing else writes them.
   *
   * The tree comes first, because `planned` and every reader like it take the
   * first `package` line as the answer.
   */
  it('removes the .new and .old an interrupted install left beside a tree', () => {
    const { script, home } = scratch();
    const scope = scopeDirectory(join(home, '.agentplex'));
    for (const name of ['agentplex-hub', 'agentplex-hub.new', 'agentplex-hub.old']) {
      mkdirSync(join(scope, name), { recursive: true });
    }

    const result = run(script, home, ['--uninstall', '--dry-run']);

    expect(result.status).toBe(0);
    expect(planned(result.stdout, 'package')).toBe(`remove ${scope}/agentplex-hub`);
    const removals = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('package '))
      .map((line) => line.slice('package'.length).trim());
    expect(removals).toEqual([
      `remove ${scope}/agentplex-hub`,
      `remove ${scope}/agentplex-hub.new`,
      `remove ${scope}/agentplex-hub.old`,
      `remove ${home}/.agentplex/bin/agentplex`,
    ]);
    // A dry run, so all three are still there.
    expect(readdirSync(scope).sort()).toEqual([
      'agentplex-hub',
      'agentplex-hub.new',
      'agentplex-hub.old',
    ]);
  });

  /**
   * A first install that failed while staging leaves no tree at all, only what
   * it staged -- and the run that failed removes that itself, unless it was
   * killed. "Nothing to remove" would then be untrue about a directory this
   * script made, so what an interrupted run leaves counts as something here.
   */
  it('counts a prefix holding only what an interrupted install staged', () => {
    const { script, home } = scratch();
    const scope = scopeDirectory(join(home, '.agentplex'));
    mkdirSync(join(scope, 'agentplex.new'), { recursive: true });
    openToEveryone(join(home, '.agentplex'));

    const result = run(script, home, ['--uninstall']);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('Nothing of');
    expect(planned(result.stdout, 'package')).toBe(`remove ${scope}/agentplex.new`);
    expect(existsSync(join(home, '.agentplex'))).toBe(false);
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
   * The grammar is the script's to refuse and the command's to resolve. Every
   * refusal below stops the run before anything is fetched, and a pin it
   * accepts is handed over exactly as it was typed -- which component it lands
   * on is `agentplex install`'s question, asserted in its own suite.
   */
  it('hands each pin over as it was typed', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--role=hub@1.3.0', '--role=server@1.4']);

    expect(result.status).toBe(0);
    expect(planned(result.stdout, 'install')).toContain(
      'agentplex install --dry-run --role=hub@1.3.0 --role=server@1.4 ',
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
   * Still narrower than an npm range, and narrower because delivery is not a
   * registry. A pin is either a release tag or a series that resolves to one,
   * and everything else -- a caret, a wildcard, a word -- would mean guessing
   * which release was meant or building a URL that 404s partway through an
   * install.
   */
  it.each(['latest', '^1.3.0', '1.3.x', 'v1.3.0', '1.2.3.4', '01.3'])(
    'refuses the pin %s, which names neither a tag nor a series',
    (pin) => {
      const { script, home } = scratch();
      const result = run(script, home, ['--dry-run', `--role=hub@${pin}`]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`"${pin}" is not a version this can install`);
      expect(result.stderr).toContain('hub-v<version>');
    },
  );

  it('refuses the same shape on --package-version', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--package-version=1.3.x']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not a version this can install');
  });

  /** Two components named one at a time is the same machine as `both`. */
  it('hands setup both when hub and server were named separately', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--role=hub', '--role=server']);

    expect(result.status).toBe(0);
    expect(planned(result.stdout, 'install')).toContain(
      'agentplex install --dry-run --role=hub --role=server ',
    );
    expect(result.stdout).toMatch(/setup\s+(would run .*--role=both|not run: no terminal)/);
  });
});

describe('the versions manifest, which is read off the network and parsed', () => {
  /**
   * The command's entry, and only the command's: it is the one package this
   * script installs, and the command reads the rest of the same file for
   * itself once it is here.
   */
  it("names the command's release and where it came from", () => {
    const { script, home, versions } = scratch();
    const result = run(script, home, ['--dry-run', '--role=hub']);

    expect(planned(result.stdout, 'release')).toBe(`cli 1.4.0 (from ${versions}/versions.json)`);
    // The command records no protocol leg, so there is nothing here to check.
    expect(planned(result.stdout, 'client protocol')).toBeUndefined();
    expect(planned(result.stdout, 'server protocol')).toBeUndefined();
  });

  it('refuses something that is not a JSON object at all', () => {
    const { script, home, versions } = scratch();
    writeFileSync(join(versions, 'versions.json'), 'not json\n');

    const result = run(script, home, ['--dry-run', '--role=hub']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not a versions manifest');
  });

  /**
   * A missing entry is a release that did not finish. The command's is the one
   * this script cannot do without; the client's is the command's to refuse,
   * and it refuses it with the same sentence, so the script does not ask.
   */
  it("refuses a manifest missing the command's entry, and leaves the rest to it", () => {
    const { script, home, versions } = scratch();
    const { cli: _cli, ...withoutCli } = CURRENT;
    writeVersions(versions, withoutCli);

    const result = run(script, home, ['--dry-run', '--role=hub']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('names no cli');

    const { web: _web, ...withoutWeb } = CURRENT;
    writeVersions(versions, withoutWeb);
    expect(run(script, home, ['--dry-run', '--role=hub']).status).toBe(0);
  });

  /**
   * Written by hand and not through the writer, which is the only fixture here
   * that has to be: the whole point of it is a manifest the writer would refuse
   * to produce. A `v1` branch anybody with write access can push to is where
   * one comes from.
   */
  it('refuses a current version that is not one', () => {
    const { script, home, versions } = scratch();
    writeFile(
      join(versions, 'versions.json'),
      JSON.stringify({ cli: { current: 'latest', releases: { latest: {} } } }),
    );

    const result = run(script, home, ['--dry-run', '--role=hub']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not a version');
  });

  /**
   * The invariant that makes the file answerable in one read: what is current
   * has to be one of the releases listed beside it. A manifest where the two
   * disagree is a `v1` branch somebody hand-edited, and every installing
   * machine reads it.
   */
  it('refuses an entry whose current version is not one of its releases', () => {
    const { script, home, versions } = scratch();
    writeFile(
      join(versions, 'versions.json'),
      JSON.stringify({ cli: { current: '1.4.0', releases: { '1.3.0': {} } } }),
    );

    const result = run(script, home, ['--dry-run', '--role=hub']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('calls 1.4.0 the current cli and lists no such release');
  });

  /**
   * The shape this file had before it carried history. Nothing on the `v1`
   * branch is ever written by hand, but the branch outlives any one release and
   * a reader that took `{version, protocol}` for an entry with no releases would
   * be an installer with no answer for a pin.
   */
  it('refuses the shape the manifest had before it carried history', () => {
    const { script, home, versions } = scratch();
    writeFile(
      join(versions, 'versions.json'),
      JSON.stringify({ cli: { version: '1.4.0', protocol: FIXTURE_PROTOCOL } }),
    );

    const result = run(script, home, ['--dry-run', '--role=hub']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('gives cli no current version');
  });

  /**
   * Nothing was ever published in the bare-number form the file had while
   * there was one protocol, so a release that is one number is a malformed
   * file rather than an old one, and it is refused naming the file rather than
   * read as a release that speaks nothing.
   */
  it('refuses a release that is one bare number, naming the file', () => {
    const { script, home, versions } = scratch();
    writeFile(
      join(versions, 'versions.json'),
      JSON.stringify({ cli: { current: '1.4.0', releases: { '1.4.0': FIXTURE_PROTOCOL } } }),
    );

    const result = run(script, home, ['--dry-run', '--role=hub']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${versions}/versions.json`);
    expect(result.stderr).toContain('cli release 1.4.0');
  });

  /**
   * The command's history is read against the whole grammar, legs included,
   * although the command records none: a file that is wrong anywhere in the
   * entry this reads is refused rather than being right about the one release
   * somebody asked for. A quoted number is the one worth naming: a reader that
   * skipped what it could not parse would check nothing and say it had.
   */
  it.each([
    ['a leg that is a string', { client: '3', server: 3 }],
    ['a leg nobody named', { client: 3, server: 3, browser: 3 }],
    ['a leg of zero', { client: 0, server: 3 }],
    ['a leg that is negative', { client: -3, server: 3 }],
    ['a leg that nests', { client: { major: 3 }, server: 3 }],
  ])('refuses %s, naming the file and the release', (_name, legs) => {
    const { script, home, versions } = scratch();
    writeFile(
      join(versions, 'versions.json'),
      JSON.stringify({ cli: { current: '1.4.0', releases: { '1.4.0': {}, '1.3.0': legs } } }),
    );

    const result = run(script, home, ['--dry-run', '--role=hub']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${versions}/versions.json`);
    expect(result.stderr).toContain('cli release 1.3.0');
  });

  /**
   * The legs are read by name, not by position, so a file that names them in
   * the other order reads the same. The writer emits client first; a mirror
   * that re-serialised the file need not.
   */
  it('reads the legs in either order', () => {
    const { script, home, versions } = scratch();
    writeFile(
      join(versions, 'versions.json'),
      JSON.stringify({
        cli: { current: '1.4.0', releases: { '1.4.0': {}, '1.3.0': { server: 5, client: 4 } } },
      }),
    );

    const result = run(script, home, ['--dry-run', '--role=hub']);

    expect(result.status).toBe(0);
    expect(planned(result.stdout, 'release')).toContain('cli 1.4.0');
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
    // No URL was built for a version this run never learned: the download root
    // is named, and no tag inside it is. Asked of what npm is handed, because
    // the rest of the line is a prefix this suite chose and nothing the script
    // decided.
    const { source } = packagePlan(result.stdout);
    expect(source).not.toContain('-v');
    expect(source).toContain('cli from');
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
   * Read even when the command is pinned exactly, which is the change history
   * made: the manifest lists every release, so a pinned run needs it too -- to
   * refuse a pin naming a release nobody published.
   */
  it('is read even when the command is pinned', () => {
    const { script, home, versions } = scratch();
    writeHistory(versions, { cli: { '1.2.3': FIXTURE_PROTOCOL } });

    const result = run(script, home, [
      '--dry-run',
      '--role=server@1.4.0',
      '--package-version=1.2.3',
    ]);

    expect(result.status).toBe(0);
    expect(planned(result.stdout, 'release')).toContain(join(versions, 'versions.json'));
    expect(planned(result.stdout, 'package')).toBe(`${cliSpec('1.2.3')} into ${home}/.agentplex`);
  });

  /**
   * And a run with no manifest at all now stops, where pinning everything used
   * to be the way around it. The trade is deliberate: one fetch of a file this
   * script already fetches, in exchange for a pin that can be checked at all.
   */
  it('names the mirror seam when it cannot be read', () => {
    const { script, home, versions } = scratch();
    rmSync(join(versions, 'versions.json'));

    const result = run(script, home, ['--dry-run', '--package-version=1.4.0']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('holds no versions.json');
  });

  /**
   * A pin the manifest does not offer is the other thing this catches, and it
   * catches it before the first tarball rather than at a 404 partway through an
   * npm install. And it says what the file is rather than what exists: `v1`
   * advertises the 1.x train, so a 2.x tag can be real and absent from it.
   */
  it('stops when the manifest offers no such release of the command', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--package-version=2.0.0']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('offers no cli release at 2.0.0');
    expect(result.stderr).toContain('cli-v2.0.0');
    expect(result.stderr).toContain('the set of releases it advertises');
  });
});

describe('a pin that names a series rather than a tag', () => {
  /**
   * Every word in the one pin table, read by the script's flag grammar. The
   * same rows run against `readPin` in `packages/release`, so the bash and the
   * TypeScript cannot classify a word differently without one of the two
   * suites going red -- see `pin-cases.ts`.
   *
   * Through `--package-version`, because the command is the one component
   * whose pin this script still resolves. An exact word is planned as its own
   * tag, against a history that lists it. A series word is resolved and comes
   * up empty, against a command whose one release sits under the next major --
   * so the only sentence that can explain the refusal is the resolver's. A
   * refused word never reaches the manifest at all, and it is refused through
   * `--role` as well: the grammar is one grammar whatever flag carries it.
   */
  it.each(PIN_GRAMMAR_CASES)('reads $word as $kind', ({ word, kind }) => {
    const { script, home, versions } = scratch();
    if (kind === 'exact') writeHistory(versions, { cli: { [word]: FIXTURE_PROTOCOL } });
    if (kind === 'series') {
      const major = Number(word.split('.')[0]);
      writeVersions(versions, { ...CURRENT, cli: `${String(major + 1)}.0.0` });
    }

    const result = run(script, home, ['--dry-run', `--package-version=${word}`]);

    switch (kind) {
      case 'exact':
        expect(result.status).toBe(0);
        expect(packagePlan(result.stdout).source).toContain(`/cli-v${word}/`);
        break;
      case 'series':
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`offers no cli release under ${word}`);
        break;
      case 'refused': {
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/not a version this can install|nothing after it/);
        const role = run(script, home, ['--dry-run', `--role=hub@${word}`]);
        expect(role.status).toBe(1);
        expect(role.stderr).toMatch(/not a version this can install|nothing after it/);
        break;
      }
    }
  });

  /**
   * Every resolution in the table, through the script's `newest_in_series`,
   * against a manifest holding exactly the case's releases of the command in
   * the order a release job would have published them. The same rows run
   * against `newestInSeries` in `packages/release`.
   */
  it.each(SERIES_RESOLUTION_CASES)('$name', ({ releases, series, expect: expected }) => {
    const { script, home, versions } = scratch();
    const last = releases.at(-1) ?? '';
    writeVersions(
      versions,
      { ...CURRENT, cli: last },
      {
        history: {
          cli: Object.fromEntries(releases.slice(0, -1).map((one) => [one, FIXTURE_PROTOCOL])),
        },
      },
    );

    const result = run(script, home, ['--dry-run', `--package-version=${series}`]);

    if (expected === null) {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`offers no cli release under ${series}`);
    } else {
      expect(result.status).toBe(0);
      expect(packagePlan(result.stdout).source).toContain(`/cli-v${expected}/`);
    }
  });

  it('resolves a series given to --package-version', () => {
    const { script, home, versions } = scratch();
    writeHistory(versions, { cli: { '1.4.7': FIXTURE_PROTOCOL } });

    const result = run(script, home, ['--dry-run', '--role=hub', '--package-version=1.4']);

    expect(result.status).toBe(0);
    expect(planned(result.stdout, 'package')).toContain('/cli-v1.4.7/');
  });

  /**
   * A dry run downloads nothing, so a run with no manifest to resolve against
   * says the question went unasked rather than printing a version it guessed.
   * An exact pin is still an answer there -- it names the tag outright.
   */
  it('resolves nothing without a manifest, and says so', () => {
    const { script, home } = scratch();
    const series = run(script, home, ['--dry-run', '--package-version=1.4'], {
      environment: { AGENTPLEX_VERSIONS: '' },
    });

    expect(series.status).toBe(0);
    expect(planned(series.stdout, 'release')).toContain('cli (not resolved)');
    expect(packagePlan(series.stdout).source).not.toContain('-v');

    const exact = run(script, home, ['--dry-run', '--package-version=1.4.0'], {
      environment: { AGENTPLEX_VERSIONS: '' },
    });
    expect(exact.status).toBe(0);
    expect(packagePlan(exact.stdout).source.trim()).toBe(cliSpec('1.4.0'));
  });
});

describe('the release asset, which two directories have to agree about', () => {
  /**
   * The script builds the command's download URL out of a version and an
   * asset name, and the assembler decides what that asset is called. Neither
   * can read the other, so the tie is a test: a rename in `assemble-package.ts`
   * fails here rather than at a 404 on somebody's machine.
   */
  it('builds the command URL against the asset the assembler names', () => {
    const declared = /^readonly CLI_ASSET='([^']+)'$/m.exec(readFileSync(scriptPath, 'utf8'))?.[1];
    const cli = PACKAGES.find((target) => target.component === 'cli');

    expect(declared).toBeDefined();
    expect(declared).toBe(cli?.asset);
    expect(cliSpec('1.0.0')).toContain(`/cli-v1.0.0/${declared ?? ''}`);
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
    expect(planned(result.stdout, 'package')).toBe(`${cliSpec()} into ${home}/custom`);
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

describe('the Docker stages that run this script against a real machine', () => {
  /**
   * `bootstrap-check` and `hub-bootstrap-check` assert everything this suite
   * cannot reach -- a runtime downloaded, a toolchain installed through sudo, a
   * service account created, a unit systemd itself verified -- and every one of
   * those assertions is a RUN line, so building a stage is running it.
   *
   * Which is the whole of the check, and the trap. The server stage ends by
   * undoing both installs it made, because it is the only machine here an
   * uninstall can be exercised against something really installed, so what it
   * leaves has no `agentplex` on it at all. For a while the local command ran
   * the compose services and the workflow built the targets directly, and the
   * two stopped testing the same thing: `pnpm docker:bootstrap` failed with
   * `agentplex: command not found` after a green build, on a stage CI was
   * building green, and the command nobody ran was the one that rotted.
   */
  it('is built by a command that starts no container, and names both stages', () => {
    const { scripts } = bootstrapScriptSchema.parse(JSON.parse(readFileSync(rootManifest, 'utf8')));
    const argv = scripts['docker:bootstrap'].split(/\s+/);

    expect(
      argv,
      `docker:bootstrap in ${rootManifest} is '${scripts['docker:bootstrap']}', which runs a ` +
        'container. Both stages end as images with nothing left in them to run; the build is ' +
        'the check.',
    ).toContain('build');
    expect(argv).not.toContain('run');

    // Named here rather than assumed, because a stage nobody builds is a claim
    // nobody checks: `hub-bootstrap-check` was reachable from no command at all
    // until this one took both.
    const compose = readFileSync(composeFile, 'utf8');
    for (const service of ['bootstrap', 'bootstrap-hub']) {
      expect(
        compose,
        `${composeFile} defines no '${service}' service for docker:bootstrap to build`,
      ).toMatch(new RegExp(`^ {2}${service}:$`, 'm'));
      expect(
        argv,
        `docker:bootstrap in ${rootManifest} does not build the '${service}' service`,
      ).toContain(service);
    }
  });

  /**
   * The other half of the same tie. A workflow that names the targets itself is
   * a second version of the check, and a second version is what drifted.
   */
  it('is the command CI runs, rather than one the workflow assembles', () => {
    const workflow = readFileSync(checkWorkflow, 'utf8');

    expect(
      workflow,
      `${checkWorkflow} does not run 'pnpm docker:bootstrap', so the job and the command a ` +
        'contributor types can go their separate ways',
    ).toContain('run: pnpm docker:bootstrap');
    expect(
      workflow,
      `${checkWorkflow} builds a bootstrap stage by naming its target, which is the check ` +
        'assembled a second time. Run the script instead.',
    ).not.toMatch(/^ *target: (?:hub-)?bootstrap-check$/m);
  });
});
