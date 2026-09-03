import { describe, expect, it } from 'vitest';
import {
  parseHubToServerFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  type HubId,
  type StoreDescriptor,
  type StoreId,
} from '@agentplex/protocol';
import { serveHubConnection } from '../../server/hub-connection.js';
import type { ServerIdentity } from '../../server/server-identity.js';
import {
  createFakeDialer,
  createFakeMessageSocket,
  createSocketPair,
  createUnreachableDialer,
  PEER_GONE,
  type FakeMessageSocket,
} from '../../shared/fake-message-socket.js';
import { createLogger } from '../../shared/logger.js';
import { createFakeTimers } from '../../shared/timers.js';
import { handshakeWithServer, type DialTarget } from './server-handshake.js';
import type { ServerAddress } from './server-address.js';
import { createFakeSessionController } from '../../server/fake-session-controller.js';

const logger = createLogger('error', () => {});
const hubId = 'hub-under-test' as HubId;

const target: DialTarget = {
  address: 'wss://box.example:8443' as ServerAddress,
  token: 'the-right-token',
};

const identity: ServerIdentity = {
  serverId: 'server-under-test' as ServerIdentity['serverId'],
  token: target.token,
};

const stores: readonly StoreDescriptor[] = [
  { storeId: 'store-a' as StoreId, path: '/volumes/claude' },
];

const settle = (): Promise<void> => new Promise((resolve) => void setTimeout(resolve, 0));

/** A dialer answering with one socket a test drives by hand. */
function dialerFor(socket: FakeMessageSocket) {
  return createFakeDialer(() => ({ ok: true, socket }));
}

function dependencies(dialer: ReturnType<typeof createFakeDialer>) {
  return { dialer, hubId, timers: createFakeTimers(), logger };
}

describe('handshakeWithServer against a real server', () => {
  /**
   * Both halves of the handshake, joined by a fake wire.
   *
   * This is the test that matters most in this file: the hub's rules and the
   * server's rules are both the shipped code, the frames are real JSON, and
   * both parsers run. Nothing is replaced but the socket.
   */
  function pair(serverOverrides: Partial<Parameters<typeof serveHubConnection>[1]> = {}) {
    const { hubEnd, serverEnd } = createSocketPair();
    serveHubConnection(serverEnd, {
      identity,
      stores,
      sessions: createFakeSessionController(),
      logger,
      ...serverOverrides,
    });
    return dialerFor(hubEnd);
  }

  it('completes, and answers with the serverId and stores the server reported', async () => {
    const outcome = await handshakeWithServer(target, dependencies(pair()));

    expect(outcome).toMatchObject({
      ok: true,
      serverId: 'server-under-test',
      stores: [{ storeId: 'store-a', path: '/volumes/claude' }],
    });
  });

  it('leaves the socket open, because that connection is the one to keep', async () => {
    const outcome = await handshakeWithServer(target, dependencies(pair()));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.socket).toBeDefined();
  });

  it('reports the server refusing a token the user typed wrong', async () => {
    const wrong = { ...target, token: 'a-typo' };

    const outcome = await handshakeWithServer(wrong, dependencies(pair()));

    expect(outcome).toMatchObject({ ok: false, reason: 'unauthorized' });
  });

  it('says what to do about a refused token, without leaking whether it was close', async () => {
    const outcome = await handshakeWithServer({ ...target, token: 'a-typo' }, dependencies(pair()));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.problem).toContain('pair again');
  });
});

