import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from './version.js';
import { parseClientFrame, parseHubFrame, type ClientFrame, type HubFrame } from './client.js';
import {
  hubIdSchema,
  nodeIdSchema,
  nodeKindSchema,
  serverIdSchema,
  serverRegistrationIdSchema,
  sessionIdSchema,
  storeIdSchema,
} from './identity.js';
import { parseTextFrame } from './parse.js';

describe('parseClientFrame', () => {
  it('accepts hello with a version', () => {
    const result = parseClientFrame({
      type: 'hello',
      id: 1,
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown frame type rather than passing it along', () => {
    expect(parseClientFrame({ type: 'run', id: 1, command: 'rm -rf /' }).ok).toBe(false);
  });

  it('rejects a frame id that is not a positive integer', () => {
    expect(parseClientFrame({ type: 'ping', id: 0 }).ok).toBe(false);
    expect(parseClientFrame({ type: 'ping', id: -1 }).ok).toBe(false);
    expect(parseClientFrame({ type: 'ping', id: 1.5 }).ok).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(parseClientFrame('ping').ok).toBe(false);
    expect(parseClientFrame(null).ok).toBe(false);
  });
});

describe('parseClientFrame on the session frames', () => {
  const A_START = {
    type: 'session-start',
    id: 1,
    storeId: 'store-work',
    sessionId: null,
    provider: 'claude',
    prompt: null,
    server: null,
  };

  it('accepts a start that names a store and lets the hub schedule it', () => {
    expect(parseClientFrame(A_START).ok).toBe(true);
  });

  it('accepts a start that overrides the machine', () => {
    expect(parseClientFrame({ ...A_START, server: 'registration-2' }).ok).toBe(true);
  });

  it('strips a working directory, an argv, an environment or an operation name', () => {
    // The `{ command }` frame the operation registry exists to prevent, in each
    // of the shapes it likes to arrive as. The parser is the boundary: whatever
    // a caller put on the wire, what reaches the hub's own code has no field to
    // read it out of, so no later handler can be talked into using one.
    const smuggled = parseClientFrame({
      ...A_START,
      cwd: '/etc',
      args: ['--dangerously-skip-permissions'],
      env: { PATH: '/tmp' },
      command: 'claude',
      operation: 'git-status',
    });
    expect(smuggled.ok).toBe(true);
    if (!smuggled.ok) return;
    for (const forbidden of ['cwd', 'args', 'env', 'command', 'operation']) {
      expect(smuggled.value).not.toHaveProperty(forbidden);
    }
  });

  it('rejects a start for a provider nothing implements', () => {
    expect(parseClientFrame({ ...A_START, provider: 'sh' }).ok).toBe(false);
  });

  it('rejects a start with an empty prompt, which is neither text nor absence', () => {
    expect(parseClientFrame({ ...A_START, prompt: '' }).ok).toBe(false);
  });

  it('drops a process handle from a stop: a stop addresses a session', () => {
    const stop = { type: 'session-stop', id: 2, storeId: 'store-work', sessionId: 'session-1' };
    expect(parseClientFrame(stop).ok).toBe(true);
    const named = parseClientFrame({ ...stop, pid: 4321, terminalId: 'terminal-1' });
    expect(named.ok).toBe(true);
    if (!named.ok) return;
    expect(named.value).not.toHaveProperty('pid');
    expect(named.value).not.toHaveProperty('terminalId');
  });

  it('rejects a stop with no session: a stop addresses one session, never a store', () => {
    expect(parseClientFrame({ type: 'session-stop', id: 2, storeId: 'store-work' }).ok).toBe(false);
  });
});

describe('parseClientFrame on the pane layout frames', () => {
  it('accepts a save whose layout it does not understand: the shape is the client tier alone', () => {
    // Deliberately not a shape any current client writes. The hub-side rule
    // under test is that no rule exists: a newer client's pane type crosses
    // this parser untouched, so a new pane type needs no service release.
    const result = parseClientFrame({
      type: 'pane-layout-save',
      id: 1,
      layout: '{"v":9,"root":{"kind":"hologram"}}',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a save whose layout is not characters at all', () => {
    expect(parseClientFrame({ type: 'pane-layout-save', id: 1, layout: { v: 1 } }).ok).toBe(false);
    expect(parseClientFrame({ type: 'pane-layout-save', id: 1, layout: null }).ok).toBe(false);
  });

  it('rejects a save past the bound, which is a bug filling a column, not a layout', () => {
    const oversized = 'x'.repeat(65_537);
    expect(parseClientFrame({ type: 'pane-layout-save', id: 1, layout: oversized }).ok).toBe(false);
  });
});

describe('parseHubFrame', () => {
  it('accepts a welcome', () => {
    const result = parseHubFrame({
      type: 'welcome',
      replyTo: 1,
      protocolVersion: PROTOCOL_VERSION,
      hubId: 'hub-1',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a refusal with a known code', () => {
    const result = parseHubFrame({
      type: 'refusal',
      replyTo: 1,
      code: 'unauthorized',
      message: 'token not accepted',
      holder: null,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a refusal that leaves out the holder, so every refusal has one shape', () => {
    const result = parseHubFrame({
      type: 'refusal',
      replyTo: 1,
      code: 'refused',
      message: 'no',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a refusal with a code outside the closed set', () => {
    const result = parseHubFrame({
      type: 'refusal',
      replyTo: 1,
      code: 'teapot',
      message: 'no',
      holder: null,
    });
    expect(result.ok).toBe(false);
  });

  it('does not accept a client frame on the hub-to-client direction', () => {
    expect(parseHubFrame({ type: 'ping', id: 1 }).ok).toBe(false);
  });
});

/**
 * Both halves of a direction, checked against each other.
 *
 * A schema proves a parser accepts what the test author typed. It proves
 * nothing about whether the other side can build that value, or whether it
 * survives the JSON it travels as. Nothing in the applications calls these
 * parsers yet, so until milestone 3 wires them up this is the only thing
 * holding the two ends together.
 */
describe('client and hub round trips', () => {
  const clientFrames: readonly ClientFrame[] = [
    { type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION },
    { type: 'ping', id: 2 },
    { type: 'layout-request', id: 3 },
    {
      type: 'session-start',
      id: 4,
      storeId: storeIdSchema.parse('store-work'),
      sessionId: null,
      provider: 'claude',
      prompt: 'take a look at the failing test',
      server: null,
    },
    {
      type: 'session-start',
      id: 5,
      storeId: storeIdSchema.parse('store-work'),
      sessionId: sessionIdSchema.parse('session-1'),
      provider: 'claude',
      prompt: null,
      server: serverRegistrationIdSchema.parse('registration-2'),
    },
    {
      type: 'session-stop',
      id: 6,
      storeId: storeIdSchema.parse('store-work'),
      sessionId: sessionIdSchema.parse('session-1'),
    },
    { type: 'pane-layout-request', id: 7 },
    { type: 'pane-layout-save', id: 8, layout: '{"v":1,"root":{"kind":"pane"}}' },
    { type: 'protocol-error', code: 'bad-request', message: 'frame is not valid JSON' },
  ];

  const hubFrames: readonly HubFrame[] = [
    {
      type: 'welcome',
      replyTo: 1,
      protocolVersion: PROTOCOL_VERSION,
      hubId: hubIdSchema.parse('hub-1'),
    },
    { type: 'pong', replyTo: 2 },
    {
      type: 'refusal',
      replyTo: 3,
      code: 'unauthorized',
      message: 'token not accepted',
      holder: null,
    },
    {
      type: 'refusal',
      replyTo: 4,
      code: 'refused',
      message: 'session-1 is already running on workshop',
      holder: {
        server: serverRegistrationIdSchema.parse('registration-1'),
        stoppable: false,
      },
    },
    {
      type: 'session-started',
      replyTo: 4,
      storeId: storeIdSchema.parse('store-work'),
      sessionId: null,
      server: serverRegistrationIdSchema.parse('registration-1'),
    },
    {
      type: 'session-stopped',
      replyTo: 6,
      storeId: storeIdSchema.parse('store-work'),
      sessionId: sessionIdSchema.parse('session-1'),
      server: serverRegistrationIdSchema.parse('registration-1'),
    },
    {
      type: 'layout',
      replyTo: 3,
      nodes: [
        {
          id: nodeIdSchema.parse('node-1'),
          parentId: null,
          kind: nodeKindSchema.parse('folder'),
          position: 0,
          name: 'this week',
          named: true,
          anchor: null,
        },
        {
          id: nodeIdSchema.parse('node-2'),
          parentId: nodeIdSchema.parse('node-1'),
          kind: nodeKindSchema.parse('session'),
          position: 0,
          name: null,
          named: false,
          anchor: {
            storeId: storeIdSchema.parse('store-work'),
            sessionId: sessionIdSchema.parse('session-1'),
          },
        },
      ],
    },
    { type: 'pane-layout', replyTo: 7, layout: '{"v":1,"root":{"kind":"pane"}}' },
    { type: 'pane-layout', replyTo: 7, layout: null },
    { type: 'pane-layout-saved', replyTo: 8 },
    {
      type: 'machine-state',
      state: {
        version: 7,
        stores: [
          {
            storeId: storeIdSchema.parse('store-work'),
            servers: [serverRegistrationIdSchema.parse('registration-1')],
            reachable: true,
            unreachableSince: null,
            lastReachableAt: 1_000,
            sessions: [
              {
                descriptor: {
                  storeId: storeIdSchema.parse('store-work'),
                  sessionId: sessionIdSchema.parse('session-1'),
                  provider: 'claude',
                  status: 'awaiting-permission',
                  updatedAt: 900,
                  cwd: '/srv/work',
                  title: 'the ticket',
                },
                source: serverRegistrationIdSchema.parse('registration-1'),
                reportedBy: [serverRegistrationIdSchema.parse('registration-1')],
                reportedAt: 1_000,
                reachable: true,
                holder: {
                  server: serverRegistrationIdSchema.parse('registration-1'),
                  stoppable: true,
                },
              },
            ],
          },
        ],
        servers: [
          {
            registrationId: serverRegistrationIdSchema.parse('registration-1'),
            label: 'workshop',
            serverId: serverIdSchema.parse('server-1'),
            phase: 'connected',
            stores: [storeIdSchema.parse('store-work')],
            connectedSince: 1_000,
            staleSince: null,
            lastConnectedAt: 1_000,
            staleReason: null,
            problem: null,
          },
        ],
        candidates: [
          {
            serverId: serverIdSchema.parse('server-2'),
            address: '192.168.1.24',
            port: 8443,
            protocolVersion: 6,
          },
        ],
      },
    },
    { type: 'protocol-error', code: 'protocol-version', message: 'this hub speaks version 2' },
  ];

  it('sends the state with no replyTo, because nobody asked for it', () => {
    const broadcast = hubFrames.find((frame) => frame.type === 'machine-state');
    expect(broadcast).toBeDefined();
    expect(broadcast).not.toHaveProperty('replyTo');
  });

  it.each(clientFrames)('the hub reads back the $type a client sends', (frame) => {
    expect(parseTextFrame(parseClientFrame, JSON.stringify(frame))).toEqual({
      ok: true,
      value: frame,
    });
  });

  it.each(hubFrames)('a client reads back the $type the hub sends', (frame) => {
    expect(parseTextFrame(parseHubFrame, JSON.stringify(frame))).toEqual({
      ok: true,
      value: frame,
    });
  });

  it('lets either side say it could not read a frame, with nothing to reply to', () => {
    // The case a refusal cannot carry: an unparseable frame has no id to name.
    const unreadable = parseTextFrame(parseClientFrame, '{not json');
    expect(unreadable.ok).toBe(false);
    if (unreadable.ok) return;

    const answer: HubFrame = {
      type: 'protocol-error',
      code: 'bad-request',
      message: unreadable.reason,
    };
    expect(parseTextFrame(parseHubFrame, JSON.stringify(answer))).toEqual({
      ok: true,
      value: answer,
    });
  });

  it('refuses a protocol-error that names a code outside the two readable failures', () => {
    expect(parseHubFrame({ type: 'protocol-error', code: 'internal', message: 'no' }).ok).toBe(
      false,
    );
  });
});
