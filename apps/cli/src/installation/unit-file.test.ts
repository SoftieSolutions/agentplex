import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { systemLayout, userLayout, type Layout } from './layout.js';
import { declared } from './test-install-script.js';
import { DOCS_URL, renderUnit, unitFileName, unitSearchPath, type Daemon } from './unit-file.js';

/**
 * The renderer, held byte for byte against what `install.sh --print-unit`
 * printed for the same role, scope and prefix while the script still rendered
 * units itself.
 *
 * The fixtures are the script's own output, captured in a container as
 * `fixtures/units/CAPTURE.txt` records, so nothing here is a unit somebody
 * typed. Each case names the inputs the script resolved on that machine: the
 * home `alice` had, the default prefix of the scope, and the directory
 * `resolve_node_directory` settled on -- `<prefix>/node/bin` where the image
 * had no node, `/usr/local/bin` where it adopted the image's own.
 *
 * The script renders no unit now, so these are what every machine installed
 * before the handover carries, and a unit this writes has to match them. A
 * deliberate change to the unit re-captures them, and this is what fails until
 * it has. The cases after the fixtures state the decisions inside the text
 * outright, so a re-capture that lost one fails for that reason and not only
 * as a changed byte.
 */

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/units/${name}`, import.meta.url)), 'utf8');
}

const USER = userLayout('/home/alice');
const SYSTEM = systemLayout();

interface Case {
  readonly fixture: string;
  readonly daemons: readonly Daemon[];
  readonly layout: Layout;
  readonly nodeDirectory: string;
}

const CASES: readonly Case[] = [
  {
    fixture: 'hub-user.service',
    daemons: ['hub'],
    layout: USER,
    nodeDirectory: '/home/alice/.agentplex/node/bin',
  },
  {
    fixture: 'server-user.service',
    daemons: ['server'],
    layout: USER,
    nodeDirectory: '/home/alice/.agentplex/node/bin',
  },
  {
    fixture: 'both-user.service',
    daemons: ['hub', 'server'],
    layout: USER,
    nodeDirectory: '/home/alice/.agentplex/node/bin',
  },
  {
    fixture: 'hub-system.service',
    daemons: ['hub'],
    layout: SYSTEM,
    nodeDirectory: '/opt/agentplex/node/bin',
  },
  {
    fixture: 'server-system.service',
    daemons: ['server'],
    layout: SYSTEM,
    nodeDirectory: '/opt/agentplex/node/bin',
  },
  {
    fixture: 'both-system.service',
    daemons: ['hub', 'server'],
    layout: SYSTEM,
    nodeDirectory: '/opt/agentplex/node/bin',
  },
  // The adopted runtime: node:24-bookworm-slim's own node, in a directory the
  // standard search path already lists, so the PATH line does not name it
  // twice while ExecStart still names it outright.
  {
    fixture: 'server-user-adopted.service',
    daemons: ['server'],
    layout: USER,
    nodeDirectory: '/usr/local/bin',
  },
];

describe('renderUnit', () => {
  for (const one of CASES) {
    it(`renders ${one.fixture} as install.sh --print-unit printed it`, () => {
      const rendered = one.daemons
        .map((daemon) => renderUnit(daemon, one.layout, one.nodeDirectory))
        .join('');

      expect(rendered).toBe(fixture(one.fixture));
    });
  }

  it('offers reload on the server and not on the hub, whose SIGHUP would be an exit', () => {
    for (const layout of [USER, SYSTEM]) {
      expect(renderUnit('server', layout, '/usr/local/bin')).toContain(
        "ExecReload=/bin/sh -c 'kill -HUP $MAINPID'\n",
      );
      expect(renderUnit('hub', layout, '/usr/local/bin')).not.toContain('ExecReload');
    }
  });

  it('signals the server alone on stop, in both scopes, so its agents wait for the drain', () => {
    // systemd's default, control-group, sends SIGTERM to every process in the
    // unit at once: the agents a session runs are in that cgroup, so they die
    // in the same millisecond the server starts draining for them. mixed sends
    // SIGTERM to the main process alone and SIGKILLs whatever is left once it
    // has exited, which is what makes the drain a drain.
    for (const layout of [USER, SYSTEM]) {
      const lines = renderUnit('server', layout, '/usr/local/bin').split('\n');
      expect(lines.filter((line) => line === 'KillMode=mixed')).toHaveLength(1);
      expect(lines.filter((line) => line.startsWith('KillMode='))).toHaveLength(1);
    }
  });

  it('gives the hub no KillMode in either scope, because it runs no children to spare', () => {
    for (const layout of [USER, SYSTEM]) {
      const lines = renderUnit('hub', layout, '/usr/local/bin').split('\n');
      expect(lines.filter((line) => line.startsWith('KillMode='))).toEqual([]);
    }
  });

  it('gives the drain less time than systemd gives the whole stop, with a real margin', () => {
    const unit = renderUnit('server', USER, '/usr/local/bin');
    const drain = /^Environment=AGENTPLEX_SERVER_DRAIN_SECONDS=(\d+)$/m.exec(unit)?.[1];
    const stop = /^TimeoutStopSec=(\d+)s$/m.exec(unit)?.[1];

    expect(drain, 'the unit sets no drain budget').toBeDefined();
    expect(stop, 'the unit sets no stop timeout').toBeDefined();
    expect(Number(drain)).toBeLessThan(Number(stop));
    // What is left is what the process has to kill the stragglers, close its
    // sockets and exit.
    expect(Number(stop) - Number(drain)).toBeGreaterThanOrEqual(5);
  });

  it('runs a user unit as its user, and a system unit as the service account', () => {
    const user = renderUnit('server', USER, '/usr/local/bin').split('\n');
    const system = renderUnit('server', SYSTEM, '/usr/local/bin').split('\n');

    // A user unit runs as its user, and a line naming one would be a claim
    // this scope cannot make.
    expect(user.filter((line) => /^(User|Group)=/.test(line))).toEqual([]);
    expect(user).toContain('WantedBy=default.target');
    expect(system).toContain('User=agentplex');
    expect(system).toContain('Group=agentplex');
    expect(system).toContain('WantedBy=multi-user.target');
  });

  it('orders against network-online.target in system scope only, where it exists', () => {
    // A unit of the system manager: the user manager's search paths hold no
    // such file, so these lines in a user unit would order against nothing and
    // tell the reader a guarantee that is not one.
    const user = renderUnit('hub', USER, '/usr/local/bin');
    const system = renderUnit('hub', SYSTEM, '/usr/local/bin');

    expect(user).not.toContain('network-online.target');
    expect(system).toContain('\nAfter=network-online.target\nWants=network-online.target\n');
  });

  it('stops rather than restarting when the configuration is what is wrong', () => {
    // Exit 2 is the daemon saying its configuration is wrong: restarting will
    // not help.
    const unit = renderUnit('hub', USER, '/usr/local/bin');
    expect(unit).toContain('\nRestart=on-failure\n');
    expect(unit).toContain('\nRestartPreventExitStatus=2\n');
  });

  it('carries no sandboxing, because the service exists to reach the operator files', () => {
    for (const layout of [USER, SYSTEM]) {
      const lines = renderUnit('server', layout, '/usr/local/bin').split('\n');
      for (const directive of [
        'ProtectHome=',
        'ProtectSystem=',
        'NoNewPrivileges=',
        'PrivateTmp=',
      ]) {
        expect(lines.filter((line) => line.startsWith(directive))).toEqual([]);
      }
    }
  });

  it('starts each daemon by naming the interpreter and its own package entry', () => {
    const lines = ['hub', 'server'].map(
      (daemon) =>
        renderUnit(daemon as Daemon, USER, '/home/alice/.agentplex/node/bin')
          .split('\n')
          .find((line) => line.startsWith('ExecStart=')) ?? '',
    );
    expect(lines).toEqual([
      'ExecStart=/home/alice/.agentplex/node/bin/node /home/alice/.agentplex/lib/node_modules/@softiesolutions/agentplex-hub/apps/hub/dist/main.js',
      'ExecStart=/home/alice/.agentplex/node/bin/node /home/alice/.agentplex/lib/node_modules/@softiesolutions/agentplex-server/apps/server/dist/main.js',
    ]);
  });

  it('names the unit file as the script does, one per daemon', () => {
    expect(unitFileName('hub')).toBe('agentplex-hub.service');
    expect(unitFileName('server')).toBe('agentplex-server.service');
  });
});

describe('unitSearchPath', () => {
  it('names the node directory only when it is neither the bin directory nor a standard one', () => {
    const standard = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

    expect(unitSearchPath(USER, '/home/alice/.nvm/versions/node/v24.9.0/bin')).toBe(
      `/home/alice/.agentplex/bin:/home/alice/.nvm/versions/node/v24.9.0/bin:${standard}`,
    );
    expect(unitSearchPath(USER, '/usr/bin')).toBe(`/home/alice/.agentplex/bin:${standard}`);
    expect(unitSearchPath(USER, '/home/alice/.agentplex/bin')).toBe(
      `/home/alice/.agentplex/bin:${standard}`,
    );
  });
});

describe('the documentation every unit names', () => {
  it('is the one install.sh prints', () => {
    expect(DOCS_URL).toBe(declared('DOCS_URL'));
  });
});
