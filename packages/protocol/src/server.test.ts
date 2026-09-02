import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from './version.js';
import { parseHubToServerFrame, parseServerToHubFrame } from './server.js';

describe('parseHubToServerFrame', () => {
  it('accepts a handshake carrying a token', () => {
    const result = parseHubToServerFrame({
      type: 'handshake',
      id: 1,
      protocolVersion: PROTOCOL_VERSION,
      token: 'a-server-token',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a handshake with an empty token instead of treating it as absent', () => {
    const result = parseHubToServerFrame({
      type: 'handshake',
      id: 1,
      protocolVersion: PROTOCOL_VERSION,
      token: '',
    });
    expect(result.ok).toBe(false);
  });

  it('carries no operation name, argv, env or cwd', () => {
    const result = parseHubToServerFrame({
      type: 'handshake',
      id: 1,
      protocolVersion: PROTOCOL_VERSION,
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
