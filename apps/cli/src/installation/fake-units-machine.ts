import type { ProgramResolver } from '@agentplex/providers';
import {
  createFakeProcessRunner,
  printed,
  type FakeProcessRunner,
} from '@agentplex/providers/testing';
import { createFakeInstallationFiles } from './fake-installation-files.js';
import { createSystemd } from './systemd.js';
import { runUnitsCommand, type UnitsCommand } from './units-command.js';

/**
 * A machine for `agentplex start` and `agentplex stop` to be run against: a
 * prefix that is a table and a `systemctl` that is a lookup.
 *
 * Here rather than in either command's test file because both commands are the
 * same shell over a different act, so a machine described twice is two
 * descriptions that drift -- and the first thing to drift would be the layout
 * the shell derives its scope from, which is the part both commands have to
 * agree on. A fake is never copied.
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

export const HOME = '/home/alice';
export const PREFIX = `${HOME}/.agentplex`;
export const UNITS = `${HOME}/.config/systemd/user`;
export const HUB = 'agentplex-hub.service';
export const SERVER = 'agentplex-server.service';

const SHOW_PROPERTIES =
  '--property=LoadState --property=ActiveState --property=SubState ' +
  '--property=UnitFileState --property=ActiveEnterTimestamp';

export function show(scope: 'user' | 'system', unit: string): string {
  return `systemctl ${scope === 'user' ? '--user ' : ''}show ${unit} ${SHOW_PROPERTIES}`;
}

export function state(active: string, enabled = 'enabled'): ReturnType<typeof printed> {
  return printed(
    `LoadState=loaded\nActiveState=${active}\nSubState=running\nUnitFileState=${enabled}\n`,
  );
}

export function packageAt(name: string): string {
  return `${PREFIX}/lib/node_modules/${name}/package.json`;
}

const SETTINGS = `AGENTPLEX_ROLE=both\nAGENTPLEX_PREFIX=${PREFIX}\n`;

export interface Machine {
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

export interface Run {
  readonly code: number;
  readonly out: string;
  readonly errors: string;
  readonly runner: FakeProcessRunner;
}

export async function runOnMachine(
  command: UnitsCommand,
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

  const code = await runUnitsCommand(command, argv, {
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
