import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseClientFrame,
  parseHubFrame,
  parseHubToServerFrame,
  parseServerToHubFrame,
  parseTextFrame,
  PROTOCOL_VERSION,
  serverIdSchema,
  sessionIdSchema,
  storeIdSchema,
  type ClientFrame,
  type HubFrame,
  type HubToServerFrame,
  type ServerToHubFrame,
  type ServerRegistrationId,
  type StoreDescriptor,
} from '@agentplex/protocol';
import {
  createFakeMessageSocket,
  createFakeTimers,
  createSocketPair,
  type FakeMessageSocket,
} from '@agentplex/node-shared/testing';
import {
  createLogger,
  type DialResult,
  type MessageSocket,
  type SocketDialer,
} from '@agentplex/node-shared';
import {
  createFakeProcessProbe,
  createFakeProviderFiles,
  createFakeStoreFiles,
  readProviderFixture,
  readyProvider,
} from '@agentplex/providers/testing';
import { createClaudeAdapter, createProviderRegistry } from '@agentplex/providers';
import { serveServerEnd } from './server-end.js';
import { forbiddenKeysIn, keysOf } from './frame-keys.js';
import { createFakeWorkingTree } from '../../../apps/server/src/fake-working-tree.js';
import { createDirectoryBrowser } from '../../../apps/server/src/directory-browse.js';
import { createFakeDirectoryReader } from '../../../apps/server/src/fake-directory-reader.js';
import { createFakeMachineLoadReader } from '../../../apps/server/src/fake-machine-probe.js';
import { createFakeTerminals } from '../../../apps/server/src/fake-terminals.js';
import { createSessionController } from '../../../apps/server/src/session-control.js';
import { createClients, type Clients } from '../../../apps/hub/src/features/clients/clients.js';
import { createFakeApprovals } from '../../../apps/hub/src/features/approvals/fake-approvals.js';
import { createFakeApprovalPolicy } from '../../../apps/hub/src/features/approval-policy/fake-approval-policy.js';
import { createFakeAttention } from '../../../apps/hub/src/features/attention/fake-attention.js';
import { createFakeCatalogue } from '../../../apps/hub/src/features/catalogue/fake-catalogue.js';
import { createFakeDocs } from '../../../apps/hub/src/features/docs/fake-docs.js';
import { createFakeTerminal } from '../../../apps/hub/src/features/terminal/fake-terminal.js';
import { createExponentialBackoff } from '../../../apps/hub/src/features/servers/backoff.js';
import { createServers, type Servers } from '../../../apps/hub/src/features/servers/servers.js';
import { registerServer } from '../../../apps/hub/src/features/pairing/server-registrations.js';
import {
  createPairing,
  newServerRegistrationSchema,
} from '../../../apps/hub/src/features/pairing/pairing.js';
import {
  openMigratedSchema,
  type MigratedSchema,
} from '../../../apps/hub/src/db/test-migrated-schema.js';
import {
  createFleetState,
  type FleetState,
} from '../../../apps/hub/src/features/fleet-state/fleet-state.js';
import { createProjects } from '../../../apps/hub/src/features/projects/projects.js';
import { createSessions } from '../../../apps/hub/src/features/sessions/sessions.js';

/**
 * One session's transcript, from a client's frame to a file on another machine
 * and back.
 *
 * Everything but the socket and the disk is the shipped code: the real Claude
 * Code adapter over the captured transcripts this repository keeps, the real
 * session controller, a real handshake in both directions, both parsers, the
 * real reducer, and the real relay on the sessions feature. What arrives at
 * the client is what the adapter actually derived out of a captured file,
 * which is the only way to be sure the tab is not showing something a test
 * invented three layers up.
 *
 * The questions it exists to answer are the ones a unit test cannot. That a
 * frame addressed by `{ storeId, sessionId }` alone reaches the machine with
 * the file, because the hub read the provider off its own row. That the
 * activities a client receives are the ones the adapter derived -- tool names
 * from Claude Code, because the captured tool inputs are redacted. That the
 * count bounds what crosses and the answer says when it has cut something. And
 * that each way this can fail is a sentence rather than a silence: a session
 * the hub has never heard of, and a machine that has gone away.
 */

const logger = createLogger('error', () => {});
const START = 1_756_000_000_000;
const clock = { now: () => START };

const WORK = storeIdSchema.parse('store-work');
const MACHINE: ServerRegistrationId = 'registration-attic' as ServerRegistrationId;

const STORE: StoreDescriptor = { storeId: WORK, path: '/volumes/work' };

/**
 * The session in the store, named as Claude Code names its transcript file.
 *
 * The id is the file name and the directory is Claude Code's lossy encoding of
 * a cwd, exactly as the adapter's own tests spell them: this suite drives the
 * real adapter, so the layout has to be the real layout.
 */
