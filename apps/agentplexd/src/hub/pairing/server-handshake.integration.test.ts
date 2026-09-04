import { afterEach, describe, expect, it } from 'vitest';
import type { HubId } from '@agentplex/protocol';
import { createFakeStoreFiles } from '../../server/fake-store-files.js';
import { createFakeProcessRunner } from '../../server/operations/fake-process-runner.js';
import { createOperationRegistry } from '../../server/operations/operation-registry.js';
import { createProviderRegistry } from '../../server/providers/provider-registry.js';
import { createFakePtyFactory } from '../../server/fake-pty.js';
import { createPtySupervisor } from '../../server/pty-supervisor.js';
import { createTerminalManager } from '../../server/terminal-manager.js';
import { startSessionServer, type SessionServer } from '../../server/server.js';
import { createLogger } from '../../shared/logger.js';
import { closure, CLOSE_POLICY, type SocketDialer } from '../../shared/message-socket.js';
import { systemTimers } from '../../shared/timers.js';
import { createWebSocketDialer } from '../../shared/ws-message-socket.js';
import { handshakeWithServer, type DialTarget } from './server-handshake.js';
import { serverAddressSchema } from './server-address.js';

/**
 * The handshake over a real socket, against the real server role.
 *
 * Everything the unit tests replace is present here: a websocket upgrade on
 * the port the server actually bound, `ws` on both ends, JSON on a wire, and a
 * server that minted its own identity on the way up. What it proves that no
 * fake can is that the two halves agree when nothing is standing in for the
 * transport.
 */

const logger = createLogger('error', () => {});
const clock = { now: () => 1_756_000_000_000 };
const ids = { newId: () => 'server-under-test' };
const TOKEN = 'the-token-the-operator-pasted';
const IDENTITY_PATH = '/etc/agentplexd/server.json';
const hubId = 'hub-under-test' as HubId;

let server: SessionServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function startServer(storePaths: readonly string[] = []) {
  const files = createFakeStoreFiles();
  return startSessionServer({
    logger,
    ids,
    host: '127.0.0.1',
    // Port 0: the OS picks, so two suites running at once cannot collide.
    port: 0,
    storePaths,
    storeFileSystem: files,
    identityPath: IDENTITY_PATH,
    tokens: { newToken: () => TOKEN },
    providers: createProviderRegistry([]),
    clock,
    terminals: createTerminalManager({
      supervisor: createPtySupervisor({
        pty: createFakePtyFactory(),
        clock,
        ids,
        environment: {},
      }),
      clock,
    }),
    operations: createOperationRegistry(createFakeProcessRunner()),
    timers: systemTimers,
    // This suite opens real sockets on loopback on purpose, and a broadcast is
    // the one thing it will not open: the handshake is what is under test, and
    // a beacon would put datagrams on the network of whoever runs the tests.
    // `null` is what a server without the setting is given.
    announce: null,
  });
}

/**
 * The real dialer, pointed at the loopback listener.
 *
 * `server-address.ts` refuses anything but `wss://`, because the token travels
 * on this socket and a pairing form is where somebody would otherwise type
 * `ws://`. A loopback socket in a test has no certificate authority to satisfy
 * and never leaves the machine, so the address is still parsed as the real
 * thing and only the dial is redirected — which keeps the parser in the test
 * rather than casting past it.
 */
function loopbackDialer(port: number): SocketDialer {
  const real = createWebSocketDialer();
  return { dial: () => real.dial(`ws://127.0.0.1:${port}`) };
}

function target(token = TOKEN): DialTarget {
  return { address: serverAddressSchema.parse('wss://box.example:8443'), token };
}

function dependencies(port: number) {
  return { dialer: loopbackDialer(port), hubId, timers: systemTimers, logger };
}

describe('the handshake over a real websocket', () => {
  it('completes against a server that minted its own identity and token', async () => {
    server = await startServer();

    const outcome = await handshakeWithServer(target(), dependencies(server.port));

    expect(outcome).toMatchObject({ ok: true, serverId: 'server-under-test', stores: [] });
    if (outcome.ok) outcome.socket.close({ code: 1000, reason: 'done' });
  });

  it('reports the stores the server has mounted', async () => {
    server = await startServer(['/volumes/claude']);

    const outcome = await handshakeWithServer(target(), dependencies(server.port));

    expect(outcome).toMatchObject({
      ok: true,
      stores: [{ storeId: 'server-under-test', path: '/volumes/claude' }],
    });
    if (outcome.ok) outcome.socket.close({ code: 1000, reason: 'done' });
  });

  it('shares the port the health check is on, so one inbound port is enough', async () => {
    server = await startServer();

    const health = await fetch(`http://127.0.0.1:${server.port}/health`);

    await expect(health.json()).resolves.toMatchObject({ status: 'ok', role: 'server' });
  });

  it('refuses a wrong token over the wire', async () => {
    server = await startServer();

    const outcome = await handshakeWithServer(target('a-guess'), dependencies(server.port));

    expect(outcome).toMatchObject({ ok: false, reason: 'unauthorized' });
  });

  it('reports a server that is not listening at all', async () => {
    server = await startServer();
    const port = server.port;
    await server.stop();
    server = undefined;

    const outcome = await handshakeWithServer(target(), dependencies(port));

    expect(outcome).toMatchObject({ ok: false, reason: 'unreachable' });
  });

  it('closes with an over-long reason without throwing', async () => {
    // `ws` throws a RangeError on a close reason over 123 bytes rather than
    // cutting it, and the reasons here are assembled from parser messages and
    // a peer's words. This is the guard running against the socket that has
    // the limit, not against a fake that agreed to have one.
    server = await startServer();
    const dialed = await loopbackDialer(server.port).dial('');
    expect(dialed.ok).toBe(true);
    if (!dialed.ok) return;

    expect(() => dialed.socket.close(closure(CLOSE_POLICY, 'why '.repeat(200)))).not.toThrow();
  });

  it('answers the same identity to a second hub, and to a reconnect', async () => {
    server = await startServer();

    const first = await handshakeWithServer(target(), dependencies(server.port));
    const second = await handshakeWithServer(target(), dependencies(server.port));

    expect(first).toMatchObject({ ok: true, serverId: 'server-under-test' });
    expect(second).toMatchObject({ ok: true, serverId: 'server-under-test' });
    if (first.ok) first.socket.close({ code: 1000, reason: 'done' });
    if (second.ok) second.socket.close({ code: 1000, reason: 'done' });
  });
});
