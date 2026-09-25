import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serverIdSchema, type NodeId, type ServerRegistrationId } from '@agentplex/protocol';
import {
  createSocketPair,
  createFakeTimers,
  type FakeTimers,
} from '@agentplex/node-shared/testing';
import {
  createLogger,
  type DialResult,
  type MessageSocket,
  type SocketDialer,
} from '@agentplex/node-shared';
import { createFakeStoreFiles } from '@agentplex/providers/testing';
import { serveServerEnd } from './server-end.js';
import {
  createFakeProjectFiles,
  type FakeProjectFiles,
} from '../../../apps/server/src/projects/fake-project-files.js';
import { createProjectDocs } from '../../../apps/server/src/projects/project-docs.js';
import { createFakeSessionController } from '../../../apps/server/src/sessions/fake-session-controller.js';
import { createFakeTerminals } from '../../../apps/server/src/terminal/fake-terminals.js';
import { createFakeMachineLoadReader } from '../../../apps/server/src/machine-load/fake-machine-probe.js';
import { createExponentialBackoff } from '../../../apps/hub/src/servers/backoff.js';
import { createServers, type Servers } from '../../../apps/hub/src/servers/servers.js';
import { registerServer } from '../../../apps/hub/src/pairing/server-registrations.js';
import {
  createPairing,
  newServerRegistrationSchema,
} from '../../../apps/hub/src/pairing/pairing.js';
import {
  openMigratedSchema,
  type MigratedSchema,
} from '../../../apps/hub/src/db/test-migrated-schema.js';
import {
  createFleetState,
  type FleetState,
} from '../../../apps/hub/src/fleet-state/fleet-state.js';
import { createDocs, type Docs } from '../../../apps/hub/src/docs/docs.js';
import { createProjects, type Projects } from '../../../apps/hub/src/projects/projects.js';
import { docCreateTool } from '../../../apps/hub/src/mcp/doc-create.js';
import { docListTool } from '../../../apps/hub/src/mcp/doc-list.js';
import { docReadTool } from '../../../apps/hub/src/mcp/doc-read.js';
import { docUpdateTool } from '../../../apps/hub/src/mcp/doc-update.js';
import { callTool, type ToolCall } from '../../../apps/hub/src/mcp/test-tool-call.js';

/**
 * The document tools, from an agent's call to a file on another machine's disk
 * and back.
 *
 * The unit suites in `apps/hub/src/mcp` cover what each tool decides against a fake
 * of the docs feature. This is the question no fake can answer: that the
 * feature behind the four tools is the real one over a real migrated schema,
 * that a `doc_create` naming a project node ends as a file under the *server's*
 * own data root -- nowhere near the working tree the project names -- and that
 * `doc_update` replaces it whole, which is what `doc_read` then gets back.
 *
 * It is the same subject `docs.integration.test.ts` has from the client socket,
 * asked from the other caller, and that is deliberate rather than duplication:
 * the claim the docs feature exists to make is that there is one write path
 * with two callers, and a claim about two callers is not tested by one of them.
 *
 * There is no client socket in this file at all. The agent driving this hub
 * attaches to nothing and is answered out of the same four functions a
 * browser's frames reach.
 */

const logger = createLogger('error', () => {});
const START = 1_756_000_000_000;
const clock = { now: () => START };

const WORK = '/srv/work/agentplex';
const DATA_ROOT = '/var/lib/agentplex';
const MACHINE: ServerRegistrationId = 'registration-attic' as ServerRegistrationId;

interface Harness {
  readonly state: FleetState;
  readonly connections: Servers;
  readonly projects: Projects;
  readonly docs: Docs;
  /** The server end of each socket dialled, so a test can make the machine go away. */
  readonly live: MessageSocket[];
  /** The disk under that machine's project file store. */
  readonly disk: FakeProjectFiles;
  readonly timers: FakeTimers;
}

let migrated: MigratedSchema | null = null;
let harness: Harness | null = null;
let suite = 0;

function held(): Harness {
  if (harness === null) throw new Error('no harness: beforeEach did not run');
  return harness;
}