describe('handshakeWithServer', () => {
  it('presents the hub id and the token on the frame the server reads', async () => {
    const socket = createFakeMessageSocket();
    const dialer = dialerFor(socket);

    void handshakeWithServer(target, dependencies(dialer));
    await settle();

    const parsed = parseTextFrame(parseHubToServerFrame, socket.sent[0] ?? '');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      type: 'handshake',
      id: 1,
      protocolVersion: PROTOCOL_VERSION,
      hubId,
      token: target.token,
    });
  });

  it('dials the address it was given and no other', async () => {
    const dialer = dialerFor(createFakeMessageSocket());

    void handshakeWithServer(target, dependencies(dialer));
    await settle();

    expect(dialer.dialled).toEqual(['wss://box.example:8443']);
  });

  it('reports a server it could not reach, rather than throwing', async () => {
    const dialer = createUnreachableDialer('ECONNREFUSED');

    const outcome = await handshakeWithServer(target, dependencies(dialer));

    expect(outcome).toEqual({ ok: false, reason: 'unreachable', problem: 'ECONNREFUSED' });
  });

  it("refuses a server whose protocol version is not exactly this hub's", async () => {
    const socket = createFakeMessageSocket();
    const pending = handshakeWithServer(target, dependencies(dialerFor(socket)));
    await settle();

    socket.receive(
      JSON.stringify({
        type: 'handshake-accepted',
        replyTo: 1,
        protocolVersion: PROTOCOL_VERSION + 1,
        serverId: 'server-under-test',
        stores: [],
      }),
    );

    expect(await pending).toMatchObject({ ok: false, reason: 'protocol-version' });
  });

  it('names both versions, so the mismatch is one legible thing to fix', async () => {
    const socket = createFakeMessageSocket();
    const pending = handshakeWithServer(target, dependencies(dialerFor(socket)));
    await settle();

    socket.receive(
      JSON.stringify({
        type: 'handshake-accepted',
        replyTo: 1,
        protocolVersion: 99,
        serverId: 's',
        stores: [],
      }),
    );

    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.problem).toContain('99');
    expect(outcome.problem).toContain(String(PROTOCOL_VERSION));
  });

  it('closes a connection it refused, rather than leaving it open', async () => {
    const socket = createFakeMessageSocket();
    const pending = handshakeWithServer(target, dependencies(dialerFor(socket)));
    await settle();

    socket.receive(
      JSON.stringify({ type: 'handshake-rejected', replyTo: 1, reason: 'unauthorized' }),
    );
    await pending;

    expect(socket.closure).not.toBeNull();
  });

  it('refuses a reply that answers a frame this hub never sent', async () => {
    const socket = createFakeMessageSocket();
    const pending = handshakeWithServer(target, dependencies(dialerFor(socket)));
    await settle();

    socket.receive(
      JSON.stringify({
        type: 'handshake-accepted',
        replyTo: 99,
        protocolVersion: PROTOCOL_VERSION,
        serverId: 'somebody-else',
        stores: [],
      }),
    );

    expect(await pending).toMatchObject({ ok: false, reason: 'protocol-error' });
  });

  it('refuses a reply it cannot parse, and says so on the wire', async () => {
    const socket = createFakeMessageSocket();
    const pending = handshakeWithServer(target, dependencies(dialerFor(socket)));
    await settle();

    socket.receive('not a frame at all');
    const outcome = await pending;

    expect(outcome).toMatchObject({ ok: false, reason: 'protocol-error' });
    expect(socket.sent[1]).toContain('protocol-error');
  });

  it('refuses an answer to a question that was never asked', async () => {
    const socket = createFakeMessageSocket();
    const pending = handshakeWithServer(target, dependencies(dialerFor(socket)));
    await settle();

    socket.receive(JSON.stringify({ type: 'pong', replyTo: 1 }));

    expect(await pending).toMatchObject({ ok: false, reason: 'protocol-error' });
  });

  it('reports a server that hung up before answering', async () => {
    const socket = createFakeMessageSocket();
    const pending = handshakeWithServer(target, dependencies(dialerFor(socket)));
    await settle();

    socket.closeFromPeer(PEER_GONE);

    expect(await pending).toMatchObject({ ok: false, reason: 'closed' });
  });

  it('gives up on a server that accepts the connection and then says nothing', async () => {
    // Without a deadline this holds a socket, a supervisor slot and a pending
    // promise forever, and nothing above ever learns the server is not
    // answering.
    const socket = createFakeMessageSocket();
    const timers = createFakeTimers();
    const pending = handshakeWithServer(target, {
      ...dependencies(dialerFor(socket)),
      timers,
    });
    await settle();

    expect(timers.pending).toBe(1);
    timers.fireAll();

    expect(await pending).toMatchObject({ ok: false, reason: 'timeout' });
    expect(socket.closure).not.toBeNull();
  });

  it('cancels the deadline once the handshake has been answered', async () => {
    const { hubEnd, serverEnd } = createSocketPair();
    serveHubConnection(serverEnd, {
      identity,
      stores,
      sessions: createFakeSessionController(),
      logger,
    });
    const timers = createFakeTimers();

    await handshakeWithServer(target, { ...dependencies(dialerFor(hubEnd)), timers });

    // A live timer on a settled handshake would fire into a connection the
    // supervisor is using and close it.
    expect(timers.pending).toBe(0);
  });

  it('settles once, whatever arrives afterwards', async () => {
    const socket = createFakeMessageSocket();
    const pending = handshakeWithServer(target, dependencies(dialerFor(socket)));
    await settle();

    socket.receive(
      JSON.stringify({ type: 'handshake-rejected', replyTo: 1, reason: 'unauthorized' }),
    );
    const outcome = await pending;
    socket.receive(
      JSON.stringify({
        type: 'handshake-accepted',
        replyTo: 1,
        protocolVersion: PROTOCOL_VERSION,
        serverId: 'too-late',
        stores: [],
      }),
    );
    await settle();

    expect(outcome).toMatchObject({ reason: 'unauthorized' });
  });
});
