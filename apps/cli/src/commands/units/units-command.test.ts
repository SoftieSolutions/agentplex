import { describe, expect, it } from 'vitest';
import type { ProgramResolver } from '@agentplex/providers';
import {
  createFakeProcessRunner,
  printed,
  refused,
  type FakeProcessRunner,
} from '@agentplex/providers/testing';
import { createFakeInstallationFiles } from '../../installation/fake-installation-files.js';
import { createSystemd } from '../../installation/systemd.js';
import { runUnitsCommand } from './units-command.js';

/**
 * `agentplex start` and `agentplex stop`, run against a prefix that is a table
 * and a `systemctl` that is a lookup.
 *
 * Nothing here shells out and nothing reads a real prefix, which is the whole
 * point: the machines worth covering are a box with no systemd, a box with one
 * unit, a box with a unit the manager will not start and a directory that is
 * not an agentplex prefix at all, and every one of those is two literals rather
 * than a container.
 *
 * The composition under the command is the real one -- the real `createSystemd`
 * over a fake `ProcessRunner` -- so what the assertions reach is the argv the
 * operations built. A mock of the seam would have tested the code's shape; this
 * tests what would have been run.
 */

const HOME = '/home/alice';
const PREFIX = `${HOME}/.agentplex`;
const UNITS = `${HOME}/.config/systemd/user`;
const HUB = 'agentplex-hub.service';
const SERVER = 'agentplex-server.service';

const SHOW_PROPERTIES =
  '--property=LoadState --property=ActiveState --property=SubState ' +
  '--property=UnitFileState --property=ActiveEnterTimestamp';

function show(scope: 'user' | 'system', unit: string): string {
  return `systemctl ${scope === 'user' ? '--user ' : ''}show ${unit} ${SHOW_PROPERTIES}`;
}

function state(active: string, enabled = 'enabled'): ReturnType<typeof printed> {
  return printed(
    `LoadState=loaded\nActiveState=${active}\nSubState=running\nUnitFileState=${enabled}\n`,
  );
}

function packageAt(name: string): string {
  return `${PREFIX}/lib/node_modules/${name}/package.json`;
}

const SETTINGS = `AGENTPLEX_ROLE=both\nAGENTPLEX_PREFIX=${PREFIX}\n`;

interface Machine {
  /** Unit files on the disk. Nothing acts on a unit that is not here. */
  readonly units?: readonly string[];
  /** Whether this machine has a systemctl at all. */
  readonly systemd?: boolean;
  /** Extra files: manifests, a runtime stamp. */
  readonly files?: Readonly<Record<string, string>>;
  /** Paths that are files with nothing to read in them: an interpreter. */
  readonly present?: readonly string[];
  /** What systemctl prints, by argv. */
  readonly outcomes?: Readonly<Record<string, ReturnType<typeof printed>>>;
  /** A prefix with no agentplex in it at all. */
  readonly bare?: boolean;
}

interface Run {
  readonly code: number;
  readonly out: string;
  readonly errors: string;
  readonly runner: FakeProcessRunner;
}

async function run(
  verb: 'start' | 'stop',
  argv: readonly string[],
  machine: Machine = {},
): Promise<Run> {
  const out: string[] = [];
  const errors: string[] = [];
  const runner = createFakeProcessRunner({ outcomes: machine.outcomes ?? {} });
  const programs: ProgramResolver = {
    resolve: async (name) =>
      (machine.systemd ?? true) && name === 'systemctl' ? '/usr/bin' : null,
  };

  const code = await runUnitsCommand(verb, argv, {
    home: HOME,
    files: createFakeInstallationFiles({
      files:
        machine.bare === true ? {} : { [`${PREFIX}/agentplex.env`]: SETTINGS, ...machine.files },
      present: [
        ...(machine.units ?? []).map((unit) => `${UNITS}/${unit}`),
        ...(machine.present ?? []),
      ],
    }),
    systemd: createSystemd({ runner, programs }),
    interpreter: '/usr/bin/node',
    write: (line) => out.push(line),
    writeError: (line) => errors.push(line),
  });

  return { code, out: out.join('\n'), errors: errors.join('\n'), runner };
}