/** One hub, one paired server, and one in-memory disk under that server. */
async function start(): Promise<Harness> {
  suite += 1;
  migrated = await openMigratedSchema(`mcp-docs-${suite}`);
  const database = migrated.database;
  const live: MessageSocket[] = [];
  // One disk for the machine rather than one per connection: a project folder
  // is the machine's, so a document survives the socket that wrote it.
  const disk = createFakeProjectFiles();

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
      serveServerEnd(serverEnd, {
        identity: { serverId: serverIdSchema.parse('server-attic'), token: 'tok-attic' },
        stores: [],
        providers: [],
        terminals: createFakeTerminals().terminals,
        machineLoad: createFakeMachineLoadReader(),
        sessions: createFakeSessionController({ reports: [] }),
        // The real rules over that one disk. The folder derivation, the name
        // parser and the reserved note are the server's own, so what this file
        // asserts about where a file landed is the server's own answer.
        docs: createProjectDocs({ dataRoot: DATA_ROOT, files: disk, logger }),
        logger,
      });
      live.push(serverEnd);
      return { ok: true, socket: hubEnd };
    },
  };

  const timers = createFakeTimers();
  const state = createFleetState({ logger });
  const connections = createServers({
    pairing: createPairing({
      database,
      files: createFakeStoreFiles(),
      ids: { newId: () => 'unused' },
      clock,
      logger,
    }),
    dialer,
    hubId: 'hub-under-test' as never,
    timers,
    clock,
    logger,
    backoff: createExponentialBackoff({ baseMs: 500, maxMs: 8_000, random: () => 0 }),
    onChange: (report) => state.applyConnection(report),
  });

  let minted = 0;
  const ids = { newId: () => `node-${String((minted += 1))}` };
  // No catalogue is running here: what this file follows is a document from a
  // tool call to a file on a machine and back, and nothing in it draws a tree.
  const onTreeChanged = (): undefined => undefined;
  const projects = createProjects({
    database,
    ids,
    clock,
    state,
    connections,
    logger,
    onTreeChanged,
  });
  const docs = createDocs({
    database,
    ids,
    clock,
    state,
    projects,
    connections,
    logger,
    onTreeChanged,
  });

  await connections.sync();

  return { state, connections, projects, docs, live, disk, timers };
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function creating(args: Record<string, unknown> = {}): Promise<ToolCall> {
  return callTool(docCreateTool({ docs: held().docs }), {
    server: MACHINE,
    name: 'plan.md',
    content: '# Plan\n\n- read the failing test\n',
    ...args,
  });
}

function listing(projectId: NodeId): Promise<ToolCall> {
  return callTool(docListTool({ docs: held().docs }), { projectId });
}

function reading(args: Record<string, unknown>): Promise<ToolCall> {
  return callTool(docReadTool({ docs: held().docs }), args);
}

function updating(args: Record<string, unknown>): Promise<ToolCall> {
  return callTool(docUpdateTool({ docs: held().docs }), args);
}

/** A project made through the real feature, and the node id the hub minted. */
async function project(): Promise<NodeId> {
  const made = await held().projects.create({ name: 'agentplex', directory: WORK });
  if (!made.ok) throw new Error(`the project was refused: ${made.problem}`);
  return made.nodeId;
}

/** One document made through `doc_create`, and the node id the tool answered with. */
async function document(projectId: NodeId, args: Record<string, unknown> = {}): Promise<string> {
  const created = await creating({ projectId, ...args });
  if (created.isError) throw new Error(`the create was refused: ${created.text}`);
  const docId = created.structured?.['docId'];
  if (typeof docId !== 'string') throw new Error('the create answered no docId');
  return docId;
}

afterEach(async () => {
  await held().connections.stop();
  await migrated?.close();
  harness = null;
  migrated = null;
});

