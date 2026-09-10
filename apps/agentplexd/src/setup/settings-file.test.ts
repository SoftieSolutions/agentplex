import { describe, expect, it } from 'vitest';
import { upsertSettings } from './settings-file.js';

/**
 * Two lines into a file somebody else wrote, and nothing else in it touched.
 *
 * The file under test is the installer's: comments, the two lines it filled
 * in, and every other setting commented out so that setup can fill it in
 * later. What matters is that setup's lines land where a reader would look
 * for them and that an operator's edits survive a second run.
 */

const INSTALLED = [
  '# agentplexd settings, read by the systemd unit as an EnvironmentFile.',
  '',
  'AGENTPLEX_ROLE=both',
  '',
  '# The server beside the hub, for role=both.',
  '#AGENTPLEX_LOCAL_SERVER_IDENTITY_FILE=/var/lib/agentplex/server.json',
  '#AGENTPLEX_LOCAL_SERVER_PORT=8081',
  '',
].join('\n');

const IDENTITY = {
  key: 'AGENTPLEX_LOCAL_SERVER_IDENTITY_FILE',
  value: '/home/dev/.agentplex/server.json',
};
const PORT = { key: 'AGENTPLEX_LOCAL_SERVER_PORT', value: '9091' };

describe('upsertSettings', () => {
  it('fills in the commented-out line the installer left, in place', () => {
    const written = upsertSettings(INSTALLED, [IDENTITY, PORT]);

    expect(written.split('\n')).toEqual([
      '# agentplexd settings, read by the systemd unit as an EnvironmentFile.',
      '',
      'AGENTPLEX_ROLE=both',
      '',
      '# The server beside the hub, for role=both.',
      'AGENTPLEX_LOCAL_SERVER_IDENTITY_FILE=/home/dev/.agentplex/server.json',
      'AGENTPLEX_LOCAL_SERVER_PORT=9091',
      '',
    ]);
  });

  it('replaces a line that is already set, so a second run leaves one line', () => {
    const once = upsertSettings(INSTALLED, [IDENTITY, PORT]);
    const twice = upsertSettings(once, [IDENTITY, { key: PORT.key, value: '8081' }]);

    expect(twice.split('\n').filter((line) => line.startsWith(PORT.key))).toEqual([
      'AGENTPLEX_LOCAL_SERVER_PORT=8081',
    ]);
    expect(twice.split('\n').filter((line) => line.startsWith(IDENTITY.key))).toHaveLength(1);
  });

  it('appends a setting the file has never heard of', () => {
    const written = upsertSettings('AGENTPLEX_ROLE=hub\n', [PORT]);

    expect(written).toBe('AGENTPLEX_ROLE=hub\nAGENTPLEX_LOCAL_SERVER_PORT=9091\n');
  });

  it('writes a file that is not there yet as exactly the lines asked for', () => {
    expect(upsertSettings(null, [IDENTITY, PORT])).toBe(
      `${IDENTITY.key}=${IDENTITY.value}\n${PORT.key}=${PORT.value}\n`,
    );
  });

  it('leaves everything it was not asked about exactly as it found it', () => {
    const edited = `${INSTALLED}AGENTPLEX_CLIENT_TOKEN=an-operator-typed-this   \n# and a note\n`;

    const written = upsertSettings(edited, [PORT]);

    expect(written).toContain('AGENTPLEX_CLIENT_TOKEN=an-operator-typed-this   \n# and a note\n');
    expect(written).toContain(
      '#AGENTPLEX_LOCAL_SERVER_IDENTITY_FILE=/var/lib/agentplex/server.json',
    );
  });

  it('does not mistake a longer key for the one asked about', () => {
    const written = upsertSettings('AGENTPLEX_LOCAL_SERVER_PORT_OLD=1\n', [PORT]);

    expect(written).toBe('AGENTPLEX_LOCAL_SERVER_PORT_OLD=1\nAGENTPLEX_LOCAL_SERVER_PORT=9091\n');
  });

  it('quotes a value the EnvironmentFile reader would otherwise split', () => {
    const written = upsertSettings(null, [
      { key: IDENTITY.key, value: '/home/a person/.agentplex/server "prod".json' },
    ]);

    expect(written).toBe(
      'AGENTPLEX_LOCAL_SERVER_IDENTITY_FILE="/home/a person/.agentplex/server \\"prod\\".json"\n',
    );
  });
});
