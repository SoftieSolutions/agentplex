import { describe, expect, it } from 'vitest';
import {
  parseServerToHubFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  type ServerToHubFrame,
  type StoreDescriptor,
  type StoreId,
} from '@agentplex/protocol';
import { createFakeMessageSocket, PEER_GONE } from '../shared/fake-message-socket.js';
import { createLogger } from '../shared/logger.js';
import { CLOSE_POLICY } from '../shared/message-socket.js';
import { serveHubConnection } from './hub-connection.js';
import type { ServerIdentity } from './server-identity.js';
import { createFakeSessionController } from './fake-session-controller.js';

const logger = createLogger('error', () => {});

const identity: ServerIdentity = {
  serverId: 'server-under-test' as ServerIdentity['serverId'],
  token: 'the-right-token',
};

const stores: readonly StoreDescriptor[] = [
  { storeId: 'store-a' as StoreId, path: '/volumes/claude' },
];

/** The frame a well-behaved hub opens with. */
function handshake(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'handshake',
    id: 1,
    protocolVersion: PROTOCOL_VERSION,
    hubId: 'hub-under-test',
    token: identity.token,
    ...overrides,
  });
}

function connect() {
  const socket = createFakeMessageSocket();
  const connection = serveHubConnection(socket, {
    identity,
    stores,
    sessions: createFakeSessionController(),
    logger,
  });
  return { socket, connection };
}

/** Everything the server said, parsed by the parser that owns this direction. */
function replies(sent: readonly string[]): ServerToHubFrame[] {
  return sent.map((text) => {
    const parsed = parseTextFrame(parseServerToHubFrame, text);
    if (!parsed.ok) throw new Error(`the server sent an unparseable frame: ${parsed.reason}`);
    return parsed.value;
  });
}

/** Delivery is asynchronous, as it is on a real socket. */
const settle = (): Promise<void> => new Promise((resolve) => void setTimeout(resolve, 0));

describe('serveHubConnection', () => {
  it('answers a good handshake with its identity, version and mounted stores', async () => {
    const { socket, connection } = connect();

    socket.receive(handshake());
    await settle();

    expect(replies(socket.sent)).toEqual([
      {
        type: 'handshake-accepted',
        replyTo: 1,
        protocolVersion: PROTOCOL_VERSION,
        serverId: 'server-under-test',
        stores: [{ storeId: 'store-a', path: '/volumes/claude' }],
      },
    ]);
    expect(connection.state).toBe('established');
    expect(socket.closure).toBeNull();
  });

  it('reports the stores it actually has, and an empty list when it has none', async () => {
    const socket = createFakeMessageSocket();
    serveHubConnection(socket, {
      identity,
      stores: [],
      sessions: createFakeSessionController(),
      logger,
    });

    socket.receive(handshake());
    await settle();

    expect(replies(socket.sent)[0]).toMatchObject({ stores: [] });
  });

  it('refuses a wrong token and closes', async () => {
    const { socket, connection } = connect();

    socket.receive(handshake({ token: 'a-guess' }));
    await settle();

    expect(replies(socket.sent)).toEqual([
      { type: 'handshake-rejected', replyTo: 1, reason: 'unauthorized' },
    ]);
    expect(connection.state).toBe('closed');
    expect(socket.closure).toMatchObject({ code: CLOSE_POLICY });
  });

  it('says nothing about itself to a peer that did not authenticate', async () => {
    // The rejection carries a code and no detail on purpose: a server that
    // explained which half of the credential was wrong would be an oracle for
    // guessing the other half, and one that leaked its serverId or its stores
    // would answer a question the peer had not earned.
    const { socket } = connect();

    socket.receive(handshake({ token: 'a-guess' }));
    await settle();

    expect(socket.sent.join()).not.toContain('server-under-test');
    expect(socket.sent.join()).not.toContain('/volumes/claude');
  });

  it('checks the token before the protocol version', async () => {
    // Order matters: a peer with no valid token learns only that it was wrong.
    const { socket } = connect();

    socket.receive(handshake({ token: 'a-guess', protocolVersion: PROTOCOL_VERSION + 1 }));
    await settle();

    expect(replies(socket.sent)[0]).toMatchObject({ reason: 'unauthorized' });
  });

  it('refuses a protocol version that is not exactly its own', async () => {
    const { socket, connection } = connect();

    socket.receive(handshake({ protocolVersion: PROTOCOL_VERSION + 1 }));
    await settle();

    expect(replies(socket.sent)).toEqual([
      { type: 'handshake-rejected', replyTo: 1, reason: 'protocol-version' },
    ]);
    expect(connection.state).toBe('closed');
  });

  it('refuses an older protocol version too, because the match is exact and not a floor', async () => {
    const { socket } = connect();

    socket.receive(handshake({ protocolVersion: PROTOCOL_VERSION - 1 }));
    await settle();

    expect(replies(socket.sent)[0]).toMatchObject({ reason: 'protocol-version' });
  });

  it('answers nothing before a handshake, whatever is asked', async () => {
    const { socket, connection } = connect();

    socket.receive(JSON.stringify({ type: 'ping', id: 7 }));
    await settle();

    expect(replies(socket.sent)).toEqual([
      { type: 'protocol-error', code: 'bad-request', message: expect.any(String) },
    ]);
    expect(connection.state).toBe('closed');
  });

  it('answers a ping once the connection is established', async () => {
    const { socket } = connect();
    socket.receive(handshake());
    await settle();

    socket.receive(JSON.stringify({ type: 'ping', id: 2 }));
    await settle();

    expect(replies(socket.sent)[1]).toEqual({ type: 'pong', replyTo: 2 });
  });

  it('refuses a second handshake on a connection that already has one', async () => {
    const { socket, connection } = connect();
    socket.receive(handshake());
    await settle();

    socket.receive(handshake({ id: 2 }));
    await settle();

    expect(replies(socket.sent)[1]).toMatchObject({ type: 'protocol-error' });
    expect(connection.state).toBe('closed');
  });

  it('closes on a frame it cannot read, having said what it objected to', async () => {
    const { socket, connection } = connect();

    socket.receive('{ not json');
    await settle();

    expect(replies(socket.sent)).toEqual([
      { type: 'protocol-error', code: 'bad-request', message: expect.any(String) },
    ]);
    expect(connection.state).toBe('closed');
  });

  it('closes on a frame that is JSON but not a frame', async () => {
    const { socket, connection } = connect();

    socket.receive(JSON.stringify({ type: 'handshake', id: 1, token: 'x' }));
    await settle();

    expect(replies(socket.sent)[0]).toMatchObject({ type: 'protocol-error' });
    expect(connection.state).toBe('closed');
  });

  it('never echoes the offending frame back', async () => {
    const { socket } = connect();

    socket.receive(JSON.stringify({ type: 'handshake', id: 1, token: 'a-secret-guess' }));
    await settle();

    expect(socket.sent.join()).not.toContain('a-secret-guess');
  });

  it('stops reading once it has closed', async () => {
    const { socket } = connect();
    socket.receive('{ not json');
    await settle();
    const afterClose = socket.sent.length;

    socket.receive(handshake());
    await settle();

    expect(socket.sent).toHaveLength(afterClose);
  });

  it('notices the hub going away', async () => {
    const { socket, connection } = connect();
    socket.receive(handshake());
    await settle();

    socket.closeFromPeer(PEER_GONE);
    await settle();

    expect(connection.state).toBe('closed');
  });
});