describe('agentplex start', () => {
  it('reloads and then enables every unit this machine has', async () => {
    const started = await run('start', [], {
      units: [HUB, SERVER],
      outcomes: {
        'systemctl --user daemon-reload': printed(''),
        [`systemctl --user enable --now ${HUB} ${SERVER}`]: printed(''),
        [show('user', HUB)]: state('active'),
        [show('user', SERVER)]: state('active'),
      },
    });

    expect(started.code).toBe(0);
    expect(started.errors).toBe('');
    expect(started.out).toContain(`prefix=${PREFIX}   scope=user`);
    expect(started.out).toContain(`enabled and started ${HUB}, ${SERVER}`);
    // The reload comes first, and it is not optional: the units on the disk may
    // be newer than the ones the manager read, which is the ordinary case after
    // an install and exactly the case this command is for.
    expect(started.runner.requests[0]?.args).toEqual(['--user', 'daemon-reload']);
    expect(started.runner.requests[1]?.args).toEqual(['--user', 'enable', '--now', HUB, SERVER]);
  });

  it('acts on the one unit a single-role machine has, and names no other', async () => {
    const started = await run('start', [], {
      units: [HUB],
      outcomes: {
        'systemctl --user daemon-reload': printed(''),
        [`systemctl --user enable --now ${HUB}`]: printed(''),
        [show('user', HUB)]: state('active'),
      },
    });

    expect(started.code).toBe(0);
    expect(started.out).not.toContain(SERVER);
  });

  it('does nothing and says so when no unit was ever written', async () => {
    const started = await run('start', []);

    expect(started.code).toBe(1);
    expect(started.out).toContain(`There is no agentplex unit in ${UNITS}`);
    // Nothing was spawned: there was nothing to name.
    expect(started.runner.requests).toEqual([]);
  });

  it('prints the foreground command on a machine with no systemd', async () => {
    const started = await run('start', [], {
      systemd: false,
      files: {
        [packageAt('@softiesolutions/agentplex-hub')]: JSON.stringify({ version: '1.2.0' }),
        [packageAt('@softiesolutions/agentplex')]: JSON.stringify({ version: '1.4.0' }),
      },
    });

    expect(started.out).toContain('There is no systemctl on this machine');
    // The same line install.sh's own summary prints on the machine it could
    // write no unit for: the interpreter and the file, because a daemon is not
    // a command and there is nothing shorter that would start one.
    expect(started.out).toContain(
      `/usr/bin/node ${PREFIX}/lib/node_modules/@softiesolutions/agentplex-hub/apps/hub/dist/main.js`,
    );
    // And nothing about a server, because this machine has no server package.
    expect(started.out).not.toContain('agentplex-server/apps/server');
    // Told what to run is not the same as started. A zero here would be this
    // command claiming the daemons are up.
    expect(started.code).toBe(1);
  });

  it("names the prefix's own runtime when it has one, rather than this process's", async () => {
    const started = await run('start', [], {
      systemd: false,
      files: {
        [packageAt('@softiesolutions/agentplex-hub')]: JSON.stringify({ version: '1.2.0' }),
        [`${PREFIX}/node/.agentplex-node-version`]: 'v24.9.0\n',
      },
      present: [`${PREFIX}/node/bin/node`],
    });

    // The Node the install settled on, which is the one the unit's ExecStart
    // would have named. Never a bare `node`: the units stopped resolving their
    // own interpreter off a PATH on purpose.
    expect(started.out).toContain(`${PREFIX}/node/bin/node ${PREFIX}/lib/node_modules/`);
  });

  it('stops rather than enabling a unit the manager would not reload', async () => {
    const started = await run('start', [], {
      units: [HUB],
      outcomes: {
        'systemctl --user daemon-reload': refused(1, 'Failed to connect to bus: No medium found'),
      },
    });

    expect(started.code).toBe(1);
    expect(started.out).toContain('Failed to connect to bus');
    // A manager that will not reload would enable whatever it read last time,
    // which on an upgraded machine is a different program from the one on disk.
    expect(started.runner.requests.map((request) => request.args[1])).not.toContain('enable');
  });

  it("carries systemd's refusal through when it will not start them", async () => {
    const started = await run('start', [], {
      units: [HUB],
      outcomes: {
        'systemctl --user daemon-reload': printed(''),
        [`systemctl --user enable --now ${HUB}`]: refused(
          1,
          'Job for agentplex-hub.service failed because the control process exited',
        ),
      },
    });

    expect(started.code).toBe(1);
    expect(started.out).toContain('Job for agentplex-hub.service failed');
  });

  it('does not call it started when the unit it just enabled is failed', async () => {
    // `enable --now` exited 0, and the service is not running. That is not a
    // contrived pairing: a `Type=simple` unit's start job completes as soon as
    // the fork does, so a daemon that reads its settings, refuses them and
    // exits is a successful job and a failed service -- which is exactly what
    // an incomplete settings file produces.
    const started = await run('start', [], {
      units: [HUB],
      outcomes: {
        'systemctl --user daemon-reload': printed(''),
        [`systemctl --user enable --now ${HUB}`]: printed(''),
        [show('user', HUB)]: state('failed'),
      },
    });

    expect(started.code).toBe(1);
    expect(started.out).toContain('is not running');
    expect(started.out).toMatch(/agentplex-hub\.service\s+failed\s+enabled/);
  });
});

