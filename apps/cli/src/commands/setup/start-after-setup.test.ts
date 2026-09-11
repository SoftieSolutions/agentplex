import { describe, expect, it } from 'vitest';
import type { ProgramResolver } from '@agentplex/providers';
import { createFakeProcessRunner, printed, refused } from '@agentplex/providers/testing';
import { createFakeInstallationFiles } from '../../installation/fake-installation-files.js';
import { createSystemd } from '../../installation/systemd.js';
import { createUnitsAfterSetup } from './start-after-setup.js';

/**
 * The last step of a successful setup, and the three machines it declines on.
 *
 * The decision this file exists to pin down is that starting belongs here and
 * not in `install.sh`: the installer has no database file, no client token and
 * no store path to start a unit with, and setup is the step that just wrote
 * them. What follows from that is that the step has to be careful about which
 * machine it is on, and each case below is one of those.
 */

const HOME = '/home/alice';
const PREFIX = `${HOME}/.agentplex`;
const UNITS = `${HOME}/.config/systemd/user`;
const HUB = 'agentplex-hub.service';

const SHOW_PROPERTIES =
  '--property=LoadState --property=ActiveState --property=SubState ' +
  '--property=UnitFileState --property=ActiveEnterTimestamp';

function units(machine: {
  readonly files?: Readonly<Record<string, string>>;
  readonly present?: readonly string[];
  readonly outcomes?: Readonly<Record<string, ReturnType<typeof printed>>>;
  readonly systemd?: boolean;
}) {
  const runner = createFakeProcessRunner({ outcomes: machine.outcomes ?? {} });
  const programs: ProgramResolver = {
    resolve: async (name) =>
      (machine.systemd ?? true) && name === 'systemctl' ? '/usr/bin' : null,
  };
  return {
    runner,
    step: createUnitsAfterSetup({
      home: HOME,
      files: createFakeInstallationFiles({
        files: machine.files ?? {},
        present: machine.present ?? [],
      }),
      systemd: createSystemd({ runner, programs }),
      interpreter: '/usr/bin/node',
    }),
  };
}

describe('what setup does about the units when it is finished', () => {
  it('enables and starts the units the installer wrote and did not', async () => {
    const { step, runner } = units({
      files: { [`${PREFIX}/agentplex.env`]: `AGENTPLEX_ROLE=hub\nAGENTPLEX_PREFIX=${PREFIX}\n` },
      present: [`${UNITS}/${HUB}`],
      outcomes: {
        'systemctl --user daemon-reload': printed(''),
        [`systemctl --user enable --now ${HUB}`]: printed(''),
        [`systemctl --user show ${HUB} ${SHOW_PROPERTIES}`]: printed(
          'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n',
        ),
      },
    });

    const lines = (await step.start()).join('\n');

    expect(lines).toContain('The units are running:');
    expect(lines).toContain(`enabled and started ${HUB}`);
    expect(runner.requests[0]?.args).toEqual(['--user', 'daemon-reload']);
  });

  it('says nothing at all on a machine no installer ever touched', async () => {
    // A wizard run out of a checkout, or on a developer laptop. There is no
    // settings file, no unit and nothing to start, and nothing to apologise for
    // either -- an apology at the end of a successful setup reads as a failure.
    const { step, runner } = units({});

    expect(await step.start()).toEqual([]);
    expect(runner.requests).toEqual([]);
  });

  it('declines on a fleet machine and says which command root runs', async () => {
    // `--system` writes its units into `/etc/systemd/system` and replays the
    // plan as the service account, which cannot enable one. Attempting it to
    // read polkit's refusal back would end a successful setup with an error
    // that was never going to be anything else.
    const { step, runner } = units({
      files: { '/etc/agentplex/agentplex.env': 'AGENTPLEX_ROLE=hub\n' },
      present: ['/etc/systemd/system/agentplex-hub.service'],
    });

    const lines = (await step.start()).join('\n');

    expect(lines).toContain('agentplex start');
    expect(lines).toContain('as root');
    expect(runner.requests).toEqual([]);
  });

  it('gives the foreground command on a machine with no systemd', async () => {
    const { step } = units({
      systemd: false,
      files: {
        [`${PREFIX}/agentplex.env`]: `AGENTPLEX_ROLE=hub\nAGENTPLEX_PREFIX=${PREFIX}\n`,
        [`${PREFIX}/lib/node_modules/@softiesolutions/agentplex-hub/package.json`]: JSON.stringify({
          version: '1.2.0',
        }),
      },
    });

    const lines = (await step.start()).join('\n');

    // The same fallback install.sh prints on the machine it could write no unit
    // for, said by the command that would otherwise have started one.
    expect(lines).toContain('no systemctl on this machine');
    expect(lines).toContain('apps/hub/dist/main.js');
    expect(lines).toContain('agentplex start tries again.');
  });

  it('reports a refusal rather than failing a setup that otherwise worked', async () => {
    const { step } = units({
      files: { [`${PREFIX}/agentplex.env`]: `AGENTPLEX_ROLE=hub\nAGENTPLEX_PREFIX=${PREFIX}\n` },
      present: [`${UNITS}/${HUB}`],
      outcomes: {
        'systemctl --user daemon-reload': refused(1, 'Failed to connect to bus: No medium found'),
      },
    });

    // It returns lines and never throws. A provisioned machine whose units will
    // not start is one somebody has to look at, and throwing here would abandon
    // the providers, the stores and the identity the run just wrote.
    const lines = (await step.start()).join('\n');
    expect(lines).toContain('The units were not started:');
    expect(lines).toContain('Failed to connect to bus');
  });
});
