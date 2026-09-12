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
import { encodeTerminalChunk } from './terminal.js';
import { docNameSchema } from './doc.js';

const HUB_ID = hubIdSchema.parse('hub-1');

/** One provider that resolved, reported a version and says it is logged in. */
const READY_CLAUDE = {
  provider: 'claude',
  state: 'ready',
  version: '2.1.259',
  directory: '/home/robert/.local/bin',
  problem: null,
} as const;

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
      branch: 'fix/auth-refresh',
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

describe('parseHubToServerFrame on the document frames', () => {
  const A_WRITE = {
    type: 'doc-write',
    id: 2,
    directory: '/Users/dev/Code/agentplex',
    name: 'plan.md',
    content: '# Plan\n',
  };

  it('accepts a write naming a project, a document and its whole content', () => {
    expect(parseHubToServerFrame(A_WRITE).ok).toBe(true);
    expect(parseHubToServerFrame({ ...A_WRITE, content: '' }).ok).toBe(true);
  });

  it('accepts a read and a list, each naming the project by its working tree', () => {
    expect(
      parseHubToServerFrame({ type: 'doc-read', id: 3, directory: '/srv/work', name: 'plan.md' })
        .ok,
    ).toBe(true);
    expect(parseHubToServerFrame({ type: 'doc-list', id: 4, directory: '/srv/work' }).ok).toBe(
      true,
    );
  });

  // The name is the one string on this direction that is joined onto a path
  // on the server's disk, and the parser is what keeps it inside the folder.
  it.each([
    ['a separator', 'notes/plan.md'],
    ['a traversal', '../plan.md'],
    ['a leading dot', '.plan.md'],
    ['an extension off the list', 'plan.sh'],
  ])('refuses a document name with %s, on every frame that carries one', (_why, name) => {
    expect(parseHubToServerFrame({ ...A_WRITE, name }).ok).toBe(false);
    expect(
      parseHubToServerFrame({ type: 'doc-read', id: 3, directory: '/srv/work', name }).ok,
    ).toBe(false);
  });

  it.each([
    ['relative', 'Code/agentplex'],
    ['a parent reference', '../agentplex'],
    ['empty', ''],
  ])('refuses a directory that is %s, on every frame that carries one', (_why, directory) => {
    expect(parseHubToServerFrame({ ...A_WRITE, directory }).ok).toBe(false);
    expect(parseHubToServerFrame({ type: 'doc-read', id: 3, directory, name: 'plan.md' }).ok).toBe(
      false,
    );
    expect(parseHubToServerFrame({ type: 'doc-list', id: 4, directory }).ok).toBe(false);
  });

  it('refuses content past the cap rather than truncating it', () => {
    expect(parseHubToServerFrame({ ...A_WRITE, content: 'x'.repeat(256_001) }).ok).toBe(false);
  });

  it('refuses a write with no content: a document is replaced whole or not at all', () => {
    const { content: _content, ...withoutContent } = A_WRITE;
    expect(parseHubToServerFrame(withoutContent).ok).toBe(false);
  });

  it('strips a cwd, an argv, an env or an operation name off a document frame', () => {
    // A directory is on this frame as a file-store key, and the parser makes
    // sure nothing else that could reach a process rides along with it.
    const smuggled = parseHubToServerFrame({
      ...A_WRITE,
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
});

describe('parseServerToHubFrame on the document answers', () => {
  it('accepts a listing whose every entry names a document', () => {
    const result = parseServerToHubFrame({
      type: 'doc-listing',
      replyTo: 4,
      entries: [{ name: 'plan.md', updatedAt: 1_756_000_000_000, bytes: 7 }],
    });
    expect(result.ok).toBe(true);
  });

  it('accepts an empty listing, which is a project nobody has written to', () => {
    expect(parseServerToHubFrame({ type: 'doc-listing', replyTo: 4, entries: [] }).ok).toBe(true);
  });

  it('refuses a listing carrying a name the name parser would not take', () => {
    const result = parseServerToHubFrame({
      type: 'doc-listing',
      replyTo: 4,
      entries: [{ name: '.plan.md.tmp', updatedAt: 1_756_000_000_000, bytes: 7 }],
    });
    expect(result.ok).toBe(false);
  });

  it('refuses a content answer with no write time', () => {
    expect(parseServerToHubFrame({ type: 'doc-content', replyTo: 3, content: 'x' }).ok).toBe(false);
  });
});

describe('terminal frames on the server direction', () => {
  const SESSION = {
    by: 'session',
    storeId: 'store-1',
    sessionId: 'session-1',
  } as const;

  it('accepts a subscription that names a session', () => {
    expect(parseHubToServerFrame({ type: 'session-subscribe', id: 6, target: SESSION }).ok).toBe(
      true,
    );
  });

  it('accepts a subscription that names only the start that made the session', () => {
    // The whole point of the start handle: a spawned session has no id of its
    // own until the provider writes one, and its terminal is producing output
    // in the meantime.
    const parsed = parseHubToServerFrame({
      type: 'session-subscribe',
      id: 6,
      target: { by: 'start', startId: 3 },
    });
    expect(parsed.ok).toBe(true);
  });

  it('refuses a subscription with no target rather than subscribing to everything', () => {
    expect(parseHubToServerFrame({ type: 'session-subscribe', id: 6 }).ok).toBe(false);
  });

  it('gives the subscription a partner, so a closing tab can give the count back', () => {
    expect(parseHubToServerFrame({ type: 'session-unsubscribe', id: 7, target: SESSION }).ok).toBe(
      true,
    );
  });

  it('refuses input that is not addressed to a session', () => {
    expect(parseHubToServerFrame({ type: 'terminal-input', id: 8, data: 'ls\r' }).ok).toBe(false);
  });

  it('carries no command, argv or cwd on input: it is keystrokes and nothing else', () => {
    const parsed = parseHubToServerFrame({
      type: 'terminal-input',
      id: 8,
      target: SESSION,
      data: 'ls\r',
      command: '/bin/sh',
      args: ['-c', 'id'],
      cwd: '/etc',
      branch: null,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.type !== 'terminal-input') return;
    expect(parsed.value).toEqual({ type: 'terminal-input', id: 8, target: SESSION, data: 'ls\r' });
  });

  it('refuses a resize with a dimension no terminal has', () => {
    expect(
      parseHubToServerFrame({
        type: 'terminal-resize',
        id: 9,
        target: SESSION,
        size: { cols: 0, rows: 24 },
      }).ok,
    ).toBe(false);
  });

  it('refuses output whose bytes are not base64 rather than handing on rubbish', () => {
    expect(
      parseServerToHubFrame({
        type: 'terminal-output',
        storeId: 'store-1',
        sessionId: 'session-1',
        startId: null,
        chunk: 'this is not base64 %%%',
        droppedChunks: 0,
      }).ok,
    ).toBe(false);
  });

  it('requires the dropped-chunk counter, so a lossy stream cannot look whole', () => {
    // Required rather than optional, because a frame that may omit it is a
    // frame every reader has to treat as maybe-lossy -- which is the claim the
    // number exists to make precise.
    expect(
      parseServerToHubFrame({
        type: 'terminal-output',
        storeId: 'store-1',
        sessionId: 'session-1',
        startId: null,
        chunk: '',
      }).ok,
    ).toBe(false);
  });

  it('lets output name a start before it can name a session', () => {
    const parsed = parseServerToHubFrame({
      type: 'terminal-output',
      storeId: 'store-1',
      sessionId: null,
      startId: 3,
      chunk: encodeTerminalChunk(new Uint8Array([27, 91, 48, 109])),
      droppedChunks: 0,
    });
    expect(parsed.ok).toBe(true);
  });

  it('reports which start produced which session, and accepts one with no id yet', () => {
    const parsed = parseServerToHubFrame({
      type: 'store-report',
      storeId: 'store-1',
      sessions: [],
      holding: [],
      starts: [
        { startId: 3, sessionId: null },
        { startId: 4, sessionId: 'session-2' },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.type !== 'store-report') return;
    expect(parsed.value.starts).toEqual([
      { startId: 3, sessionId: null },
      { startId: 4, sessionId: 'session-2' },
    ]);
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
      providers: [READY_CLAUDE],
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
      providers: [],
    });
    expect(result.ok).toBe(true);
  });

  it('carries the preflight, so a provider that cannot run is a fact before a start', () => {
    const result = parseServerToHubFrame({
      type: 'handshake-accepted',
      replyTo: 1,
      protocolVersion: PROTOCOL_VERSION,
      serverId: 'server-1',
      stores: [],
      providers: [
        {
          provider: 'claude',
          state: 'missing',
          version: null,
          directory: null,
          problem: 'no directory this server searches holds claude',
        },
      ],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ providers: [{ provider: 'claude', state: 'missing' }] });
  });

  it('refuses an acceptance that says nothing about its providers', () => {
    // On a pty a missing binary is a session that starts and dies, so this is
    // the one field the hub cannot do without and cannot infer.
    const result = parseServerToHubFrame({
      type: 'handshake-accepted',
      replyTo: 1,
      protocolVersion: PROTOCOL_VERSION,
      serverId: 'server-1',
      stores: [],
    });

    expect(result.ok).toBe(false);
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
          branch: null,
          title: null,
          // A working tree nobody read. The store report is the frame this
          // rides on, and `null` is what a server with no git says.
          uncommitted: null,
        },
      ],
      holding: [{ sessionId: 'session-1', stoppable: false }],
      starts: [],
    });
    expect(result.ok).toBe(true);
  });

  it('strips a pid and a terminal id off a hold: neither means anything elsewhere', () => {
    const parsed = parseServerToHubFrame({
      type: 'store-report',
      storeId: 'store-1',
      sessions: [],
      holding: [{ sessionId: 'session-1', stoppable: true, pid: 4321, terminalId: 'terminal-1' }],
      starts: [],
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
      starts: [],
      reportedAt: 1_000,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).not.toHaveProperty('reportedAt');
  });

  it('accepts a drain notice naming the sessions that are about to close', () => {
    const parsed = parseServerToHubFrame({
      type: 'server-draining',
      graceMs: 15_000,
      sessions: [{ storeId: 'store-1', sessionId: 'session-1' }],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.type !== 'server-draining') return;
    expect(parsed.value.graceMs).toBe(15_000);
    expect(parsed.value.sessions).toEqual([{ storeId: 'store-1', sessionId: 'session-1' }]);
  });

  it('accepts a drain notice from a server that was holding nothing', () => {
    expect(parseServerToHubFrame({ type: 'server-draining', graceMs: 0, sessions: [] }).ok).toBe(
      true,
    );
  });

  it('strips a deadline off a drain notice: the hub stamps what it receives', () => {
    // The same rule the store report follows. A server's own clock is not the
    // hub's, so what crosses is how long the drain lasts and never when it ends.
    const parsed = parseServerToHubFrame({
      type: 'server-draining',
      graceMs: 15_000,
      sessions: [],
      deadlineAt: 1_756_000_015_000,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).not.toHaveProperty('deadlineAt');
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
    {
      type: 'session-subscribe',
      id: 6,
      target: { by: 'start', startId: 3 },
    },
    {
      type: 'session-unsubscribe',
      id: 7,
      target: {
        by: 'session',
        storeId: storeIdSchema.parse('store-1'),
        sessionId: sessionIdSchema.parse('session-1'),
      },
    },
    {
      type: 'terminal-input',
      id: 8,
      target: {
        by: 'session',
        storeId: storeIdSchema.parse('store-1'),
        sessionId: sessionIdSchema.parse('session-1'),
      },
      data: 'pnpm test\r',
    },
    {
      type: 'terminal-resize',
      id: 9,
      target: { by: 'start', startId: 3 },
      size: { cols: 120, rows: 40 },
    },
    {
      type: 'doc-write',
      id: 10,
      directory: '/Users/dev/Code/agentplex',
      name: docNameSchema.parse('plan.md'),
      content: '# Plan\n\n- read the failing test\n',
    },
    {
      type: 'doc-read',
      id: 11,
      directory: '/Users/dev/Code/agentplex',
      name: docNameSchema.parse('plan.md'),
    },
    { type: 'doc-list', id: 12, directory: '/Users/dev/Code/agentplex' },
    { type: 'protocol-error', code: 'bad-request', message: 'type: invalid input' },
  ];

  const serverToHub: readonly ServerToHubFrame[] = [
    {
      type: 'handshake-accepted',
      replyTo: 1,
      protocolVersion: PROTOCOL_VERSION,
      serverId: serverIdSchema.parse('server-1'),
      stores: [{ storeId: storeIdSchema.parse('store-1'), path: '/data/store' }],
      providers: [READY_CLAUDE],
    },
    { type: 'handshake-rejected', replyTo: 1, reason: 'unauthorized' },
    {
      type: 'pong',
      replyTo: 2,
      load: {
        cpuCount: 14,
        cpu: { percent: 31.4, windowMs: 20_000 },
        loadAverage: [1.49951171875, 3.03271484375, 3.66796875],
      },
    },
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
          branch: 'fix/auth-refresh',
          title: 'the ticket',
          uncommitted: { files: 1, added: 18, removed: 4, entries: [] },
        },
      ],
      holding: [{ sessionId: sessionIdSchema.parse('session-1'), stoppable: false }],
      starts: [{ startId: 3, sessionId: sessionIdSchema.parse('session-1') }],
    },
    {
      type: 'session-subscribed',
      replyTo: 6,
      storeId: storeIdSchema.parse('store-1'),
      sessionId: null,
      startId: 3,
      replayChunks: 2,
      droppedBytes: 8_192,
    },
    { type: 'session-unsubscribed', replyTo: 7 },
    {
      type: 'terminal-output',
      storeId: storeIdSchema.parse('store-1'),
      sessionId: sessionIdSchema.parse('session-1'),
      startId: null,
      chunk: encodeTerminalChunk(new TextEncoder().encode('\u001b[32mok\u001b[0m\r\n')),
      droppedChunks: 0,
    },
    { type: 'doc-written', replyTo: 10, updatedAt: 1_756_000_000_000 },
    {
      type: 'doc-content',
      replyTo: 11,
      content: '# Plan\n\n- read the failing test\n',
      updatedAt: 1_756_000_000_000,
    },
    {
      type: 'doc-listing',
      replyTo: 12,
      entries: [
        { name: docNameSchema.parse('plan.md'), updatedAt: 1_756_000_000_000, bytes: 34 },
        { name: docNameSchema.parse('results.csv'), updatedAt: 1_756_000_001_000, bytes: 0 },
      ],
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
