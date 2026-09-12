import { afterEach, describe, expect, it } from 'vitest';
import type { HubId } from '@agentplex/protocol';
import {
  createFakeGrantFiles,
  createFakeProcessRunner,
  createFakeStoreFiles,
  type FakeGrantFiles,
} from '@agentplex/providers/testing';
import {
  createProviderRegistry,
  openServerGrants,
  parseServerGrants,
  serverGrantsPath,
} from '@agentplex/providers';
import {
  createLogger,
  createWebSocketDialer,
  randomTokenMinter,
  systemTimers,
  type SocketDialer,
} from '@agentplex/node-shared';
import { createFakePtyFactory } from '@agentplex/pty/testing';
import { createPtySupervisor } from '@agentplex/pty';
import { createOperationRegistry } from '../../../apps/server/src/operations/operation-registry.js';
import { createTerminalManager } from '../../../apps/server/src/terminal-manager.js';
import { startSessionServer, type SessionServer } from '../../../apps/server/src/server.js';
import { localServerPairing } from '../../../apps/hub/src/pairing/local-server.js';
import {
  handshakeWithServer,
  type DialTarget,
} from '../../../apps/hub/src/pairing/server-handshake.js';
import { serverAddressSchema } from '../../../apps/hub/src/pairing/server-address.js';

/**
 * The `--role=both` box, end to end, across the change that introduced grants.
 *
 * This is the migration's whole risk in one test. `local-server.ts` pairs the
 * server beside the hub by reading the token out of the identity file, and all
 * four of its structural bounds depend on the token being in that file: the
 * exception it grants is narrow precisely because what the hub is handed is a
 * file the operator's setup wrote, not a claim off a socket. Grants must not
 * move that token, and this asserts they did not -- the hub reads the same file
 * with the same parser, and the token it finds still completes a handshake
 * against a server that now resolves it to a grant.
 *
 * It is here rather than in either app because it is exactly the thing neither
 * can prove alone: the hub's reader, the server's minting and the socket
 * between them.
 */

const logger = createLogger('error', () => {});
const clock = { now: () => 1_756_000_000_000 };
const ids = { newId: () => 'server-on-this-machine' };
const IDENTITY_PATH = '/etc/agentplex/server.json';
const hubId = 'hub-on-this-machine' as HubId;

let server: SessionServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

/**
 * One machine's disks: the volume the identity file is on, and the one the
 * grants file is on beside it. Two seams because the server has two, and the
 * hub is handed only the first -- which is the point.
 */
function machine() {
  return { files: createFakeStoreFiles(), grantFiles: createFakeGrantFiles() };
}

async function startServer({
  files,
  grantFiles,
}: {
  files: ReturnType<typeof createFakeStoreFiles>;
  grantFiles: FakeGrantFiles;
}): Promise<SessionServer> {
  return startSessionServer({
    logger,
    ids,
    host: '127.0.0.1',
    port: 0,
    storePaths: [],
    storeFileSystem: files,
    identityPath: IDENTITY_PATH,
    grantFileSystem: grantFiles,
    // A real minter, because what this test is about is the operator never
    // seeing the token: the hub reads whatever the server wrote.
    tokens: randomTokenMinter,
    serverToken: undefined,
    providers: createProviderRegistry([]),
    preflight: { run: async () => [] },
    clock,
    terminals: createTerminalManager({
      supervisor: createPtySupervisor({ pty: createFakePtyFactory(), clock, ids, environment: {} }),
      clock,
    }),
    operations: createOperationRegistry(createFakeProcessRunner()),
    timers: systemTimers,
    announce: null,
  });
}

/** The real dialer, redirected at loopback. See `server-handshake.integration`. */
function loopbackDialer(port: number): SocketDialer {
  const real = createWebSocketDialer();
  return { dial: () => real.dial(`ws://127.0.0.1:${port}`) };
}

function target(token: string): DialTarget {
  return { address: serverAddressSchema.parse('wss://box.example:8443'), token };
}

describe('the hub pairing the server on its own machine', () => {
  it('reads a token off the identity file that the server still accepts', async () => {
    const disks = machine();
    server = await startServer(disks);

    // The hub's own boot step, unchanged by this work: a file, not a claim.
    const decision = await localServerPairing(
      { identityPath: IDENTITY_PATH, port: server.port },
      disks.files,
    );
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;

    const outcome = await handshakeWithServer(target(decision.pairing.token), {
      dialer: loopbackDialer(server.port),
      hubId,
      timers: systemTimers,
      logger,
    });

    expect(outcome).toMatchObject({ ok: true, serverId: decision.pairing.serverId });
  });

  /**
   * The migration, stated as a fact about the disk: the identity file keeps
   * holding `token`, and the grants file beside it holds one record for it.
   */
  it('writes grant zero for the token the identity file holds, and nothing else', async () => {
    const disks = machine();
    server = await startServer(disks);

    const written = disks.grantFiles.written(serverGrantsPath(IDENTITY_PATH));
    expect(written).toBeDefined();
    const parsed = parseServerGrants(written ?? '');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.grants).toHaveLength(1);

    // And the token is not in it. What the operator reads out of the identity
    // file is a secret; what is beside it is a verifier of one.
    const decision = await localServerPairing(
      { identityPath: IDENTITY_PATH, port: server.port },
      disks.files,
    );
    if (!decision.ok) throw new Error(decision.reason);
    expect(written).not.toContain(decision.pairing.token);
  });

  /**
   * Revoking grant zero is permitted and its consequence is the honest one: the
   * hub on the same machine stops connecting. `local-server.ts` already refuses
   * to restore a revoked pairing at boot on the grounds that a revocation is a
   * person having said no, and this is that same rule seen from the server's
   * end.
   */
  it('refuses the identity file token once its grant is revoked, saying no more than that', async () => {
    const disks = machine();
    server = await startServer(disks);
    const decision = await localServerPairing(
      { identityPath: IDENTITY_PATH, port: server.port },
      disks.files,
    );
    if (!decision.ok) throw new Error(decision.reason);

    // The operator, on this machine, against a daemon that is already running.
    const grants = await openServerGrants(serverGrantsPath(IDENTITY_PATH), decision.pairing.token, {
      files: disks.grantFiles,
      ids,
      tokens: randomTokenMinter,
      clock,
    });
    if (!grants.ok) throw new Error(grants.problem);
    const listed = await grants.store.list();
    if (!listed.ok) throw new Error(listed.problem);
    const zero = listed.grants[0];
    if (zero === undefined) throw new Error('there was no grant zero to revoke');
    await grants.store.revoke(zero.grantId);

    const outcome = await handshakeWithServer(target(decision.pairing.token), {
      dialer: loopbackDialer(server.port),
      hubId,
      timers: systemTimers,
      logger,
    });

    expect(outcome).toMatchObject({ ok: false });
    // The same refusal a wrong token gets, with nothing in it that would tell a
    // guesser the credential had ever been real.
    expect(JSON.stringify(outcome)).not.toContain('revoked');
  });
});
