import { describe, expect, it } from 'vitest';
import {
  APPROVAL_POLICY_RULES_MAX,
  approvalIdSchema,
  approvalPolicyRuleIdSchema,
} from './approval.js';
import { CLIENT_PROTOCOL_VERSION } from './version.js';
import { parseClientFrame } from './client-to-hub.js';
import { parseHubFrame, type HubFrame } from './hub-to-client.js';
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

describe('parseHubFrame', () => {
  it('accepts a welcome', () => {
    const result = parseHubFrame({
      type: 'welcome',
      replyTo: 1,
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      hubId: 'hub-1',
      pushPublicKey: null,
    });
    expect(result.ok).toBe(true);
  });

  it('carries the key a browser subscribes against, or null for a hub with none', () => {
    const key =
      'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
    const withKey = parseHubFrame({
      type: 'welcome',
      replyTo: 1,
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      hubId: 'hub-1',
      pushPublicKey: key,
    });
    expect(withKey).toEqual({
      ok: true,
      value: {
        type: 'welcome',
        replyTo: 1,
        protocolVersion: CLIENT_PROTOCOL_VERSION,
        hubId: 'hub-1',
        pushPublicKey: key,
      },
    });
  });

  it('refuses a welcome that leaves the push key out, so every welcome answers it', () => {
    // Absent and `null` would be one state read two ways. A client has to be
    // able to tell "this hub cannot push" from "this hub did not say", and a
    // missing field is what makes an old hub look like the first.
    expect(
      parseHubFrame({
        type: 'welcome',
        replyTo: 1,
        protocolVersion: CLIENT_PROTOCOL_VERSION,
        hubId: 'hub-1',
      }).ok,
    ).toBe(false);
  });

  it('refuses a welcome whose push key is the empty string rather than null', () => {
    expect(
      parseHubFrame({
        type: 'welcome',
        replyTo: 1,
        protocolVersion: CLIENT_PROTOCOL_VERSION,
        hubId: 'hub-1',
        pushPublicKey: '',
      }).ok,
    ).toBe(false);
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
  const hubFrames: readonly HubFrame[] = [
    {
      type: 'welcome',
      replyTo: 1,
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      hubId: hubIdSchema.parse('hub-1'),
      pushPublicKey: null,
    },
    {
      type: 'welcome',
      replyTo: 2,
      protocolVersion: CLIENT_PROTOCOL_VERSION,
      hubId: hubIdSchema.parse('hub-1'),
      pushPublicKey:
        'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    },
    { type: 'push-subscribed', replyTo: 26 },
    { type: 'push-unsubscribed', replyTo: 27 },
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
        pause: 'none',
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
      type: 'session-named',
      replyTo: 4,
      storeId: storeIdSchema.parse('store-work'),
      sessionId: sessionIdSchema.parse('session-1'),
    },
    {
      type: 'session-stopped',
      replyTo: 6,
      storeId: storeIdSchema.parse('store-work'),
      sessionId: sessionIdSchema.parse('session-1'),
      server: serverRegistrationIdSchema.parse('registration-1'),
    },
    {
      type: 'session-paused',
      replyTo: 40,
      storeId: storeIdSchema.parse('store-work'),
      sessionId: sessionIdSchema.parse('session-1'),
      server: serverRegistrationIdSchema.parse('registration-1'),
      pause: 'requested',
    },
    {
      type: 'session-resumed',
      replyTo: 41,
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
                  process: 'none',
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
                  pause: 'none',
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
                    subject: {
                      kind: 'session',
                      storeId: storeIdSchema.parse('store-work'),
                      sessionId: sessionIdSchema.parse('session-1'),
                    },
                    tool: 'Bash',
                    proposal: 'command: prisma migrate deploy --schema ./db',
                    truncated: false,
                    suggestions: [
                      {
                        behavior: 'allow',
                        destination: 'projectSettings',
                        rules: [{ tool: 'Bash', content: 'prisma migrate deploy:*' }],
                      },
                    ],
                    requestedAt: 1_100,
                    // No rule has answered this one, which is what every
                    // pending approval says until one does.
                    answeredBy: null,
                  },
                ],
                // What this session was started to do, as somebody typed it
                // into the start form. A session the hub did not start carries
                // `null` here rather than a guess made from a transcript.
                task: 'fix the auth refresh loop and open a PR against main',
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
            roundTrip: { ms: 12, load: null, measuredAt: 1_020 },
            os: 'macOS 26.6.2',
            daemonVersion: '2.0.3',
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
            roundTrip: null,
            os: null,
            daemonVersion: null,
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
        graphRunApprovals: [],
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
    { type: 'approval-decided', replyTo: 26, outcome: 'granted', answeredBy: null },
    { type: 'approval-decided', replyTo: 26, outcome: 'withdrawn', answeredBy: null },
    {
      type: 'approval-decided',
      replyTo: 26,
      outcome: 'granted',
      answeredBy: {
        project: nodeIdSchema.parse('node-project-work'),
        ruleId: approvalPolicyRuleIdSchema.parse('rule-1'),
        rule: { tool: 'Bash', proposal: 'command: pnpm test' },
      },
    },
    {
      type: 'approval-policy',
      replyTo: 27,
      projectId: nodeIdSchema.parse('node-project-work'),
      rules: [
        {
          ruleId: approvalPolicyRuleIdSchema.parse('rule-1'),
          rule: { tool: 'Bash', proposal: 'command: pnpm test' },
          createdAt: 1_756_000_000_000,
        },
      ],
    },
    {
      type: 'approval-policy',
      replyTo: 27,
      projectId: nodeIdSchema.parse('node-project-work'),
      rules: [],
    },
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
 * The client leg of an approval: one answer out, one outcome back.
 *
 * What a client may say about a pending request is two words, and what it is
 * told is what became of the request rather than what became of its own click.
 * Two clients answering at once is the case the whole shape is for: both are
 * answered, one of them decided it, and neither is told a different story.
 */
describe('the approval frames on the client leg', () => {
  it('answers with what became of the request, including the two races', () => {
    for (const outcome of ['granted', 'denied', 'withdrawn', 'expired']) {
      expect(
        parseHubFrame({ type: 'approval-decided', replyTo: 30, outcome, answeredBy: null }).ok,
      ).toBe(true);
    }
  });

  it('refuses an outcome outside the four', () => {
    expect(
      parseHubFrame({
        type: 'approval-decided',
        replyTo: 30,
        outcome: 'pending',
        answeredBy: null,
      }).ok,
    ).toBe(false);
  });

  it('is a reply and never a broadcast: it says which frame it answers', () => {
    // The change itself reaches every other client on the session row of the
    // next machine state. This is the receipt for the one that asked.
    expect(
      parseHubFrame({ type: 'approval-decided', outcome: 'granted', answeredBy: null }).ok,
    ).toBe(false);
  });
});

/**
 * The client leg of the standing policy: three questions, one answer.
 *
 * A rule answers on a person's behalf, so every refusal the parser can make is
 * worth a line here. The two that matter most are the shape of the rule itself,
 * which is the protocol's own and not a loose pair of strings, and the project:
 * a policy is keyed by a project node and there is no session-scoped form of
 * any of these frames to reach for.
 */
describe('the approval policy frames on the client leg', () => {
  const PROJECT = nodeIdSchema.parse('node-project-work');
  const RULE = { tool: 'Bash', proposal: 'command: pnpm test' };

  it('answers with the whole policy, and with an empty one for a project with none', () => {
    expect(
      parseHubFrame({ type: 'approval-policy', replyTo: 1, projectId: PROJECT, rules: [] }).ok,
    ).toBe(true);
  });

  it('refuses an answered rule the rule parser would refuse', () => {
    // A row an older build wrote is read back through the same schema. What
    // cannot be a rule does not cross as one.
    expect(
      parseHubFrame({
        type: 'approval-policy',
        replyTo: 1,
        projectId: PROJECT,
        rules: [{ ruleId: 'rule-1', rule: { tool: 'Bash', proposal: '' }, createdAt: 1 }],
      }).ok,
    ).toBe(false);
  });

  it('refuses a policy bigger than one frame may carry', () => {
    const rules = Array.from({ length: APPROVAL_POLICY_RULES_MAX + 1 }, (_unused, index) => ({
      ruleId: `rule-${String(index)}`,
      rule: { tool: 'Bash', proposal: `command: pnpm test ${String(index)}` },
      createdAt: 1,
    }));
    expect(
      parseHubFrame({ type: 'approval-policy', replyTo: 1, projectId: PROJECT, rules }).ok,
    ).toBe(false);
  });

  it('names the rule that answered a request nobody was asked about', () => {
    const parsed = parseHubFrame({
      type: 'approval-decided',
      replyTo: 1,
      outcome: 'granted',
      answeredBy: { project: PROJECT, ruleId: 'rule-1', rule: RULE },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.type !== 'approval-decided') return;
    expect(parsed.value.answeredBy?.rule).toEqual(RULE);
  });
});

describe('the transcript frames', () => {
  it('answers with activities the activity schema parses, and nothing else', () => {
    expect(
      parseHubFrame({
        type: 'session-transcript-read',
        replyTo: 9,
        activities: [{ kind: 'tests', passed: 12, failed: 0 }],
        olderExist: false,
      }).ok,
    ).toBe(true);
    expect(
      parseHubFrame({
        type: 'session-transcript-read',
        replyTo: 9,
        activities: [{ kind: 'command', text: 'pnpm test', command: 'pnpm test' }],
        olderExist: false,
      }).ok,
    ).toBe(false);
  });
});

describe('the start the report named', () => {
  const named = {
    type: 'session-named',
    replyTo: 4,
    storeId: 'store-work',
    sessionId: 'session-1',
  } as const;

  it('names the start it belongs to, the store and the id the provider minted', () => {
    expect(parseHubFrame(named).ok).toBe(true);
  });

  it.each(['replyTo', 'storeId', 'sessionId'] as const)('refuses a naming without %s', (key) => {
    const { [key]: _dropped, ...rest } = named;
    expect(parseHubFrame(rest).ok).toBe(false);
  });

  it('refuses a naming whose id is null: there is nothing to name until the report has one', () => {
    expect(parseHubFrame({ ...named, sessionId: null }).ok).toBe(false);
  });
});

describe('the pause receipt on the client leg', () => {
  it('refuses a receipt that says none, as the server leg does', () => {
    // The hub relays the server's word and adds the server's id. It may not
    // relay a word the server leg could not have carried, so the same
    // exclusion applies here rather than a wider schema the hub would have to
    // re-check by hand.
    expect(
      parseHubFrame({
        type: 'session-paused',
        replyTo: 40,
        storeId: 'store-work',
        sessionId: 'session-1',
        server: 'registration-1',
        pause: 'none',
      }).ok,
    ).toBe(false);
  });

  it.each(['requested', 'paused'] as const)('takes a receipt reading %s', (pause) => {
    expect(
      parseHubFrame({
        type: 'session-paused',
        replyTo: 40,
        storeId: 'store-work',
        sessionId: 'session-1',
        server: 'registration-1',
        pause,
      }).ok,
    ).toBe(true);
  });
});

describe('parseHubFrame on the graph replies', () => {
  const GRAPH = nodeIdSchema.parse('node-9');

  it('answers an open with the draft, its number and the published numbers', () => {
    const result = parseHubFrame({
      type: 'graph-document',
      replyTo: 3,
      nodeId: GRAPH,
      name: 'release',
      draftVersion: 2,
      document: { nodes: [], edges: [] },
      published: [{ version: 1, publishedAt: 1_756_000_000_000 }],
    });
    expect(result.ok).toBe(true);
  });

  it('answers a save with the draft number and the hub’s clock, and a publish with the number', () => {
    expect(
      parseHubFrame({ type: 'graph-saved', replyTo: 2, version: 1, updatedAt: 1_756_000_000_000 })
        .ok,
    ).toBe(true);
    expect(parseHubFrame({ type: 'graph-published', replyTo: 4, version: 1 }).ok).toBe(true);
    expect(parseHubFrame({ type: 'graph-published', replyTo: 4, version: 0 }).ok).toBe(false);
  });
});
