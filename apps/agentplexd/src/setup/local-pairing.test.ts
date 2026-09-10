import { describe, expect, it } from 'vitest';
import { createFakeStoreFiles } from '../server/fake-store-files.js';
import { localPairingFor } from './local-pairing.js';

/**
 * The bounds of the exception, asserted one at a time.
 *
 * "Pairing is always the user typing that server's token into the hub" has one
 * exception, and every clause of it is a case here: the same host, one process
 * that is both halves, a server reached over the loopback. What this file is
 * really about is the refusals -- the exception is worth nothing if the code
 * cannot be shown to stop where it says it does.
 */

const IDENTITY = '/home/dev/.agentplex/server.json';
const TOKEN = 'a-token-a-csprng-produced-for-this-machine';

function identityFile(token = TOKEN): Record<string, string> {
  return { [IDENTITY]: JSON.stringify({ serverId: 'server-under-test', token }) };
}

describe('localPairingFor', () => {
  it('pairs a hub and a server that are one process, over the loopback', async () => {
    const files = createFakeStoreFiles({ files: identityFile() });

    const decision = await localPairingFor(
      { role: 'both', serverPort: 8081, identityPath: IDENTITY },
      files,
    );

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

  it('refuses a server role: there is no hub on this machine to pair into', async () => {
    // The whole of the exception is a hub and a server the operator is
    // installing beside each other. A `--role=server` machine is one a hub
    // elsewhere has to be told about, which is the rule and not the exception.
    const files = createFakeStoreFiles({ files: identityFile() });

    const decision = await localPairingFor(
      { role: 'server', serverPort: 8081, identityPath: IDENTITY },
      files,
    );

    expect(decision.ok).toBe(false);
    expect(decision.ok ? '' : decision.reason).toContain('one process');
  });

  it('refuses a hub role: there is no server on this machine to pair', async () => {
    const files = createFakeStoreFiles({ files: identityFile() });

    const decision = await localPairingFor(
      { role: 'hub', serverPort: 8081, identityPath: IDENTITY },
      files,
    );

    expect(decision.ok).toBe(false);
  });

  it('takes the token off the disk and mints nothing when the file is not there', async () => {
    // A run whose identity file could not be written has nothing to pair with,
    // and the honest answer is to say so. Minting one here would pair the hub
    // with a token no server on this machine holds.
    const files = createFakeStoreFiles();

    const decision = await localPairingFor(
      { role: 'both', serverPort: 8081, identityPath: IDENTITY },
      files,
    );

    expect(decision.ok).toBe(false);
    expect(decision.ok ? '' : decision.reason).toContain(IDENTITY);
    expect(files.creates).toEqual([]);
  });

  it('reports an identity file it cannot read rather than writing over it', async () => {
    const files = createFakeStoreFiles({ files: identityFile(), unreadable: [IDENTITY] });

    const decision = await localPairingFor(
      { role: 'both', serverPort: 8081, identityPath: IDENTITY },
      files,
    );

    expect(decision.ok).toBe(false);
    expect(decision.ok ? '' : decision.reason).toContain('EACCES');
    expect(files.creates).toEqual([]);
  });

  it('refuses an identity file whose token is not one a hub could present', async () => {
    const files = createFakeStoreFiles({
      files: { [IDENTITY]: JSON.stringify({ serverId: 'server-under-test', token: '   ' }) },
    });

    const decision = await localPairingFor(
      { role: 'both', serverPort: 8081, identityPath: IDENTITY },
      files,
    );

    expect(decision.ok).toBe(false);
  });

  it('refuses a port that is not one, rather than pairing an address nothing binds', async () => {
    const files = createFakeStoreFiles({ files: identityFile() });

    const decision = await localPairingFor(
      { role: 'both', serverPort: 0, identityPath: IDENTITY },
      files,
    );

    expect(decision.ok).toBe(false);
  });

  it('never puts the token in a reason', async () => {
    // Every one of these reasons is printed to a terminal, and a terminal is a
    // scrollback. The file is named; its contents are not.
    const files = createFakeStoreFiles({ files: identityFile(), unreadable: [IDENTITY] });

    for (const role of ['hub', 'server', 'both'] as const) {
      const decision = await localPairingFor(
        { role, serverPort: 8081, identityPath: IDENTITY },
        files,
      );
      expect(decision.ok ? '' : decision.reason).not.toContain(TOKEN);
    }
  });
});
