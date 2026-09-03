import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from './version.js';
import {
  parseHubToServerFrame,
  parseServerToHubFrame,
  type HubToServerFrame,
  type ServerToHubFrame,
} from './server.js';
import { hubIdSchema, serverIdSchema, sessionIdSchema, storeIdSchema } from './identity.js';
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

describe('parseHubToServerFrame on the session instructions', () => {
  const A_START = {
    type: 'session-start',
    id: 2,
    storeId: 'store-1',
    sessionId: null,
    provider: 'claude',
    prompt: null,
  };

  it('accepts a start that names a store and a provider, and nothing else', () => {
    expect(parseHubToServerFrame(A_START).ok).toBe(true);
    expect(parseHubToServerFrame({ ...A_START, sessionId: 'session-1' }).ok).toBe(true);
  });

  it('strips a cwd, an argv, an env or an operation name off an instruction', () => {
    // The rule this frame exists to keep: the server owns the spawn. A
    // directory off the wire is a remote code execution primitive wearing a
    // path, and an argv element off the wire is one without the disguise.
    // Neither survives the parser, so the server's handler has no field to be
    // talked into reading.
    const smuggled = parseHubToServerFrame({
      ...A_START,
      cwd: '/srv/work',
      args: ['--resume', 'x'],
      env: { ANTHROPIC_API_KEY: 'k' },
      operation: 'git-status',
      command: 'claude',
    });
    expect(smuggled.ok).toBe(true);
    if (!smuggled.ok) return;
    for (const forbidden of ['cwd', 'args', 'env', 'operation', 'command']) {
      expect(smuggled.value).not.toHaveProperty(forbidden);
    }
  });

  it('drops a pid from a stop: a process handle never leaves its own machine', () => {
    const stop = { type: 'session-stop', id: 3, storeId: 'store-1', sessionId: 'session-1' };
    expect(parseHubToServerFrame(stop).ok).toBe(true);
    const named = parseHubToServerFrame({ ...stop, pid: 4321 });
    expect(named.ok).toBe(true);
    if (!named.ok) return;
    expect(named.value).not.toHaveProperty('pid');
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

  it('accepts a store report carrying what is there and what is held', () => {
    const result = parseServerToHubFrame({
      type: 'store-report',
      storeId: 'store-1',
      sessions: [
        {
          storeId: 'store-1',
          sessionId: 'session-1',
          provider: 'claude',
          status: 'working',
          updatedAt: 900,
          cwd: '/srv/work',
          title: null,
        },
      ],
      holding: [{ sessionId: 'session-1', stoppable: false }],
    });
    expect(result.ok).toBe(true);
  });

  it('strips a pid and a terminal id off a hold: neither means anything elsewhere', () => {
    const parsed = parseServerToHubFrame({
      type: 'store-report',
      storeId: 'store-1',
      sessions: [],
      holding: [{ sessionId: 'session-1', stoppable: true, pid: 4321, terminalId: 'terminal-1' }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.type !== 'store-report') return;
    expect(parsed.value.holding[0]).toEqual({ sessionId: 'session-1', stoppable: true });
  });

  it('strips a date off a store report: the hub stamps what it receives', () => {
    const parsed = parseServerToHubFrame({
      type: 'store-report',
      storeId: 'store-1',
      sessions: [],
      holding: [],
      reportedAt: 1_000,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).not.toHaveProperty('reportedAt');
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
    {
      type: 'session-start',
      id: 3,
      storeId: storeIdSchema.parse('store-1'),
      sessionId: null,
      provider: 'claude',
      prompt: 'look at the failing test',
    },
    {
      type: 'session-start',
      id: 4,
      storeId: storeIdSchema.parse('store-1'),
      sessionId: sessionIdSchema.parse('session-1'),
      provider: 'claude',
      prompt: null,
    },
    {
      type: 'session-stop',
      id: 5,
      storeId: storeIdSchema.parse('store-1'),
      sessionId: sessionIdSchema.parse('session-1'),
    },
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
    {
      type: 'session-started',
      replyTo: 3,
      storeId: storeIdSchema.parse('store-1'),
      sessionId: null,
    },
    {
      type: 'session-stopped',
      replyTo: 5,
      storeId: storeIdSchema.parse('store-1'),
      sessionId: sessionIdSchema.parse('session-1'),
    },
    {
      type: 'session-refused',
      replyTo: 4,
      code: 'refused',
      message: 'session-1 is already running here',
      hold: { sessionId: sessionIdSchema.parse('session-1'), stoppable: false },
    },
    {
      type: 'store-report',
      storeId: storeIdSchema.parse('store-1'),
      sessions: [
        {
          storeId: storeIdSchema.parse('store-1'),
          sessionId: sessionIdSchema.parse('session-1'),
          provider: 'claude',
          status: 'working',
          updatedAt: 900,
          cwd: '/srv/work',
          title: 'the ticket',
        },
      ],
      holding: [{ sessionId: sessionIdSchema.parse('session-1'), stoppable: false }],
    },
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
