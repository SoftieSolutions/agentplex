import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SETTINGS_FILE_NAME,
  SYSTEM_CONFIG_DIR,
  SYSTEM_PREFIX,
  SYSTEM_UNIT_DIR,
  nodeBinary,
  nodeStampFile,
  packageDirectory,
  systemLayout,
  unitFile,
  userLayout,
} from './layout.js';

/**
 * The two layouts, held against the script that creates them.
 *
 * This is the only tie there can be. `install.sh` is fetched over HTTPS and run
 * on a machine with nothing on it, so it can import nothing and nothing can
 * import it -- which leaves its own source text, read here the way
 * `install.sh.integration.test.ts` reads the assembler's table to hold the
 * script against it. The failure this stops is a rename in one of the two
 * places: an installer that writes `/etc/agentplex/agentplex.env` and a `status`
 * that looks in `/etc/agentplex.env` is a command that reports every correctly
 * installed fleet machine as having no agentplex on it.
 *
 * Read as `readonly NAME='value'` because that is the one shape the script
 * declares these in, and a constant that stopped being `readonly` would fail
 * here rather than silently stop being checked.
 */
const SCRIPT = readFileSync(
  fileURLToPath(new URL('../../../../scripts/install.sh', import.meta.url)),
  'utf8',
);

function declared(name: string): string {
  const found = new RegExp(`^readonly ${name}='([^']*)'$`, 'm').exec(SCRIPT)?.[1];
  expect(found, `install.sh declares no ${name}`).toBeDefined();
  return found ?? '';
}

describe('the layouts', () => {
  it('put the fleet install where install.sh puts it', () => {
    expect(SYSTEM_PREFIX).toBe(declared('SYSTEM_PREFIX'));
    expect(SYSTEM_CONFIG_DIR).toBe(declared('SYSTEM_CONFIG_DIR'));
    expect(SYSTEM_UNIT_DIR).toBe(declared('SYSTEM_UNIT_DIR'));
  });

  it('name the settings file the way the installer and the units do', () => {
    // The installer builds both paths out of this one word; the two expressions
    // below are the two branches of `resolve_layout`, quoted.
    expect(SCRIPT).toContain(`ENV_FILE="$SYSTEM_CONFIG_DIR/${SETTINGS_FILE_NAME}"`);
    expect(SCRIPT).toContain(`ENV_FILE="$PREFIX/${SETTINGS_FILE_NAME}"`);
  });

  it('put a user install under the home the script does, with the units systemd reads', () => {
    const layout = userLayout('/home/alice');

    expect(layout).toEqual({
      scope: 'user',
      prefix: '/home/alice/.agentplex',
      settingsFile: '/home/alice/.agentplex/agentplex.env',
      unitDirectory: '/home/alice/.config/systemd/user',
    });
    // Both from `resolve_layout`'s other branch.
    expect(SCRIPT).toContain('PREFIX="$HOME/.agentplex"');
    expect(SCRIPT).toContain('UNIT_DIR="$HOME/.config/systemd/user"');
  });

  it('leave the fleet settings file outside the prefix, which is the whole wrinkle', () => {
    // The one thing a reader would get wrong by assuming the two layouts are
    // the same shape: under `--system` the settings file is root's, under
    // `/etc`, and moving the prefix does not move it.
    expect(systemLayout('/srv/agentplex').settingsFile).toBe('/etc/agentplex/agentplex.env');
    expect(userLayout('/home/alice', '/srv/agentplex').settingsFile).toBe(
      '/srv/agentplex/agentplex.env',
    );
  });

  it('name a unit file the same in both scopes, which is why the scope is carried', () => {
    expect(unitFile(systemLayout(), 'agentplex-hub.service')).toBe(
      '/etc/systemd/system/agentplex-hub.service',
    );
    expect(unitFile(userLayout('/home/alice'), 'agentplex-hub.service')).toBe(
      '/home/alice/.config/systemd/user/agentplex-hub.service',
    );
  });

  it('find a package where npm put it and a runtime where the script stamped one', () => {
    const layout = userLayout('/home/alice');

    expect(packageDirectory(layout, '@softiesolutions/agentplex-hub')).toBe(
      '/home/alice/.agentplex/lib/node_modules/@softiesolutions/agentplex-hub',
    );
    expect(nodeStampFile(layout)).toBe('/home/alice/.agentplex/node/.agentplex-node-version');
    expect(nodeBinary(layout)).toBe('/home/alice/.agentplex/node/bin/node');
    // The stamp's name, and the directory it goes in, both out of the script.
    expect(declared('NODE_STAMP')).toBe('.agentplex-node-version');
    expect(SCRIPT).toContain('NODE_HOME="$PREFIX/node"');
  });
});
