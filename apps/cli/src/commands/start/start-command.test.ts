import { describe, expect, it } from 'vitest';
import { printed, refused, createFakeProcessRunner } from '@agentplex/providers/testing';
import { createFakeInstallationFiles } from '../../installation/fake-installation-files.js';
import {
  HOME,
  HUB,
  PREFIX,
  SERVER,
  UNITS,
  packageAt,
  runOnMachine,
  show,
  state,
} from '../../installation/fake-units-machine.js';
import { createSystemd } from '../../installation/systemd.js';
import { runUnitsCommand } from '../../installation/units-command.js';
import { START } from './start-command.js';

/**
 * `agentplex start`: what it asks systemd for, and what it says when it cannot.
 *
 * The machine every case runs against is described in `fake-units-machine.ts`,
 * which `stop` runs against too. What is here is only what is true of `start`
 * and false of its reverse.
 */

function run(argv: readonly string[], machine?: Parameters<typeof runOnMachine>[2]) {
  return runOnMachine(START, argv, machine);
}

describe('agentplex start', () => {
  it('reloads and then enables every unit this machine has', async () => {
    const started = await run([], {
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
    const started = await run([], {
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
    const started = await run([]);

    expect(started.code).toBe(1);
    expect(started.out).toContain(`There is no agentplex unit in ${UNITS}`);
    // Nothing was spawned: there was nothing to name.
    expect(started.runner.requests).toEqual([]);
  });

  it('prints the foreground command on a machine with no systemd', async () => {
    const started = await run([], {
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
    const started = await run([], {
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
    const started = await run([], {
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
    const started = await run([], {
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
    const started = await run([], {
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

    const code = await runUnitsCommand(START, [], {
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
    const started = await run(['--prefix', '/srv/nothing'], { bare: true });

    expect(started.code).toBe(2);
    expect(started.out).toBe('');
    expect(started.errors).toContain('agentplex start:');
    expect(started.errors).toContain('/srv/nothing/agentplex.env');
    expect(started.errors).toContain('Usage: agentplex start');
  });

  it('refuses a relative prefix rather than resolving it against wherever you stood', async () => {
    const started = await run(['--prefix', 'agentplex']);

    expect(started.code).toBe(2);
    expect(started.errors).toContain('has to be an absolute path');
  });

  it('refuses an argument it does not know rather than dropping it', async () => {
    const started = await run(['--prefx=/srv/agentplex']);

    expect(started.code).toBe(2);
    expect(started.errors).toContain('unknown argument: --prefx=/srv/agentplex');
  });

  it('takes --system with no value, the way install.sh spells it', async () => {
    const started = await run(['--system=yes']);

    expect(started.code).toBe(2);
    expect(started.errors).toContain('--system takes no value');
  });
});
