import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

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

const packagingDirectory = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(packagingDirectory, 'install.sh');
const documentation = join(packagingDirectory, '..', 'README.md');
const rootManifest = join(packagingDirectory, '..', '..', '..', 'package.json');

/**
 * Only `engines`. The rest of the root manifest is somebody else's to change --
 * the package is being renamed on another branch -- and a schema that read more
 * than the one field this tie is about would fail on edits that have nothing to
 * do with the Node major.
 */
const enginesSchema = z.object({ engines: z.object({ node: z.string() }) });

const suiteIsRoot = process.getuid?.() === 0;

/**
 * Whether this machine could run a systemd unit, asked the way the script asks
 * it. The check container is a Node image and has no systemd, so a suite that
 * assumed one would be asserting about the machine it was written on.
 */
const machineHasSystemd = spawnSync('bash', ['-c', 'command -v systemctl']).status === 0;

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
 * A scratch machine: a copy of the script somewhere world-readable, and a home
 * directory to install into.
 *
 * The copy is not caution about mutation -- nothing here writes to the script.
 * A checkout can live under a mode-0700 home, and `nobody` cannot read a script
 * it cannot traverse to.
 */
function scratch(): { readonly script: string; readonly home: string } {
  const root = mkdtempSync(join(tmpdir(), 'agentplex-install-'));
  temporaries.push(root);
  const script = join(root, 'install.sh');
  const home = join(root, 'home');
  cpSync(scriptPath, script);
  mkdirSync(home);
  chmodSync(root, 0o777);
  chmodSync(script, 0o755);
  chmodSync(home, 0o777);
  return { script, home };
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

/** A literal path, as a fragment of a regular expression. */
function escaped(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** Every line of the plan the unit step printed. */
function unitLines(stdout: string): readonly string[] {
  return stdout.split('\n').filter((line) => line.startsWith('unit '));
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

  const library = `${script}.lib`;
  writeFileSync(library, readFileSync(script, 'utf8').replace(/main "\$@"\s*$/, ''));
  chmodSync(library, 0o644);

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

  const library = `${script}.lib`;
  writeFileSync(library, readFileSync(script, 'utf8').replace(/main "\$@"\s*$/, ''));
  chmodSync(library, 0o644);

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

describe('the plan a dry run prints', () => {
  it('installs into the user prefix, for the user who ran it', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--role=server']);

    expect(result.status).toBe(0);
    expect(planned(result.stdout, 'package')).toBe(`agentplex@latest into ${home}/.agentplex`);
    expect(planned(result.stdout, 'settings')).toContain(`${home}/.agentplex/agentplex.env`);
  });

  /**
   * The unit line is the one thing in the plan that depends on the machine
   * running the suite, so it is asserted against that machine rather than
   * against an assumption about it. The check container is a Node image with no
   * systemd in it, and a plan claiming it would write a unit there would be the
   * over-claim, not the skip.
   */
  it('plans a user unit where there is a systemd to run one, and says so where there is not', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--role=server']);

    expect(planned(result.stdout, 'unit')).toBe(
      machineHasSystemd
        ? `${home}/.config/systemd/user/agentplex-server.service (write, not enabled)`
        : 'skipped: no systemctl on this machine',
    );
  });

  /**
   * One line per step, which is the shape `report` exists to hold. The answer
   * used to be reported by the predicate that gave it, so the line came out
   * once per place that asked -- and a second place that asked was added, and
   * the plan grew a duplicate nobody had written.
   */
  it('reports the unit step once, whichever answer this machine gives', () => {
    const { script, home } = scratch();

    const server = run(script, home, ['--dry-run', '--role=server']);
    const both = run(script, home, ['--dry-run', '--role=both']);

    expect(unitLines(server.stdout)).toHaveLength(1);
    // A machine with systemd writes a file per daemon and names each file. A
    // machine without one has a single answer to give, not one answer per
    // daemon that will not be written.
    expect(unitLines(both.stdout)).toHaveLength(machineHasSystemd ? 2 : 1);
  });

  it('changes nothing at all', () => {
    const { script, home } = scratch();
    run(script, home, ['--dry-run']);
    expect(readdirSync(home)).toEqual([]);
  });

  it('pins the version it was given, and says so as one spec', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run', '--package-version=1.2.3']);
    expect(planned(result.stdout, 'package')).toContain('agentplex@1.2.3');
  });

  it('installs whatever AGENTPLEX_PACKAGE names, which is how the container check reaches an unpublished build', () => {
    const { script, home } = scratch();
    const result = run(script, home, ['--dry-run'], {
      environment: { AGENTPLEX_PACKAGE: '/package/agentplex-0.0.0.tgz' },
    });
    expect(planned(result.stdout, 'package')).toContain('/package/agentplex-0.0.0.tgz');
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

    const library = `${script}.lib`;
    writeFileSync(library, readFileSync(script, 'utf8').replace(/main "\$@"\s*$/, ''));
    chmodSync(library, 0o644);

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

describe('the systemd unit', () => {
  it('writes one unit per daemon the role runs, and both for --role=both', () => {
    const { script, home } = scratch();
    const both = run(script, home, ['--print-unit', '--role=both']).stdout;
    const units = both.split('\n').filter((line) => line.startsWith('ExecStart='));

    expect(units).toEqual([
      `ExecStart=${home}/.agentplex/bin/agentplex hub`,
      `ExecStart=${home}/.agentplex/bin/agentplex server`,
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
    expect(unit).toContain(`ExecStart=${home}/.agentplex/bin/agentplex server`);
    expect(unit).not.toContain('agentplex hub');
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
    expect(unit).toContain('ExecStart=/opt/agentplex/bin/agentplex hub');
    expect(unit).toContain('ExecStart=/opt/agentplex/bin/agentplex server');
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
    expect(result.stdout).toContain(`${home}/.agentplex/bin/agentplex server`);
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
   * The open decision this ticket had to settle. The value is one constant in
   * the script; this is what makes it one constant rather than one constant and
   * three copies in prose that drift away from it.
   */
  it('prints the same URL the documentation tells people to fetch', () => {
    const source = readFileSync(scriptPath, 'utf8');
    const declared = /^readonly INSTALL_SH_URL='([^']+)'$/m.exec(source)?.[1];
    expect(declared).toBeDefined();
    expect(declared).toMatch(/^https:\/\//);
    expect(readFileSync(documentation, 'utf8')).toContain(declared);
  });

  it('pins a version in the path it is served from', () => {
    const source = readFileSync(scriptPath, 'utf8');
    const declared = /^readonly INSTALL_SH_URL='([^']+)'$/m.exec(source)?.[1] ?? '';
    // A tag today, a /v1/ path behind an alias later. What must not happen is a
    // URL that means different bytes on different days.
    expect(declared).toMatch(/<tag>|\/v\d+\//);
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
