import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { systemLayout, userLayout } from './layout.js';
import { renderSettings } from './settings-template.js';

/**
 * The settings file, held byte for byte against files `install.sh` wrote on
 * machines it really installed: `fixtures/settings/`, with the commands that
 * captured them in `CAPTURE.txt`. A change to `write_environment_file`
 * re-captures those, and this is what fails until the same change lands here.
 */

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./fixtures/settings/${name}`, import.meta.url)),
    'utf8',
  );
}

describe('renderSettings', () => {
  it('writes what install.sh wrote for a per-user hub', () => {
    expect(renderSettings('hub', userLayout('/home/alice'))).toBe(fixture('user.env'));
  });

  it('writes what install.sh wrote for a --system hub', () => {
    expect(renderSettings('hub', systemLayout())).toBe(fixture('system.env'));
  });

  it('records the role it was given and the prefix it was given', () => {
    const text = renderSettings('both', userLayout('/home/alice', '/srv/agentplex'));

    expect(text).toContain('\nAGENTPLEX_ROLE=both\n');
    expect(text).toContain('\nAGENTPLEX_PREFIX=/srv/agentplex\n');
    expect(text).toContain('\nAGENTPLEX_BIN_PATH=/srv/agentplex/bin\n');
    // The state directory is the prefix on this tier, so the identity line
    // names the file there, commented until setup mints it.
    expect(text).toContain('\n#AGENTPLEX_SERVER_IDENTITY_FILE=/srv/agentplex/server.json\n');
  });
});
