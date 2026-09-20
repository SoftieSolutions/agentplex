import { describe, expect, it } from 'vitest';
import { approvalIdSchema } from './approval.js';
import { PROTOCOL_VERSION } from './version.js';
import { parseClientFrame, parseHubFrame, type ClientFrame, type HubFrame } from './client.js';
import { pairedServerAddressSchema } from './pairing.js';
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
import { encodeTerminalChunk } from './terminal.js';
import { DOC_CONTENT_MAX_CHARS, docNameSchema } from './doc.js';

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
    project: null,
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
      branch: null,
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

  it('accepts a start in a project, which names a node and never a path', () => {
    expect(parseClientFrame({ ...A_START, project: 'node-7' }).ok).toBe(true);
  });

  it('rejects a start whose project is not an id', () => {
    expect(parseClientFrame({ ...A_START, project: '' }).ok).toBe(false);
    expect(parseClientFrame({ ...A_START, project: 12 }).ok).toBe(false);
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

describe('parseClientFrame on the pairing frames', () => {
  const A_PAIR = {
    type: 'server-pair',
    id: 1,
    label: 'gpu-box-01',
    address: 'wss://gpu-box-01.example:8443',
    token: 'printed-by-the-server',
  };

  it('accepts a pairing a person typed', () => {
    expect(parseClientFrame(A_PAIR).ok).toBe(true);
  });

  it('accepts an address it will not dial, so the hub can refuse it in words', () => {
    // The deliberate looseness. Every content rule lives in `pairing.ts` and is
    // applied by the hub's handler, because a typed address that is not an
    // address has to come back as a refusal somebody reads -- and a schema
    // strict enough to reject it here would answer a typo with a closed socket.
    for (const address of ['ws://gpu-box-01.example:8443', 'not an address', '']) {
      expect(parseClientFrame({ ...A_PAIR, address }).ok).toBe(true);
    }
    expect(parseClientFrame({ ...A_PAIR, label: '   ' }).ok).toBe(true);
  });

  it('rejects what no pairing form could have submitted', () => {
    // The bound is about what a socket may carry, not about what a pairing may
    // say: nobody types four thousand characters of label by accident.
    expect(parseClientFrame({ ...A_PAIR, label: 'n'.repeat(201) }).ok).toBe(false);
    expect(parseClientFrame({ ...A_PAIR, address: `wss://${'a'.repeat(4_000)}` }).ok).toBe(false);
    expect(parseClientFrame({ ...A_PAIR, token: 't'.repeat(4_097) }).ok).toBe(false);
  });

  it('rejects a pairing with no token: the credential is the point of the frame', () => {
    const { token: _token, ...withoutToken } = A_PAIR;
    expect(parseClientFrame(withoutToken).ok).toBe(false);
  });

  it('drops anything smuggled beside the three fields a pairing has', () => {
    const smuggled = parseClientFrame({
      ...A_PAIR,
      clientToken: 'the-hub-token',
      serverId: 'server-1',
      registrationId: 'registration-1',
    });
    expect(smuggled.ok).toBe(true);
    if (!smuggled.ok) return;
    for (const forbidden of ['clientToken', 'serverId', 'registrationId']) {
      expect(smuggled.value).not.toHaveProperty(forbidden);
    }
  });

  it('takes an unpair by registration and by nothing else', () => {
    expect(parseClientFrame({ type: 'server-unpair', id: 2, registrationId: 'r-1' }).ok).toBe(true);
    // Not by address and not by the machine's own id: one names a pairing,
    // the other two can name two of them or none.
    expect(
      parseClientFrame({ type: 'server-unpair', id: 2, address: 'wss://box.example' }).ok,
    ).toBe(false);
    const byServer = parseClientFrame({
      type: 'server-unpair',
      id: 2,
      registrationId: 'r-1',
      serverId: 'server-1',
    });
    expect(byServer.ok).toBe(true);
    if (byServer.ok) expect(byServer.value).not.toHaveProperty('serverId');
  });
});

describe('parseHubFrame on the pairing replies', () => {
  it('answers a pairing with the hub\u2019s own name for it', () => {
    expect(parseHubFrame({ type: 'server-paired', replyTo: 1, registrationId: 'r-1' }).ok).toBe(
      true,
    );
  });

  it('has nowhere to put the token, so no reply can ever echo one', () => {
    // Not a rule the hub remembers: the reply shape has no field for a
    // credential, and a parser that met one drops it on the way through.
    const echoed = parseHubFrame({
      type: 'server-paired',
      replyTo: 1,
      registrationId: 'r-1',
      token: 'printed-by-the-server',
      address: 'wss://gpu-box-01.example:8443',
    });
    expect(echoed.ok).toBe(true);
    if (!echoed.ok) return;
    expect(JSON.stringify(echoed.value)).not.toContain('printed-by-the-server');
    expect(echoed.value).not.toHaveProperty('token');
  });

  it('answers an unpair with nothing but the frame it answers', () => {
    expect(parseHubFrame({ type: 'server-unpaired', replyTo: 2 }).ok).toBe(true);
    expect(parseHubFrame({ type: 'server-unpaired' }).ok).toBe(false);
  });
});

describe('parseClientFrame on the tree frames', () => {
  const A_MOVE = {
    type: 'node-move',
    id: 1,
    nodeId: 'node-1',
    parentId: 'node-2',
    position: 0,
  };

  it('accepts a folder at the root, which is not a node and has no id', () => {
    expect(
      parseClientFrame({ type: 'node-create-folder', id: 1, parentId: null, name: 'a' }).ok,
    ).toBe(true);
  });

  /**
   * The bound is the protocol's and the judgement is not. A blank name reaches
   * the hub and is refused in a sentence -- see `layout.ts` for why refusing
   * the frame instead would be hanging up on somebody who left a field empty.
   */
  it('lets a blank name through to be refused, and stops a name that is a novel', () => {
    expect(parseClientFrame({ type: 'node-rename', id: 1, nodeId: 'node-1', name: '   ' }).ok).toBe(
      true,
    );
    const novel = 'x'.repeat(201);
    expect(parseClientFrame({ type: 'node-rename', id: 1, nodeId: 'node-1', name: novel }).ok).toBe(
      false,
    );
  });

  it('rejects a position that is not a whole count of siblings', () => {
    expect(parseClientFrame(A_MOVE).ok).toBe(true);
    expect(parseClientFrame({ ...A_MOVE, position: -1 }).ok).toBe(false);
    expect(parseClientFrame({ ...A_MOVE, position: 1.5 }).ok).toBe(false);
  });

  /**
   * A forgetting names a session and never a node: the node is gone, so an id
   * naming it would name nothing. Both halves are required, because a session
   * id is unique only inside its store.
   */
  it('rejects a forgetting with half a session identity', () => {
    expect(
      parseClientFrame({
        type: 'node-forget-removal',
        id: 1,
        storeId: 'store-work',
        sessionId: 'session-1',
      }).ok,
    ).toBe(true);
    expect(
      parseClientFrame({ type: 'node-forget-removal', id: 1, sessionId: 'session-1' }).ok,
    ).toBe(false);
    expect(parseClientFrame({ type: 'node-forget-removal', id: 1, storeId: 'store-work' }).ok).toBe(
      false,
    );
  });

  /**
   * The project-scoped rename is gone, folded into the generic one. Two frames
   * with the same three fields, answered by the same `node-renamed`, were two
   * ways to say one thing -- and once the tree's own menu sends the generic
   * one, the other has no sender.
   */
  it('no longer knows a project-scoped rename', () => {
    expect(
      parseClientFrame({ type: 'project-rename', id: 1, nodeId: 'node-1', name: 'x' }).ok,
    ).toBe(false);
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
      project: null,
    },
    {
      type: 'session-start',
      id: 5,
      storeId: storeIdSchema.parse('store-work'),
      sessionId: sessionIdSchema.parse('session-1'),
      provider: 'claude',
      prompt: null,
      server: serverRegistrationIdSchema.parse('registration-2'),
      project: null,
    },
    {
      type: 'session-stop',
      id: 6,
      storeId: storeIdSchema.parse('store-work'),
      sessionId: sessionIdSchema.parse('session-1'),
    },
    { type: 'pane-layout-request', id: 7 },
    { type: 'pane-layout-save', id: 8, layout: '{"v":1,"root":{"kind":"pane"}}' },
    {
      type: 'session-subscribe',
      id: 9,
      target: {
        by: 'session',
        storeId: storeIdSchema.parse('store-work'),
        sessionId: sessionIdSchema.parse('session-1'),
      },
    },
    { type: 'session-subscribe', id: 10, target: { by: 'start', startId: 4 } },
    { type: 'session-unsubscribe', id: 11, target: { by: 'start', startId: 4 } },
    {
      type: 'terminal-input',
      id: 12,
      target: {
        by: 'session',
        storeId: storeIdSchema.parse('store-work'),
        sessionId: sessionIdSchema.parse('session-1'),
      },
      data: 'yes\r',
    },
    {
      type: 'terminal-resize',
      id: 13,
      target: {
        by: 'session',
        storeId: storeIdSchema.parse('store-work'),
        sessionId: sessionIdSchema.parse('session-1'),
      },
      size: { cols: 96, rows: 30 },
    },
    {
      type: 'server-pair',
      id: 14,
      label: 'gpu-box-01',
      address: 'wss://gpu-box-01.example:8443',
      token: 'printed-by-the-server',
    },
    {
      type: 'server-unpair',
      id: 15,
      registrationId: serverRegistrationIdSchema.parse('registration-1'),
    },
    {
      type: 'directory-list',
      id: 16,
      server: serverRegistrationIdSchema.parse('registration-2'),
      directory: null,
    },
    {
      type: 'directory-list',
      id: 17,
      server: serverRegistrationIdSchema.parse('registration-2'),
      directory: '/Users/dev/code',
    },
    { type: 'node-create-folder', id: 16, parentId: null, name: 'this week' },
    {
      type: 'node-create-folder',
      id: 17,
      parentId: nodeIdSchema.parse('node-1'),
      name: 'inside',
    },
    { type: 'node-rename', id: 18, nodeId: nodeIdSchema.parse('node-1'), name: 'last week' },
    {
      type: 'node-move',
      id: 19,
      nodeId: nodeIdSchema.parse('node-2'),
      parentId: nodeIdSchema.parse('node-1'),
      position: 0,
    },
    {
      type: 'node-move',
      id: 20,
      nodeId: nodeIdSchema.parse('node-2'),
      parentId: null,
      position: 3,
    },
    { type: 'node-remove', id: 21, nodeId: nodeIdSchema.parse('node-1') },
    {
      type: 'node-forget-removal',
      id: 22,
      storeId: storeIdSchema.parse('store-work'),
      sessionId: sessionIdSchema.parse('session-1'),
    },
    {
      type: 'doc-create',
      id: 23,
      projectId: nodeIdSchema.parse('node-1'),
      server: serverRegistrationIdSchema.parse('registration-2'),
      name: docNameSchema.parse('plan.md'),
      content: '# Plan\n\n- read the failing test\n',
    },
    { type: 'doc-save', id: 24, nodeId: nodeIdSchema.parse('node-3'), content: '' },
    { type: 'doc-open', id: 25, nodeId: nodeIdSchema.parse('node-3') },
    { type: 'protocol-error', code: 'bad-request', message: 'frame is not valid JSON' },
    {
      type: 'approval-decide',
      id: 26,
      storeId: storeIdSchema.parse('store-work'),
      sessionId: sessionIdSchema.parse('session-1'),
      approvalId: approvalIdSchema.parse('approval-7f21'),
      decision: 'grant',
    },
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
    { type: 'node-created', replyTo: 16, nodeId: nodeIdSchema.parse('node-3') },
    { type: 'node-renamed', replyTo: 18 },
    { type: 'node-moved', replyTo: 19 },
    { type: 'node-removed', replyTo: 21 },
    { type: 'node-removal-forgotten', replyTo: 22 },
    { type: 'catalogue-changed', version: 12 },
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
                  branch: 'fix/auth-refresh',
                  title: 'the ticket',
                  uncommitted: {
                    files: 3,
                    added: 42,
                    removed: 5,
                    entries: [{ path: 'src/auth/refresh.ts', added: 18, removed: 4 }],
                  },
                },
                source: serverRegistrationIdSchema.parse('registration-1'),
                reportedBy: [serverRegistrationIdSchema.parse('registration-1')],
                reportedAt: 1_000,
                reachable: true,
                holder: {
                  server: serverRegistrationIdSchema.parse('registration-1'),
                  stoppable: true,
                },
                acknowledgedThrough: 900,
                mutedAt: null,
                project: { nodeId: nodeIdSchema.parse('node-1'), name: 'universe' },
                // The row this session is on is the one place a client reads
                // what is pending, which is what makes a reconnection cheap:
                // the state it is sent is the whole truth about what is open.
                approvals: [
                  {
                    approvalId: approvalIdSchema.parse('approval-7f21'),
                    tool: 'Bash',
                    proposal: 'command: prisma migrate deploy --schema ./db',
                    suggestions: [
                      {
                        behavior: 'allow',
                        destination: 'projectSettings',
                        rules: [{ tool: 'Bash', content: 'prisma migrate deploy:*' }],
                      },
                    ],
                    requestedAt: 1_100,
                  },
                ],
              },
            ],
          },
        ],
        servers: [
          {
            registrationId: serverRegistrationIdSchema.parse('registration-1'),
            label: 'workshop',
            address: pairedServerAddressSchema.parse('wss://workshop.example:8443'),
            serverId: serverIdSchema.parse('server-1'),
            phase: 'connected',
            stores: [storeIdSchema.parse('store-work')],
            providers: [
              {
                provider: 'claude',
                state: 'ready',
                version: '2.1.259',
                directory: '/home/robert/.local/bin',
                problem: null,
              },
            ],
            connectedSince: 1_000,
            staleSince: null,
            lastConnectedAt: 1_000,
            staleReason: null,
            draining: null,
            problem: null,
          },
          {
            // The machine that said it was going down: connected, because the
            // socket is up and answering, with the shutdown beside the phase
            // rather than inside it. The two fields together are the reading a
            // client draws, and neither of them alone is one.
            registrationId: serverRegistrationIdSchema.parse('registration-2'),
            label: 'attic',
            address: pairedServerAddressSchema.parse('wss://attic.example:8443'),
            serverId: serverIdSchema.parse('server-2'),
            phase: 'connected',
            stores: [storeIdSchema.parse('store-work')],
            providers: [],
            connectedSince: 1_000,
            staleSince: null,
            lastConnectedAt: 1_000,
            staleReason: null,
            draining: {
              since: 1_200,
              graceMs: 15_000,
              sessions: [
                {
                  storeId: storeIdSchema.parse('store-work'),
                  sessionId: sessionIdSchema.parse('session-2'),
                },
              ],
            },
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
    {
      type: 'session-subscribed',
      replyTo: 10,
      storeId: storeIdSchema.parse('store-work'),
      sessionId: null,
      startId: 4,
      replayChunks: 0,
      droppedBytes: 0,
    },
    { type: 'session-unsubscribed', replyTo: 11 },
    {
      type: 'terminal-output',
      storeId: storeIdSchema.parse('store-work'),
      sessionId: sessionIdSchema.parse('session-1'),
      startId: null,
      chunk: encodeTerminalChunk(new TextEncoder().encode('\u001b[2K\u2819 thinking')),
      droppedChunks: 0,
    },
    {
      type: 'session-subscription-ended',
      target: {
        by: 'session',
        storeId: storeIdSchema.parse('store-work'),
        sessionId: sessionIdSchema.parse('session-1'),
      },
      reason: 'server-dropped',
    },
    // The same frame about a pane that is still watching a spawn nobody has
    // named: a subscription by start handle is the case a frame addressed by
    // session id could not reach at all.
    {
      type: 'session-subscription-ended',
      target: { by: 'start', startId: 4 },
      reason: 'server-draining',
    },
    {
      type: 'server-paired',
      replyTo: 14,
      registrationId: serverRegistrationIdSchema.parse('registration-2'),
    },
    { type: 'server-unpaired', replyTo: 15 },
    { type: 'protocol-error', code: 'protocol-version', message: 'this hub speaks version 2' },
    {
      type: 'directory-listing',
      replyTo: 14,
      directory: null,
      roots: ['/Users/dev/code', '/srv/work'],
      entries: [
        { name: '/Users/dev/code', kind: 'directory' },
        { name: '/srv/work', kind: 'directory' },
      ],
      truncated: false,
    },
    {
      type: 'directory-listing',
      replyTo: 15,
      directory: '/Users/dev/code',
      roots: ['/Users/dev/code'],
      entries: [
        { name: '.git', kind: 'directory' },
        { name: 'README.md', kind: 'file' },
        { name: 'latest', kind: 'other' },
      ],
      truncated: true,
    },
    { type: 'doc-created', replyTo: 16, nodeId: nodeIdSchema.parse('node-3') },
    { type: 'doc-saved', replyTo: 17, updatedAt: 1_756_000_000_000 },
    {
      type: 'doc-content',
      replyTo: 18,
      content: '# Plan\n\n- read the failing test\n',
      updatedAt: 1_756_000_000_000,
    },
    { type: 'approval-decided', replyTo: 26, outcome: 'granted' },
    { type: 'approval-decided', replyTo: 26, outcome: 'withdrawn' },
  ];

  it('sends terminal output with no replyTo either: a stream is nobody\u2019s reply', () => {
    const output = hubFrames.find((frame) => frame.type === 'terminal-output');
    expect(output).toBeDefined();
    expect(output).not.toHaveProperty('replyTo');
  });

  it('says a subscription ended with no replyTo: nobody asked for the news', () => {
    // `session-unsubscribed` is the frame this is not. That one answers the
    // detach a client sent and needs its id; this one is the hub reporting a
    // machine that went away, which no client asked about.
    const ended = hubFrames.filter((frame) => frame.type === 'session-subscription-ended');
    expect(ended).toHaveLength(2);
    for (const frame of ended) expect(frame).not.toHaveProperty('replyTo');
  });

  it('refuses a subscription end whose reason is not one of the three', () => {
    expect(
      parseHubFrame({
        type: 'session-subscription-ended',
        target: { by: 'start', startId: 4 },
        reason: 'server went away',
      }).ok,
    ).toBe(false);
  });

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

/**
 * The client leg of the document frames, and what it will not take.
 *
 * The name and the content are the server leg's own schemas rather than a
 * second pair, so what is proved here is that reuse: a name the hub accepts is
 * one the machine at the far end accepts, and there is no shape a client can
 * get past this parser and have refused a hop later for a reason nobody can
 * see. The traversal cases live beside the schema in `doc.test.ts`; these are
 * the two that would otherwise be restated on a frame.
 */
describe('parseClientFrame on the document frames', () => {
  const PROJECT = nodeIdSchema.parse('node-1');
  const SERVER = serverRegistrationIdSchema.parse('registration-2');

  it('refuses a create whose name would leave the project folder', () => {
    for (const name of ['../secrets.md', 'notes/plan.md', '.hidden.md', 'plan.sh']) {
      expect(
        parseClientFrame({
          type: 'doc-create',
          id: 1,
          projectId: PROJECT,
          server: SERVER,
          name,
          content: 'anything',
        }).ok,
      ).toBe(false);
    }
  });

  it('refuses content past the cap on either write frame', () => {
    const tooLong = 'x'.repeat(DOC_CONTENT_MAX_CHARS + 1);
    expect(
      parseClientFrame({
        type: 'doc-create',
        id: 1,
        projectId: PROJECT,
        server: SERVER,
        name: 'plan.md',
        content: tooLong,
      }).ok,
    ).toBe(false);
    expect(
      parseClientFrame({ type: 'doc-save', id: 2, nodeId: PROJECT, content: tooLong }).ok,
    ).toBe(false);
  });

  it('takes an empty document, because emptying a file is an edit', () => {
    expect(parseClientFrame({ type: 'doc-save', id: 2, nodeId: PROJECT, content: '' }).ok).toBe(
      true,
    );
  });

  it('carries no directory on any of the three: the hub holds the rows', () => {
    // The rule the amendment left standing. A client names a project node and
    // a document node; the only party that turns either into a path is the one
    // holding the database.
    expect(
      parseClientFrame({
        type: 'doc-create',
        id: 1,
        projectId: PROJECT,
        server: SERVER,
        name: 'plan.md',
        content: '',
        directory: '/srv/work',
      }),
    ).toEqual({
      ok: true,
      value: {
        type: 'doc-create',
        id: 1,
        projectId: PROJECT,
        server: SERVER,
        name: 'plan.md',
        content: '',
      },
    });
  });
});

/**
 * The client leg of an approval: one answer out, one outcome back.
 *
 * What a client may say about a pending request is two words, and what it is
 * told is what became of the request rather than what became of its own click.
 * Two clients answering at once is the case the whole shape is for: both are
 * answered, one of them decided it, and neither is told a different story.
 */
describe('the approval frames on the client leg', () => {
  const A_DECISION = {
    type: 'approval-decide',
    id: 30,
    storeId: storeIdSchema.parse('store-work'),
    sessionId: sessionIdSchema.parse('session-1'),
    approvalId: approvalIdSchema.parse('approval-7f21'),
    decision: 'deny',
  };

  it('accepts an answer naming the session and the approval', () => {
    expect(parseClientFrame(A_DECISION).ok).toBe(true);
  });

  it('refuses an answer that names no session', () => {
    // A client names a session, and the hub resolves which machine holds it.
    // An approval id alone would have the hub searching every server it has
    // for a request a client is only guessing still exists.
    const { storeId: _store, ...withoutStore } = A_DECISION;
    expect(parseClientFrame(withoutStore).ok).toBe(false);
  });

  it('carries no message, no argv and no proposal back toward the agent', () => {
    const parsed = parseClientFrame({
      ...A_DECISION,
      message: 'use staging',
      proposal: 'command: prisma migrate deploy --schema ./db',
      command: 'rm -rf /',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).not.toHaveProperty('message');
    expect(parsed.value).not.toHaveProperty('proposal');
    expect(parsed.value).not.toHaveProperty('command');
  });

  it('refuses a decision spelled as an outcome', () => {
    expect(parseClientFrame({ ...A_DECISION, decision: 'denied' }).ok).toBe(false);
  });

  it('answers with what became of the request, including the two races', () => {
    for (const outcome of ['granted', 'denied', 'withdrawn', 'expired']) {
      expect(parseHubFrame({ type: 'approval-decided', replyTo: 30, outcome }).ok).toBe(true);
    }
  });

  it('refuses an outcome outside the four', () => {
    expect(parseHubFrame({ type: 'approval-decided', replyTo: 30, outcome: 'pending' }).ok).toBe(
      false,
    );
  });

  it('is a reply and never a broadcast: it says which frame it answers', () => {
    // The change itself reaches every other client on the session row of the
    // next machine state. This is the receipt for the one that asked.
    expect(parseHubFrame({ type: 'approval-decided', outcome: 'granted' }).ok).toBe(false);
  });
});