describe('agentplex stop', () => {
  it('disables as well as stops, because it is the reverse of start', async () => {
    const stopped = await run('stop', [], {
      units: [HUB, SERVER],
      outcomes: {
        [`systemctl --user disable --now ${HUB} ${SERVER}`]: printed(''),
        [show('user', HUB)]: state('inactive', 'disabled'),
        [show('user', SERVER)]: state('inactive', 'disabled'),
      },
    });

    expect(stopped.code).toBe(0);
    expect(stopped.out).toContain(`stopped and disabled ${HUB}, ${SERVER}`);
    // No reload: nothing on the disk changed, and a stop that reloaded first
    // would be doing something the operator did not ask for.
    expect(stopped.runner.requests[0]?.args).toEqual(['--user', 'disable', '--now', HUB, SERVER]);
  });

  it('does not offer a foreground command to somebody trying to stop one', async () => {
    const stopped = await run('stop', [], { systemd: false });

    expect(stopped.code).toBe(1);
    expect(stopped.out).toContain('There is no systemctl on this machine');
    expect(stopped.out).toContain('started by hand');
    expect(stopped.out).not.toContain('dist/main.js');
  });
});

describe('the scope and the prefix', () => {
  it('reaches a fleet install with the systemctl that reaches a system unit', async () => {
    const out: string[] = [];
    const runner = createFakeProcessRunner({
      outcomes: {
        'systemctl daemon-reload': printed(''),
        [`systemctl enable --now ${HUB}`]: printed(''),
        [show('system', HUB)]: state('active'),
      },
    });

    const code = await runUnitsCommand('start', [], {
      home: HOME,
      files: createFakeInstallationFiles({
        files: { '/etc/agentplex/agentplex.env': 'AGENTPLEX_ROLE=hub\n' },
        present: [`/etc/systemd/system/${HUB}`],
      }),
      systemd: createSystemd({
        runner,
        programs: { resolve: async () => '/usr/bin' },
      }),
      interpreter: '/usr/bin/node',
      write: (line) => out.push(line),
      writeError: () => undefined,
    });

    expect(code).toBe(0);
    expect(out.join('\n')).toContain('scope=system');
    // No `--user` anywhere: the scope came out of the same branch that chose
    // where the settings file is, exactly as `uninstall_units` picks its own.
    for (const request of runner.requests) expect(request.args).not.toContain('--user');
  });

  it('refuses a directory that is not an agentplex prefix', async () => {
    const started = await run('start', ['--prefix', '/srv/nothing'], { bare: true });

    expect(started.code).toBe(2);
    expect(started.out).toBe('');
    expect(started.errors).toContain('agentplex start:');
    expect(started.errors).toContain('/srv/nothing/agentplex.env');
    expect(started.errors).toContain('Usage: agentplex start');
  });

  it('refuses a relative prefix rather than resolving it against wherever you stood', async () => {
    const started = await run('start', ['--prefix', 'agentplex']);

    expect(started.code).toBe(2);
    expect(started.errors).toContain('has to be an absolute path');
  });

  it('refuses an argument it does not know rather than dropping it', async () => {
    const started = await run('start', ['--prefx=/srv/agentplex']);

    expect(started.code).toBe(2);
    expect(started.errors).toContain('unknown argument: --prefx=/srv/agentplex');
  });

  it('takes --system with no value, the way install.sh spells it', async () => {
    const started = await run('start', ['--system=yes']);

    expect(started.code).toBe(2);
    expect(started.errors).toContain('--system takes no value');
  });
});
