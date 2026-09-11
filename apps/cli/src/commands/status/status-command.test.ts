import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
import { runStatusCommand } from './status-command.js';

/**
 * `agentplex status` against a prefix that is a table.
 *
 * The subject is installation state -- packages, units, runtime -- and the
 * assertions below are deliberately about what is *reported*, not about what
 * this machine can do. That second question is `doctor`'s, and the last case
 * here is the one that keeps the two from growing into each other.
 */

const HOME = '/home/alice';
const PREFIX = `${HOME}/.agentplex`;
const UNITS = `${HOME}/.config/systemd/user`;
const HUB = 'agentplex-hub.service';
const SERVER = 'agentplex-server.service';

const SHOW_PROPERTIES =
  '--property=LoadState --property=ActiveState --property=SubState ' +
  '--property=UnitFileState --property=ActiveEnterTimestamp';

function show(unit: string): string {
  return `systemctl --user show ${unit} ${SHOW_PROPERTIES}`;
}

function state(active: string, enabled = 'enabled', since = ''): ReturnType<typeof printed> {
  return printed(
    [
      'LoadState=loaded',
      `ActiveState=${active}`,
      'SubState=running',
      `UnitFileState=${enabled}`,
      `ActiveEnterTimestamp=${since}`,
    ].join('\n'),
  );
}

function manifest(version: string, protocol: number | null): string {
  return JSON.stringify(protocol === null ? { version } : { version, agentplex: { protocol } });
}

function packageAt(name: string): string {
  return `${PREFIX}/lib/node_modules/${name}/package.json`;
}

function wholeMachine(): Record<string, string> {
  return {
    [`${PREFIX}/agentplex.env`]: `AGENTPLEX_ROLE=both\nAGENTPLEX_PREFIX=${PREFIX}\n`,
    [packageAt('@softiesolutions/agentplex')]: manifest('1.4.0', 3),
    [packageAt('@softiesolutions/agentplex-hub')]: manifest('1.2.0', 3),
    [packageAt('@softiesolutions/agentplex-server')]: manifest('1.5.0', 3),
    [packageAt('@softiesolutions/agentplex-web')]: manifest('1.1.0', 3),
    [`${PREFIX}/node/.agentplex-node-version`]: 'v24.9.0\n',
  };
}

interface Run {
  readonly code: number;
  readonly out: string;
  readonly errors: string;
  readonly runner: FakeProcessRunner;
}

async function run(
  argv: readonly string[] = [],
  machine: {
    readonly files?: Readonly<Record<string, string>>;
    readonly units?: readonly string[];
    readonly systemd?: boolean;
    readonly outcomes?: Readonly<Record<string, ReturnType<typeof printed>>>;
  } = {},
): Promise<Run> {
  const out: string[] = [];
  const errors: string[] = [];
  const runner = createFakeProcessRunner({ outcomes: machine.outcomes ?? {} });
  const programs: ProgramResolver = {
    resolve: async (name) =>
      (machine.systemd ?? true) && name === 'systemctl' ? '/usr/bin' : null,
  };

  const code = await runStatusCommand(argv, {
    home: HOME,
    files: createFakeInstallationFiles({
      files: machine.files ?? wholeMachine(),
      present: (machine.units ?? []).map((unit) => `${UNITS}/${unit}`),
    }),
    systemd: createSystemd({ runner, programs }),
    write: (line) => out.push(line),
    writeError: (line) => errors.push(line),
  });

  return { code, out: out.join('\n'), errors: errors.join('\n'), runner };
}

describe('what agentplex status reports', () => {
  it('names the prefix, the scope, the role and every installed package', async () => {
    const status = await run([], {
      units: [HUB, SERVER],
      outcomes: {
        [show(HUB)]: state('active', 'enabled', 'Thu 2026-09-11 09:12:03 UTC'),
        [show(SERVER)]: state('inactive'),
      },
    });

    expect(status.code).toBe(0);
    expect(status.errors).toBe('');
    expect(status.out).toContain(`prefix=${PREFIX}   scope=user   role=both`);
    expect(status.out).toMatch(/^ {2}cli {6}1\.4\.0 {8}protocol 3$/m);
    expect(status.out).toMatch(/^ {2}hub {6}1\.2\.0 {8}protocol 3$/m);
    expect(status.out).toMatch(/^ {2}server {3}1\.5\.0 {8}protocol 3$/m);
    expect(status.out).toMatch(/^ {2}web {6}1\.1\.0 {8}protocol 3$/m);
    expect(status.out).toContain('node v24.9.0   installed by install.sh');
  });

  it('prints the timestamp systemd printed rather than a relative time', async () => {
    const status = await run([], {
      units: [HUB],
      outcomes: { [show(HUB)]: state('active', 'enabled', 'Thu 2026-09-11 09:12:03 UTC') },
    });

    // Shortening it to "since 09:12" needs a clock and a timezone this command
    // was never given, and a relative time is the one form that stops meaning
    // anything the moment it is pasted into an issue.
    expect(status.out).toContain('Thu 2026-09-11 09:12:03 UTC');
  });

  it('reports a package a role does not install as absent, and exits 0', async () => {
    const files = wholeMachine();
    delete files[packageAt('@softiesolutions/agentplex-server')];

    const status = await run([], {
      files,
      units: [HUB],
      outcomes: { [show(HUB)]: state('active') },
    });

    expect(status.code).toBe(0);
    expect(status.out).toMatch(/^ {2}server {3}absent/m);
  });

  it('lets an unreadable manifest cost itself and names the package to go and look at', async () => {
    const status = await run([], {
      files: { ...wholeMachine(), [packageAt('@softiesolutions/agentplex-hub')]: '{ nope' },
    });

    expect(status.code).toBe(0);
    expect(status.out).toMatch(/^ {2}hub {6}unreadable/m);
    expect(status.out).toContain('@softiesolutions/agentplex-hub: not JSON');
    // The other three are still there, which is the rule an unreadable item
    // follows everywhere here: it costs itself, not the listing.
    expect(status.out).toContain('1.5.0');
  });

  it('says an adopted runtime is adopted rather than calling it missing', async () => {
    const files = wholeMachine();
    delete files[`${PREFIX}/node/.agentplex-node-version`];

    const status = await run([], { files });

    expect(status.out).toContain('install.sh stamps a runtime only when it installed one');
  });
});

