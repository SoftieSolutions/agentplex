import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { systemLayout, userLayout, type Layout } from './layout.js';
import { declared } from './test-install-script.js';
import {
  DOCS_URL,
  STOP_KILL_MARGIN_SECONDS,
  STOP_TIMEOUT_SECONDS,
  renderUnit,
  unitFileName,
  unitSearchPath,
  type Daemon,
} from './unit-file.js';

/**
 * The renderer, held byte for byte against what `install.sh --print-unit`
 * printed for the same role, scope and prefix.
 *
 * The fixtures are the script's own output, captured in a container as
 * `fixtures/units/CAPTURE.txt` records, so nothing here is a unit somebody
 * typed. Each case names the inputs the script resolved on that machine: the
 * home `alice` had, the default prefix of the scope, and the directory
 * `resolve_node_directory` settled on -- `<prefix>/node/bin` where the image
 * had no node, `/usr/local/bin` where it adopted the image's own.
 *
 * A later change to `render_unit` re-captures, and this is what fails until it
 * has: the renderer and the script cannot drift without one of these files
 * changing.
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

describe('the constants the unit is rendered from', () => {
  it('are the ones install.sh declares', () => {
    expect(String(STOP_TIMEOUT_SECONDS)).toBe(declared('STOP_TIMEOUT_SECONDS'));
    expect(String(STOP_KILL_MARGIN_SECONDS)).toBe(declared('STOP_KILL_MARGIN_SECONDS'));
    expect(DOCS_URL).toBe(declared('DOCS_URL'));
  });
});
