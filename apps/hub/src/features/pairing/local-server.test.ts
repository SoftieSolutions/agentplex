import { describe, expect, it } from 'vitest';
import { createFakeStoreFiles } from '@agentplex/providers/testing';
import { localServerPairing } from './local-server.js';

/**
 * The bounds of the exception, asserted one at a time.
 *
 * "Pairing is always the user typing that server's token into the hub" has one
 * exception, and every clause of it is a case here: a server on this host,
 * reached over the loopback, named in the hub's own settings. What this file is
 * really about is the refusals -- the exception is worth nothing if the code
 * cannot be shown to stop where it says it does.
 */

const IDENTITY = '/home/dev/.agentplex/server.json';
const TOKEN = 'a-token-a-csprng-produced-for-this-machine';

function identityFile(token = TOKEN): Record<string, string> {
  return { [IDENTITY]: JSON.stringify({ serverId: 'server-under-test', token }) };
}

describe('localServerPairing', () => {
  it('pairs the server the settings name, over the loopback, with the token off its file', async () => {
    const files = createFakeStoreFiles({ files: identityFile() });

    const decision = await localServerPairing({ identityPath: IDENTITY, port: 8081 }, files);

    expect(decision).toEqual({
      ok: true,
      pairing: {
        label: 'this machine',
        address: 'ws://127.0.0.1:8081',
        serverId: 'server-under-test',
        token: TOKEN,
        identityPath: IDENTITY,
      },
    });
  });

  it('takes the token off the disk and mints nothing when the file is not there', async () => {
    // A settings entry whose identity file was never written names nothing to
    // pair with, and the honest answer is to say so. Minting one here would pair
    // the hub with a token no server on this machine holds.
    const files = createFakeStoreFiles();

    const decision = await localServerPairing({ identityPath: IDENTITY, port: 8081 }, files);

    expect(decision.ok).toBe(false);
    expect(decision.ok ? '' : decision.reason).toContain(IDENTITY);
    expect(files.creates).toEqual([]);
  });

  it('reports an identity file it cannot read rather than writing over it', async () => {
    const files = createFakeStoreFiles({ files: identityFile(), unreadable: [IDENTITY] });

    const decision = await localServerPairing({ identityPath: IDENTITY, port: 8081 }, files);

    expect(decision.ok).toBe(false);
    expect(decision.ok ? '' : decision.reason).toContain('EACCES');
    expect(files.creates).toEqual([]);
  });

  it('refuses an identity file whose token is not one a hub could present', async () => {
    const files = createFakeStoreFiles({
      files: { [IDENTITY]: JSON.stringify({ serverId: 'server-under-test', token: '   ' }) },
    });

    const decision = await localServerPairing({ identityPath: IDENTITY, port: 8081 }, files);

    expect(decision.ok).toBe(false);
  });

  it('refuses a port that is not one, rather than pairing an address nothing binds', async () => {
    const files = createFakeStoreFiles({ files: identityFile() });

    const decision = await localServerPairing({ identityPath: IDENTITY, port: 0 }, files);

    expect(decision.ok).toBe(false);
  });

  it('never puts the token in a refusal', async () => {
    const files = createFakeStoreFiles({ files: identityFile(), unreadable: [IDENTITY] });

    const decision = await localServerPairing({ identityPath: IDENTITY, port: 8081 }, files);

    expect(JSON.stringify(decision)).not.toContain(TOKEN);
  });
});