describe('the exit code', () => {
  it('is 1 when a unit is failed, which is the machine saying so and not this command', async () => {
    const status = await run([], {
      units: [HUB, SERVER],
      outcomes: { [show(HUB)]: state('failed'), [show(SERVER)]: state('active') },
    });

    expect(status.code).toBe(1);
    expect(status.out).toMatch(/agentplex-hub\.service\s+failed/);
  });

  it('is 0 for a unit that is enabled and not running, because intent is unreadable', async () => {
    // Suspicious, and also exactly what a machine mid-maintenance looks like,
    // and what a machine whose operator stopped one daemon this morning looks
    // like. It is reported in the line and the person reading decides.
    const status = await run([], {
      units: [SERVER],
      outcomes: { [show(SERVER)]: state('inactive', 'enabled') },
    });

    expect(status.code).toBe(0);
    expect(status.out).toMatch(/agentplex-server\.service\s+inactive\s+enabled/);
  });

  it('is 2 for a directory that is not an agentplex prefix, with the usage on stderr', async () => {
    const status = await run(['--prefix', '/srv/nothing'], { files: {} });

    expect(status.code).toBe(2);
    expect(status.out).toBe('');
    expect(status.errors).toContain('/srv/nothing/agentplex.env');
    expect(status.errors).toContain('Usage: agentplex status');
  });
});

describe('a machine with nothing to ask', () => {
  it('lists a unit file with nothing claimed about it when there is no systemd', async () => {
    const status = await run([], { units: [HUB], systemd: false });

    expect(status.code).toBe(0);
    // The unit is a file this machine has, so it is listed. What it is doing is
    // not claimed, because nothing here could have asked.
    expect(status.out).toContain(HUB);
    expect(status.out).toContain('there is no systemctl on this machine');
    // Asked nothing rather than asked and refused once per unit.
    expect(status.runner.requests).toEqual([]);
  });

  it('reports a manager that would not answer as unknown rather than as stopped', async () => {
    const status = await run([], {
      units: [HUB],
      outcomes: { [show(HUB)]: refused(1, 'Failed to connect to bus: No medium found') },
    });

    expect(status.code).toBe(0);
    expect(status.out).toContain('Failed to connect to bus');
    expect(status.out).not.toContain('inactive');
  });

  it('says there is no unit at all rather than printing an empty block', async () => {
    const status = await run();

    expect(status.out).toContain(`none in ${UNITS}`);
  });
});

describe('whether the components on this machine can talk to each other', () => {
  it('says so when they disagree, and names what each one speaks', async () => {
    const status = await run([], {
      files: {
        ...wholeMachine(),
        [packageAt('@softiesolutions/agentplex-hub')]: manifest('2.0.0', 4),
      },
    });

    expect(status.out).toContain('these components do not agree');
    expect(status.out).toMatch(/^ {4}hub {6}protocol 4$/m);
    expect(status.out).toMatch(/^ {4}server {3}protocol 3$/m);
    // Reported, and not the exit code. That code answers "did anything on this
    // machine fail to run", and widening it to "is anything about this machine
    // wrong" would make it the doctor's verdict under another name.
    expect(status.code).toBe(0);
  });

  it('says nothing at all when they agree', async () => {
    expect((await run()).out).not.toContain('do not agree');
  });
});

describe('what status refuses to do', () => {
  it('spawns nothing but systemctl, however much of a machine it is given', async () => {
    const status = await run([], {
      units: [HUB, SERVER],
      outcomes: { [show(HUB)]: state('active'), [show(SERVER)]: state('active') },
    });

    // The whole of what this command does to a machine, in one assertion.
    expect(status.runner.requests.map((request) => request.file)).toEqual([
      'systemctl',
      'systemctl',
    ]);
  });

  it('reaches no network, which is the boundary the update command is on the other side of', () => {
    // A source-level check, because the honest version of "it made no request"
    // is "there is nothing here that could make one". The version oracle -- the
    // release manifest fetch, its cache, and the "a newer version is available"
    // column -- belongs to the update command, and this is what would notice a
    // fetch arriving here instead.
    const sources = [
      'status.ts',
      'status-command.ts',
      'main.ts',
      '../../installation/installation.ts',
      '../../installation/systemd.ts',
      '../../installation/units.ts',
      '../../installation/node-installation-files.ts',
    ].map((name) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8'));

    for (const source of sources) {
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const reach of [
        'fetch(',
        "'node:http",
        "'node:https",
        "'node:net",
        'undici',
        'XMLHttp',
      ]) {
        expect(code).not.toContain(reach);
      }
    }
  });
});