describe('an agent writing and reading a project document', () => {
  beforeEach(async () => {
    harness = await start();
    await until(
      () =>
        held()
          .connections.snapshot()
          .every((report) => report.phase === 'connected'),
      'the server to be connected',
    );
  });

  it('writes the file under the server data root, from a call that named no path', async () => {
    const projectId = await project();

    const created = await creating({ projectId });

    expect(created.isError).toBe(false);
    expect(created.structured).toEqual({ docId: expect.any(String) as unknown as string });

    // The file is under the server's own data root and nowhere under the
    // working tree the project names. The agent named a node id; the hub turned
    // it into a directory out of its own rows; the server derived its own
    // folder from that. Three parties, and none of them was the caller.
    const written = [...held().disk.written.keys()];
    expect(written.every((path) => path.startsWith(`${DATA_ROOT}/`))).toBe(true);
    expect(written.some((path) => path.startsWith(WORK))).toBe(false);
    const plan = written.find((path) => path.endsWith('/plan.md'));
    expect(plan).toBeDefined();
    expect(held().disk.written.get(plan ?? '')).toBe('# Plan\n\n- read the failing test\n');
  });

  it('replaces the file on an update and reads back what the last update put there', async () => {
    const projectId = await project();
    const docId = await document(projectId);

    const saved = await updating({ docId, content: '# Plan\n\n- fix the refresh loop\n' });
    const read = await reading({ docId });

    expect(saved.isError).toBe(false);
    expect(read.structured?.['content']).toBe('# Plan\n\n- fix the refresh loop\n');
    // And on the disk, which is the assertion a reply cannot make for itself:
    // a save replaces the document whole, so the file is the second version and
    // not the two of them.
    const plan = [...held().disk.written.keys()].find((path) => path.endsWith('/plan.md'));
    expect(held().disk.written.get(plan ?? '')).toBe('# Plan\n\n- fix the refresh loop\n');
  });

  it('carries the machine write time on the update and the read, not the hub clock', async () => {
    const projectId = await project();
    const docId = await document(projectId);

    const saved = await updating({ docId, content: 'second' });
    const read = await reading({ docId });

    // The fake disk counts its writes rather than reading a clock, which is
    // what makes this mean something: the hub's own clock is fixed at START,
    // and neither answer carries it.
    expect(saved.structured?.['updatedAt']).not.toBe(START);
    expect(read.structured?.['updatedAt']).toBe(saved.structured?.['updatedAt']);
  });

  it('lists what the project holds, with the machine named on the row', async () => {
    const projectId = await project();
    const docId = await document(projectId);

    const listed = await listing(projectId);

    expect(listed.structured?.['docs']).toEqual([
      {
        docId,
        name: 'plan.md',
        server: MACHINE,
        label: 'attic',
        reachable: true,
        updatedAt: expect.any(Number) as unknown as number,
      },
    ]);
  });

  it('reads a document named by its project and name, without a listing call first', async () => {
    const projectId = await project();
    const docId = await document(projectId);

    const read = await reading({ projectId, name: 'plan.md' });

    expect(read.structured?.['docId']).toBe(docId);
    expect(read.structured?.['content']).toBe('# Plan\n\n- read the failing test\n');
  });
});

describe('an agent asking about a machine that is not there', () => {
  beforeEach(async () => {
    harness = await start();
    await until(
      () =>
        held()
          .connections.snapshot()
          .every((report) => report.phase === 'connected'),
      'the server to be connected',
    );
  });

  it('lists the document while the machine is away, and refuses to read it', async () => {
    const projectId = await project();
    const docId = await document(projectId);

    // The machine goes away with the file still on its disk, which is the state
    // the index exists for.
    for (const socket of held().live) socket.close({ code: 1001, reason: 'gone' });
    await until(
      () =>
        held()
          .connections.snapshot()
          .every((report) => report.phase !== 'connected'),
      'the server to have dropped',
    );

    const listed = await listing(projectId);
    const read = await reading({ docId });

    // The listing still answers, and says which machine and that it cannot be
    // reached -- which is a claim a reader can weigh rather than a stale copy
    // served as though it were current.
    expect(listed.isError).toBe(false);
    expect(listed.structured?.['docs']).toEqual([
      expect.objectContaining({ docId, label: 'attic', reachable: false }) as unknown as object,
    ]);

    // The read refuses in the feature's own sentence, with the machine named by
    // the label a person typed when they paired it.
    expect(read.isError).toBe(true);
    expect(read.structured).toBeUndefined();
    expect(read.text).toContain('attic is not connected right now');
    expect(read.text).toContain('the hub holds no copy of its documents');
  });

  it('refuses a create on a machine that is away, and writes no index row for it', async () => {
    const projectId = await project();

    for (const socket of held().live) socket.close({ code: 1001, reason: 'gone' });
    await until(
      () =>
        held()
          .connections.snapshot()
          .every((report) => report.phase !== 'connected'),
      'the server to have dropped',
    );

    const created = await creating({ projectId });
    const listed = await listing(projectId);

    expect(created.isError).toBe(true);
    expect(created.text).toContain('attic is not connected right now');
    // Nothing was indexed. A row written for a file that was never created is
    // a node that opens as a refusal forever, which is the failure
    // `doc-rows.ts` orders the write to avoid.
    expect(listed.structured?.['docs']).toEqual([]);
  });

  it('refuses a project this hub does not have, before anything is asked of a machine', async () => {
    const created = await creating({ projectId: 'node-nobody-has' });

    expect(created.isError).toBe(true);
    expect(created.text).toBe('this hub has no project by that id');
    expect(held().disk.written.size).toBe(0);
  });
});
