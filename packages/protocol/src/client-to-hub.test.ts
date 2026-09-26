import { describe, expect, it } from 'vitest';
import { TRANSCRIPT_ACTIVITIES_MAX } from './activity.js';
import { approvalIdSchema, approvalPolicyRuleIdSchema } from './approval.js';
import { CLIENT_PROTOCOL_VERSION } from './version.js';
import { parseClientFrame, type ClientFrame } from './client-to-hub.js';
import {
  nodeIdSchema,
  serverRegistrationIdSchema,
  sessionIdSchema,
  storeIdSchema,
} from './identity.js';
import { parseTextFrame } from './parse.js';
import { pushEndpointSchema, pushSubscriptionSchema } from './push.js';
import { DOC_CONTENT_MAX_CHARS, docNameSchema } from './doc.js';

describe('parseClientFrame', () => {
  it('accepts hello with a version', () => {
    const result = parseClientFrame({
      type: 'hello',
      id: 1,
      protocolVersion: CLIENT_PROTOCOL_VERSION,
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

  it('takes a pause and a resume shaped exactly like a stop', () => {
    for (const type of ['session-pause', 'session-resume']) {
      const frame = { type, id: 2, storeId: 'store-work', sessionId: 'session-1' };
      expect(parseClientFrame(frame)).toEqual({ ok: true, value: frame });
      expect(parseClientFrame({ type, id: 2, storeId: 'store-work' }).ok).toBe(false);
      const named = parseClientFrame({ ...frame, terminalId: 'terminal-1' });
      expect(named.ok).toBe(true);
      if (!named.ok) return;
      expect(named.value).not.toHaveProperty('terminalId');
    }
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

/**
 * The two push frames, and what a subscription may not smuggle.
 *
 * The subscription schema is the protocol's own (`push.ts`), so what is proved
 * here is the frame around it: that a client may say "tell me" and "stop
 * telling me", and that neither frame is a place to describe the session a
 * notification would be about. The endpoint rules themselves live beside the
 * schema, where a refusal's words are the thing under test.
 */
describe('parseClientFrame on the push frames', () => {
  const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bHxN0-example';
  const KEYS = {
    p256dh:
      'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  };

  it('accepts a subscribe carrying what the browser handed over', () => {
    expect(
      parseClientFrame({
        type: 'push-subscribe',
        id: 1,
        subscription: { endpoint: ENDPOINT, keys: KEYS },
      }).ok,
    ).toBe(true);
  });

  it('refuses a subscribe whose endpoint is not one the hub may POST to', () => {
    for (const endpoint of ['http://push.example/x', 'https://u:p@push.example/x', 'nonsense']) {
      expect(
        parseClientFrame({
          type: 'push-subscribe',
          id: 1,
          subscription: { endpoint, keys: KEYS },
        }).ok,
      ).toBe(false);
    }
  });

  it('carries no title, directory or branch: a notification says none of them', () => {
    // The fields that would put a proposal or a path on a lock screen. What a
    // push says is built from an edge the hub saw, and a subscriber never
    // names any of it -- so there is nowhere here to put one.
    const smuggled = parseClientFrame({
      type: 'push-subscribe',
      id: 1,
      subscription: { endpoint: ENDPOINT, keys: KEYS },
      title: 'fix-auth-refresh',
      cwd: '/Users/robert/code/agentplex',
      branch: 'fix/auth-refresh',
    });
    expect(smuggled.ok).toBe(true);
    if (!smuggled.ok) return;
    for (const forbidden of ['title', 'cwd', 'branch']) {
      expect(smuggled.value).not.toHaveProperty(forbidden);
    }
  });

  it('accepts an unsubscribe naming the endpoint, which is the subscription', () => {
    expect(parseClientFrame({ type: 'push-unsubscribe', id: 2, endpoint: ENDPOINT }).ok).toBe(true);
  });

  it('refuses an unsubscribe whose endpoint could not have been stored', () => {
    expect(
      parseClientFrame({ type: 'push-unsubscribe', id: 2, endpoint: 'http://push.example/x' }).ok,
    ).toBe(false);
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
    { type: 'hello', id: 1, protocolVersion: CLIENT_PROTOCOL_VERSION },
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
    {
      type: 'session-pause',
      id: 40,
      storeId: storeIdSchema.parse('store-work'),
      sessionId: sessionIdSchema.parse('session-1'),
    },
    {
      type: 'session-resume',
      id: 41,
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
    {
      type: 'push-subscribe',
      id: 26,
      subscription: pushSubscriptionSchema.parse({
        endpoint: 'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bHxN0-example',
        keys: {
          p256dh:
            'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
          auth: 'tBHItJI5svbpez7KI4CCXg',
        },
      }),
    },
    {
      type: 'push-unsubscribe',
      id: 27,
      endpoint: pushEndpointSchema.parse(
        'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABexample',
      ),
    },
    { type: 'protocol-error', code: 'bad-request', message: 'frame is not valid JSON' },
    {
      type: 'approval-decide',
      id: 26,
      subject: {
        kind: 'session',
        storeId: storeIdSchema.parse('store-work'),
        sessionId: sessionIdSchema.parse('session-1'),
      },
      approvalId: approvalIdSchema.parse('approval-7f21'),
      decision: 'grant',
    },
    { type: 'approval-policy-list', id: 27, projectId: nodeIdSchema.parse('node-project-work') },
    {
      type: 'approval-policy-add',
      id: 28,
      projectId: nodeIdSchema.parse('node-project-work'),
      rule: { tool: 'Bash', proposal: 'command: pnpm test' },
    },
    {
      type: 'approval-policy-remove',
      id: 29,
      projectId: nodeIdSchema.parse('node-project-work'),
      ruleId: approvalPolicyRuleIdSchema.parse('rule-1'),
    },
  ];

  it.each(clientFrames)('the hub reads back the $type a client sends', (frame) => {
    expect(parseTextFrame(parseClientFrame, JSON.stringify(frame))).toEqual({
      ok: true,
      value: frame,
    });
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
    subject: {
      kind: 'session',
      storeId: storeIdSchema.parse('store-work'),
      sessionId: sessionIdSchema.parse('session-1'),
    },
    approvalId: approvalIdSchema.parse('approval-7f21'),
    decision: 'deny',
  };

  it('accepts an answer naming the session and the approval', () => {
    expect(parseClientFrame(A_DECISION).ok).toBe(true);
  });

  it('accepts an answer naming a graph run and the node it waits at', () => {
    expect(
      parseClientFrame({
        ...A_DECISION,
        subject: { kind: 'graphRun', runId: 'run-38', nodeId: 'gate' },
      }).ok,
    ).toBe(true);
  });

  it('refuses an answer that names no subject', () => {
    // A client names what it answers, and the hub resolves which machine --
    // or which run of its own -- holds it. An approval id alone would have the
    // hub searching everything it has for a request a client is only guessing
    // still exists.
    const { subject: _subject, ...withoutSubject } = A_DECISION;
    expect(parseClientFrame(withoutSubject).ok).toBe(false);
  });

  it('refuses the old spelling, with the session ids flat on the frame', () => {
    const { subject, ...flat } = A_DECISION;
    expect(
      parseClientFrame({ ...flat, storeId: subject.storeId, sessionId: subject.sessionId }).ok,
    ).toBe(false);
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

  it('asks for one project’s rules, naming the project by its node', () => {
    expect(parseClientFrame({ type: 'approval-policy-list', id: 1, projectId: PROJECT }).ok).toBe(
      true,
    );
  });

  it('refuses a policy question naming a session instead of a project', () => {
    // There is no per-session policy and no frame that could ask for one. A
    // rule is a statement about a body of work, and the only handle on one here
    // is a node id.
    expect(
      parseClientFrame({
        type: 'approval-policy-list',
        id: 1,
        storeId: storeIdSchema.parse('store-work'),
        sessionId: sessionIdSchema.parse('session-1'),
      }).ok,
    ).toBe(false);
  });

  it('carries a rule as the protocol’s own pair and not as free text', () => {
    expect(
      parseClientFrame({ type: 'approval-policy-add', id: 2, projectId: PROJECT, rule: RULE }).ok,
    ).toBe(true);
    expect(
      parseClientFrame({
        type: 'approval-policy-add',
        id: 2,
        projectId: PROJECT,
        rule: 'Bash command: pnpm test',
      }).ok,
    ).toBe(false);
  });

  it('refuses an add whose rule has no tool or no text', () => {
    // The bound is the frame's; the sentence is `parseApprovalPolicyRule`'s.
    // Both run, and this one is what stops a shapeless rule reaching the hub.
    for (const rule of [{ tool: '', proposal: 'command: pnpm test' }, { tool: 'Bash' }]) {
      expect(
        parseClientFrame({ type: 'approval-policy-add', id: 2, projectId: PROJECT, rule }).ok,
      ).toBe(false);
    }
  });

  it('removes by the id the hub minted, scoped to the project it is in', () => {
    expect(
      parseClientFrame({
        type: 'approval-policy-remove',
        id: 3,
        projectId: PROJECT,
        ruleId: 'rule-1',
      }).ok,
    ).toBe(true);
    // Without the project there is nothing to answer the removal with, and
    // nothing scoping the delete to the policy the client was looking at.
    expect(parseClientFrame({ type: 'approval-policy-remove', id: 3, ruleId: 'rule-1' }).ok).toBe(
      false,
    );
  });
});

describe('the transcript frames', () => {
  const A_REQUEST = {
    type: 'session-transcript',
    id: 9,
    storeId: 'store-a',
    sessionId: '10e6c58c-3fc6-4519-8bb4-1c3f7eef0bde',
    count: 50,
  };

  it('accepts a request addressing the session and bounding the answer', () => {
    expect(parseClientFrame(A_REQUEST).ok).toBe(true);
  });

  it('gives a client nowhere to name the machine or the provider', () => {
    // Which server holds the file and which provider wrote it are the hub's
    // rows to read. A client that could name either would be a client choosing
    // where a read lands, so both are dropped on the way in.
    const parsed = parseClientFrame({ ...A_REQUEST, server: 'srv-1', provider: 'claude' });

    expect(parsed.ok && Object.keys(parsed.value).sort()).toEqual([
      'count',
      'id',
      'sessionId',
      'storeId',
      'type',
    ]);
  });

  it('refuses a count of none, and one past the protocol’s ceiling', () => {
    expect(parseClientFrame({ ...A_REQUEST, count: 0 }).ok).toBe(false);
    expect(parseClientFrame({ ...A_REQUEST, count: TRANSCRIPT_ACTIVITIES_MAX + 1 }).ok).toBe(false);
  });
});

describe('parseClientFrame on the graph frames', () => {
  const PROJECT = nodeIdSchema.parse('node-1');
  const GRAPH = nodeIdSchema.parse('node-9');
  const TRIGGER = {
    id: 'start',
    kind: 'trigger',
    label: 'Start',
    position: { x: 0, y: 0 },
    placement: { kind: 'cheapest' },
    retry: { max: 0, backoff: 1 },
    source: 'manual',
  };

  it('takes a create with a project and a name, and no machine: a graph is the hub’s', () => {
    expect(
      parseClientFrame({ type: 'graph-create', id: 1, projectId: PROJECT, name: 'release' }).ok,
    ).toBe(true);
    expect(
      parseClientFrame({ type: 'graph-create', id: 1, projectId: PROJECT, name: ' ' }).ok,
    ).toBe(false);
  });

  it('parses the document on a save with the same schema the hub stores by', () => {
    expect(
      parseClientFrame({
        type: 'graph-save',
        id: 2,
        nodeId: GRAPH,
        document: { nodes: [TRIGGER], edges: [] },
      }).ok,
    ).toBe(true);
    expect(
      parseClientFrame({
        type: 'graph-save',
        id: 2,
        nodeId: GRAPH,
        document: { nodes: [TRIGGER], edges: [{ from: 'start', to: 'nowhere' }] },
      }).ok,
    ).toBe(false);
    expect(
      parseClientFrame({
        type: 'graph-save',
        id: 2,
        nodeId: GRAPH,
        document: { nodes: [{ ...TRIGGER, kind: 'webhook' }], edges: [] },
      }).ok,
    ).toBe(false);
  });

  it('takes an open and a publish that name the node and nothing else', () => {
    expect(parseClientFrame({ type: 'graph-open', id: 3, nodeId: GRAPH }).ok).toBe(true);
    expect(parseClientFrame({ type: 'graph-publish', id: 4, nodeId: GRAPH }).ok).toBe(true);
    expect(parseClientFrame({ type: 'graph-publish', id: 4 }).ok).toBe(false);
  });
});
