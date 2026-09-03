import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from './version.js';
import {
  parseHubToServerFrame,
  parseServerToHubFrame,
  type HubToServerFrame,
  type ServerToHubFrame,
} from './server.js';
import { hubIdSchema, serverIdSchema, storeIdSchema } from './identity.js';
import { parseTextFrame } from './parse.js';

const HUB_ID = hubIdSchema.parse('hub-1');

describe('parseHubToServerFrame', () => {
  it('accepts a handshake carrying a token', () => {
    const result = parseHubToServerFrame({
      type: 'handshake',
      id: 1,
      protocolVersion: PROTOCOL_VERSION,
      hubId: HUB_ID,
      token: 'a-server-token',
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a handshake that does not say which hub is dialling', () => {
    const result = parseHubToServerFrame({
      type: 'handshake',
      id: 1,
      protocolVersion: PROTOCOL_VERSION,
      token: 'a-server-token',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a handshake with an empty token instead of treating it as absent', () => {
    const result = parseHubToServerFrame({
      type: 'handshake',
      id: 1,
      protocolVersion: PROTOCOL_VERSION,
      hubId: HUB_ID,
      token: '',
    });
    expect(result.ok).toBe(false);
  });

  it('carries no operation name, argv, env or cwd', () => {
    const result = parseHubToServerFrame({
      type: 'handshake',
      id: 1,
      protocolVersion: PROTOCOL_VERSION,
      hubId: HUB_ID,
      token: 't',
      command: 'ls',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toHaveProperty('command');
  });
});

describe('parseServerToHubFrame', () => {
  it('accepts an acceptance naming the server and its mounted stores', () => {
    const result = parseServerToHubFrame({
      type: 'handshake-accepted',
      replyTo: 1,
      protocolVersion: PROTOCOL_VERSION,
      serverId: 'server-1',
      stores: [{ storeId: 'store-1', path: '/data/store' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ serverId: 'server-1' });
  });

  it('accepts a server with nothing mounted yet', () => {
    const result = parseServerToHubFrame({
      type: 'handshake-accepted',
      replyTo: 1,
      protocolVersion: PROTOCOL_VERSION,
      serverId: 'server-1',
      stores: [],
    });
    expect(result.ok).toBe(true);
  });

  it('holds rejection reasons to a closed set that reveals nothing extra', () => {
    expect(
      parseServerToHubFrame({ type: 'handshake-rejected', replyTo: 1, reason: 'unauthorized' }).ok,
    ).toBe(true);
    expect(
      parseServerToHubFrame({
        type: 'handshake-rejected',
        replyTo: 1,
        reason: 'token was 3 characters short',
      }).ok,
    ).toBe(false);
  });
});

/** The same check as the client half: what one side builds, the other parses. */
describe('hub and server round trips', () => {
  const hubToServer: readonly HubToServerFrame[] = [
    {
      type: 'handshake',
      id: 1,
      protocolVersion: PROTOCOL_VERSION,
      hubId: HUB_ID,
      token: 'a-server-token',
    },
    { type: 'ping', id: 2 },
    { type: 'protocol-error', code: 'bad-request', message: 'type: invalid input' },
  ];

  const serverToHub: readonly ServerToHubFrame[] = [
    {
      type: 'handshake-accepted',
      replyTo: 1,
      protocolVersion: PROTOCOL_VERSION,
      serverId: serverIdSchema.parse('server-1'),
      stores: [{ storeId: storeIdSchema.parse('store-1'), path: '/data/store' }],
    },
    { type: 'handshake-rejected', replyTo: 1, reason: 'unauthorized' },
    { type: 'pong', replyTo: 2 },
    { type: 'protocol-error', code: 'protocol-version', message: 'this server speaks version 2' },
  ];

  it.each(hubToServer)('a server reads back the $type the hub sends', (frame) => {
    expect(parseTextFrame(parseHubToServerFrame, JSON.stringify(frame))).toEqual({
      ok: true,
      value: frame,
    });
  });

  it.each(serverToHub)('the hub reads back the $type a server sends', (frame) => {
    expect(parseTextFrame(parseServerToHubFrame, JSON.stringify(frame))).toEqual({
      ok: true,
      value: frame,
    });
  });
});