const SESSION = sessionIdSchema.parse('10e6c58c-3fc6-4519-8bb4-1c3f7eef0bde');
const PROJECT_DIRECTORY = `${STORE.path}/projects/-Users-dev-Code-agentplex`;

interface Harness {
  readonly state: FleetState;
  readonly clients: Clients;
  readonly connections: Servers;
  /** The server end of each socket dialled, so a test can make the machine go away. */
  readonly live: MessageSocket[];
  /**
   * Both ends of every socket dialled, kept for the frame-shape sweep.
   *
   * A fake socket records what it sent, so the hub end's `sent` is the
   * hub-to-server leg and the server end's is the leg back. Nothing is wrapped
   * and nothing is intercepted: what is asserted on is what a peer would read.
   */
  readonly dialled: { readonly hubEnd: FakeMessageSocket; readonly serverEnd: FakeMessageSocket }[];
}

let migrated: MigratedSchema | null = null;
let harness: Harness | null = null;
let suite = 0;

function held(): Harness {
  if (harness === null) throw new Error('no harness: beforeEach did not run');
  return harness;
}

/** One hub, one paired machine, and the captured transcripts on its volume. */
async function start(transcripts: Readonly<Record<string, string>>): Promise<Harness> {
  suite += 1;
  migrated = await openMigratedSchema(`transcript-relay-${suite}`);
  const database = migrated.database;
  const live: MessageSocket[] = [];
  const dialled: { hubEnd: FakeMessageSocket; serverEnd: FakeMessageSocket }[] = [];

  await registerServer(
    database,
    { newId: () => MACHINE },
    clock,
    newServerRegistrationSchema.parse({
      label: 'attic',
      address: 'wss://attic.example:8443',
      token: 'tok-attic',
    }),
  );

  const dialer: SocketDialer = {
    dial: async (): Promise<DialResult> => {
      const { hubEnd, serverEnd } = createSocketPair();
      const files = createFakeProviderFiles({ files: transcripts });
      // The real adapter, not the fake one. The derivations this suite is
      // about -- a tool name becoming a command, a redacted payload becoming
      // nothing -- are that adapter's, and a fake with its own vocabulary
      // would be a suite asserting against itself.
      const adapter = createClaudeAdapter({ files, probe: createFakeProcessProbe({}) });
      serveServerEnd(serverEnd, {
        identity: { serverId: serverIdSchema.parse('server-attic'), token: 'tok-attic' },
        stores: [STORE],
        providers: [readyProvider('claude')],
        terminals: createFakeTerminals().terminals,
        machineLoad: createFakeMachineLoadReader(),
        sessions: createSessionController({
          stores: [STORE],
          providers: createProviderRegistry([adapter]),
          terminals: createFakeTerminals().terminals,
          workingTree: createFakeWorkingTree(),
          browse: createDirectoryBrowser({ roots: [], reader: createFakeDirectoryReader() }),
          // No hook socket in this suite: a transcript is a file this
          // controller reads, and nothing here starts anything to ask about.
          approvals: null,
          clock,
          logger,
        }),
        logger,
      });
      live.push(serverEnd);
      dialled.push({ hubEnd, serverEnd });
      serverEnd.onMessage(() => {});
      return { ok: true, socket: hubEnd };
    },
  };

  const timers = createFakeTimers();
  const state = createFleetState({ logger });
  const pairing = createPairing({
    database,
    files: createFakeStoreFiles(),
    ids: { newId: () => 'unused' },
    clock,
    logger,
  });
  const connections = createServers({
    pairing,
    dialer,
    hubId: 'hub-under-test' as never,
    timers,
    clock,
    logger,
    backoff: createExponentialBackoff({ baseMs: 500, maxMs: 8_000, random: () => 0 }),
    onChange: (report) => state.applyConnection(report),
    // The store reports are what put the session into the hub's own rows, and
    // the row is what the relay reads the provider off. Without this wiring the
    // hub would refuse every transcript for a session it cannot see -- which is
    // one of the refusals below, and has to be reachable for the right reason.
    onReport: (report) => {
      state.applySessions({
        registrationId: report.registrationId,
        storeId: report.storeId,
        sessions: report.sessions,
        holding: report.holding,
        reportedAt: clock.now(),
      });
    },
  });

  const ids = { newId: () => 'unused' };
  const projects = createProjects({
    database,
    ids,
    clock,
    state,
    connections,
    logger,
    onTreeChanged: () => undefined,
  });

  const clients = createClients({
    hubId: 'hub-under-test' as never,
    state,
    timers,
    logger,
    readLayout: async () => [],
    readPaneLayout: async () => null,
    writePaneLayout: async () => undefined,
    sessions: createSessions({
      state,
      projects,
      connections,
      ids,
      logger,
      // Nothing here starts a session, so there is no task to record.
      onStarted: async () => undefined,
    }),
    attention: createFakeAttention(),
    // Nothing in this file answers an approval or writes a rule, and no push
    // goes out; a broadcast built without the seams would not be the one the
    // hub runs.
    approvals: createFakeApprovals(),
    approvalPolicy: createFakeApprovalPolicy(),
    push: null,
    pairing,
    syncServers: () => connections.sync(),
    projects,
    // Not this suite's subject: nothing here draws a tree, reads a document or
    // watches a terminal, and a fake is what a suite stands on where a seam is
    // not what it is about.
    catalogue: createFakeCatalogue(),
    docs: createFakeDocs(),
    terminal: createFakeTerminal(),
  });

  await connections.sync();

  return { state, clients, connections, live, dialled };
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Client {
  say(frame: ClientFrame): Promise<void>;
  reply(id: number): HubFrame;
  /** Everything this client put on the wire, and everything the hub sent it. */
  said(): ClientFrame[];
  heard(): HubFrame[];
}

/**
 * A frame read back through the parser the peer it was addressed to would use.
 *
 * Parsed rather than `JSON.parse`d, in every direction: what a test asserts on
 * is then what a peer would actually read, and a frame that no longer parses
 * fails here rather than being walked as an anonymous object.
 */
function parsedFrame<T>(parser: (raw: unknown) => { ok: boolean }, text: string): T {
  const result = parseTextFrame(parser as never, text) as
    { ok: true; value: T } | { ok: false; reason: string };
  if (!result.ok) throw new Error(`an unparseable frame reached a peer: ${result.reason}`);
  return result.value;
}

/** A client on a socket, read back through the parser a client would use. */
async function attach(): Promise<Client> {
  const socket = createFakeMessageSocket();
  socket.onMessage(() => {});
  held().clients.attach(socket);

  const outbound: string[] = [];

  const client: Client = {
    async say(frame: ClientFrame): Promise<void> {
      const text = JSON.stringify(frame);
      outbound.push(text);
      socket.receive(text);
      // An answer that crosses to another machine and back takes more than one
      // turn of the loop.
      for (let turn = 0; turn < 40; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    reply(id: number): HubFrame {
      const answer = client.heard().find((frame) => 'replyTo' in frame && frame.replyTo === id);
      if (answer === undefined) throw new Error(`nothing answered frame ${String(id)}`);
      return answer;
    },
    said(): ClientFrame[] {
      return outbound.map((text) => parsedFrame(parseClientFrame, text));
    },
    heard(): HubFrame[] {
      return socket.sent.map((text) => parsedFrame(parseHubFrame, text));
    },
  };

  await client.say({ type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION });
  return client;
}

async function connected(transcripts: Readonly<Record<string, string>>): Promise<void> {
  harness = await start(transcripts);
  await until(
    () =>
      held()
        .connections.snapshot()
        .every((report) => report.phase === 'connected'),
    'the server to be connected',
  );
  await until(
    () => held().state.snapshot().stores.length > 0,
    'the machine to report what it has in that store',
  );
}

afterEach(async () => {
  await held().connections.stop();
  harness?.clients.stop();
  await migrated?.close();
  harness = null;
  migrated = null;
});

describe('reading a captured transcript through the hub', () => {
  beforeEach(async () => {
    // Two turns' worth of one captured Claude Code transcript, in the layout
    // Claude Code actually writes: one file per session inside a per-project
    // directory whose name is a lossy encoding of a cwd. Read from the
    // repository's own fixtures rather than written here, because a fixture is
    // captured real output and the whole point of this suite is that what the
    // client sees came out of one.
    const completed = await readProviderFixture('claude-completed-turn.jsonl');
    const pending = await readProviderFixture('claude-pending-tool-use.jsonl');
    await connected({ [`${PROJECT_DIRECTORY}/${SESSION}.jsonl`]: `${completed}${pending}` });
  });

  it('answers with the activities the adapter derived out of the captured file', async () => {
    const client = await attach();

    await client.say({
      type: 'session-transcript',
      id: 2,
      storeId: WORK,
      sessionId: SESSION,
      count: 50,
    });

    // One tool call in each capture, and the name is all the files honestly
    // say: the tool inputs are redacted to `{}`, so `Bash` is the claim and
    // nothing about what it ran is invented on the way across two machines.
    // Oldest first, which is the order they happened in and the order a
    // transcript is drawn in.
    expect(client.reply(2)).toEqual({
      type: 'session-transcript-read',
      replyTo: 2,
      activities: [
        { kind: 'command', text: 'Bash' },
        { kind: 'command', text: 'Bash' },
      ],
      olderExist: false,
    });
  });

  it('bounds what crosses by the count, and says there is more behind it', async () => {
    const client = await attach();

    await client.say({
      type: 'session-transcript',
      id: 2,
      storeId: WORK,
      sessionId: SESSION,
      count: 1,
    });
    // One of the two, and the answer says the session did more before it. That
    // second fact is the one a reader cannot work out from a list, and it is
    // what stops a tab presenting a tail as the whole of a session.
    expect(client.reply(2)).toEqual({
      type: 'session-transcript-read',
      replyTo: 2,
      activities: [{ kind: 'command', text: 'Bash' }],
      olderExist: true,
    });
  });

  it('refuses a session the hub has never heard of, in words', async () => {
    const client = await attach();

    await client.say({
      type: 'session-transcript',
      id: 2,
      storeId: WORK,
      sessionId: sessionIdSchema.parse('99999999-3fc6-4519-8bb4-1c3f7eef0bde'),
      count: 50,
    });

    expect(client.reply(2)).toEqual({
      type: 'refusal',
      replyTo: 2,
      code: 'refused',
      message: 'the hub has no record of that session in that store',
      // A transcript has no live process to name as the reason.
      holder: null,
    });
  });

  it('refuses a store no paired machine has mounted, in words', async () => {
    const client = await attach();

    await client.say({
      type: 'session-transcript',
      id: 2,
      storeId: storeIdSchema.parse('store-elsewhere'),
      sessionId: SESSION,
      count: 50,
    });

    expect(client.reply(2)).toMatchObject({
      type: 'refusal',
      replyTo: 2,
      code: 'refused',
      message: 'no server the hub is paired with has that store mounted',
    });
  });

  it('carries no key that would make a transcript an execution surface', async () => {
    // The rule `session-start.integration.test.ts` holds the start and stop
    // frames to, applied to the four frames this ticket added -- which that
    // suite cannot see, because it walks the frames its own conversation
    // produced. The walk itself is shared rather than copied, so a rule that
    // moves moves for both.
    //
    // A transcript is where this matters most: every activity on it is derived
    // from something an agent actually ran, so the temptation to call the
    // display string `command` is right there in the data. It crosses as
    // `text`, and this says so about the real frames rather than about a
    // schema.
    const client = await attach();

    await client.say({
      type: 'session-transcript',
      id: 2,
      storeId: WORK,
      sessionId: SESSION,
      count: 50,
    });

    const hubToServer = held().dialled.flatMap((pair) =>
      pair.hubEnd.sent.map((text) => parsedFrame<HubToServerFrame>(parseHubToServerFrame, text)),
    );
    const serverToHub = held().dialled.flatMap((pair) =>
      pair.serverEnd.sent.map((text) => parsedFrame<ServerToHubFrame>(parseServerToHubFrame, text)),
    );

    // The frames this ticket added really are among what is about to be walked.
    // A sweep over a conversation that never happened would pass on its own.
    expect(client.said().some((frame) => frame.type === 'session-transcript')).toBe(true);
    expect(client.heard().some((frame) => frame.type === 'session-transcript-read')).toBe(true);
    expect(hubToServer.some((frame) => frame.type === 'session-transcript')).toBe(true);
    expect(serverToHub.some((frame) => frame.type === 'session-transcript-read')).toBe(true);

    for (const frame of [...client.said(), ...client.heard(), ...hubToServer, ...serverToHub]) {
      expect(forbiddenKeysIn(frame), `${frame.type} carried a forbidden key`).toEqual([]);
    }

    // And the one word with two meanings: a session descriptor carries `cwd` as
    // a label somebody reads, and no instruction may carry it at all, because a
    // `{ cwd }` on an instruction is a remote code execution primitive wearing
    // a path. A transcript request names a session and never a directory.
    for (const frame of [...client.said(), ...hubToServer]) {
      expect(keysOf(frame), `${frame.type} carried a cwd`).not.toContain('cwd');
    }
  });

  it('refuses, rather than serving a copy, when the machine has gone away', async () => {
    // The whole cost of the hub holding no transcript, stated out loud: the
    // row stays on screen, and the history behind it is unavailable until the
    // machine is back. A hub that answered from a cache here would be showing
    // a session's history as of whenever somebody last looked.
    const client = await attach();
    for (const socket of held().live) {
      socket.close({ code: 1006, reason: 'the machine went away' });
    }
    await until(
      () =>
        held()
          .state.snapshot()
          .stores.every((store) => !store.reachable),
      'the machine to go away',
    );

    await client.say({
      type: 'session-transcript',
      id: 2,
      storeId: WORK,
      sessionId: SESSION,
      count: 50,
    });

    expect(client.reply(2)).toMatchObject({
      type: 'refusal',
      replyTo: 2,
      code: 'refused',
      message: 'no server with that store mounted is connected right now',
    });
  });
});
