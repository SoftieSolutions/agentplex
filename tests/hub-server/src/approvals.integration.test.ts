import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
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
      storeId: WORK,
      sessionId: BLOCKED,
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
      storeId: WORK,
      sessionId: BLOCKED,
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
      storeId: WORK,
      sessionId: BLOCKED,
      approvalId: pending?.approvalId,
      decision: 'grant',
    });
    const denying = second.asking({
      type: 'approval-decide',
      storeId: WORK,
      sessionId: BLOCKED,
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
      storeId: WORK,
      sessionId: BLOCKED,
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
      storeId: WORK,
      sessionId: BLOCKED,
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
      storeId: WORK,
      sessionId: BLOCKED,
      approvalId: pending?.approvalId,
      decision: 'grant',
    });
    expect(granted).toMatchObject({ type: 'approval-decided', outcome: 'granted' });
  });
});
