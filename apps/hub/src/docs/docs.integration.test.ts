import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  docNameSchema,
  nodeIdSchema,
  serverAddressSchema,
  type DocName,
  type NodeId,
  type ServerRegistrationId,
} from '@agentplex/protocol';
import { createLogger } from '@agentplex/node-shared';
import type { Database } from '../db/database.js';
import { openMigratedSchema, type MigratedSchema } from '../db/test-migrated-schema.js';
import { createFleetState, type HubStateSnapshot } from '../fleet-state/fleet-state.js';
import type {
  ServerConnectionPhase,
  ServerConnectionReport,
  InstructionOutcome,
  ServerInstruction,
} from '../servers/servers.js';
import { createDocs, type Docs } from './docs.js';

/**
 * The four functions, against a real schema and a servers seam driven by hand.
 *
 * What is here is everything except the relay: which frame each function puts
 * on the wire, what it writes to the index and when, and every refusal it can
 * produce. The relay itself is exercised end to end in
 * `tests/hub-server/src/docs.integration.test.ts`, against a real server over a
 * real handshake, because a frame is only worth testing where there is
 * something at the other end to answer it.
 *
 * The instruction seam is a function that records and answers rather than a
 * mock: what these tests assert is the frame that crossed, and a recorded value
 * says that without anybody asserting on a call count.
 */

const logger = createLogger('error', () => {});
const NOW = 1_756_000_000_000;
const WRITTEN_AT = 1_756_000_500_000;
const clock = { now: () => NOW };

const ATTIC = 'registration-attic' as ServerRegistrationId;
const LOFT = 'registration-loft' as ServerRegistrationId;
const WORK = '/srv/work/agentplex';
const PLAN: DocName = docNameSchema.parse('plan.md');

let migrated: MigratedSchema | null = null;
let minted = 0;
let asked: { server: ServerRegistrationId; instruction: ServerInstruction }[] = [];
let answers: InstructionOutcome[] = [];
/** Every time this feature said the tree had changed. A counter, not a mock. */
let treeChanges = 0;

function db(): Database {
  if (migrated === null) throw new Error('no database: beforeAll did not run');
  return migrated.database;
}

function connection(
  registrationId: ServerRegistrationId,
  label: string,
  phase: ServerConnectionPhase,
): ServerConnectionReport {
  return {
    registrationId,
    label,
    address: serverAddressSchema.parse(`wss://${label}.example:8443`),
    serverId: null,
    phase,
    providers: [],
    stores: [],
    connectedSince: phase === 'connected' ? NOW : null,
    staleSince: phase === 'stale' ? NOW : null,
    lastConnectedAt: phase === 'connecting' ? null : NOW,
    failedAttempts: phase === 'stale' ? 1 : 0,
    problem: null,
    staleReason: phase === 'stale' ? 'unreachable' : null,
    draining: null,
  };
}

/** Two machines: one connected, one paired and away. */
function fleet(loft: ServerConnectionPhase = 'stale'): { snapshot(): HubStateSnapshot } {
  const reducer = createFleetState({ logger });
  reducer.applyConnection(connection(ATTIC, 'attic', 'connected'));
  reducer.applyConnection(connection(LOFT, 'loft', loft));
  return reducer;
}

/** A projects seam holding one project, so a node id becomes a directory. */
function projects(directories: Readonly<Record<string, string>> = {}) {
  return {
    async directoryOf(nodeId: NodeId): Promise<string | null> {
      return directories[nodeId] ?? null;
    },
  };
}

function docs(
  options: {
    readonly fleet?: { snapshot(): HubStateSnapshot };
    readonly directories?: Readonly<Record<string, string>>;
  } = {},
): Docs {
  return createDocs({
    database: db(),
    ids: { newId: () => `node-${String((minted += 1))}` },
    clock,
    state: options.fleet ?? fleet(),
    projects: projects(options.directories ?? { project: WORK }),
    connections: {
      async ask(
        registrationId: ServerRegistrationId,
        instruction: ServerInstruction,
      ): Promise<InstructionOutcome> {
        asked.push({ server: registrationId, instruction });
        const answer = answers.shift();
        if (answer === undefined) throw new Error('nothing was queued for this instruction');
        return answer;
      },
    },
    logger,
    onTreeChanged: () => {
      treeChanges += 1;
    },
  });
}

const PROJECT = nodeIdSchema.parse('project');

/** A project row the foreign keys need, with a node under it to hang docs on. */
async function makeProject(): Promise<void> {
  await db().query(
    `INSERT INTO nodes (id, parent_id, kind, position, name, name_source, created_at)
     VALUES (?, NULL, 'project', 0, 'agentplex', 'user', ?)`,
    [PROJECT, NOW],
  );
  await db().query('INSERT INTO projects (node_id, directory, created_at) VALUES (?, ?, ?)', [
    PROJECT,
    WORK,
    NOW,
  ]);
}

/** The two pairings the docs table's foreign key points at. */
async function pairServers(): Promise<void> {
  for (const [id, label] of [
    [ATTIC, 'attic'],
    [LOFT, 'loft'],
  ]) {
    await db().query(
      'INSERT INTO servers (id, label, address, token, created_at) VALUES (?, ?, ?, ?, ?)',
      [id, label, `wss://${label}.example:8443`, `tok-${label}`, NOW],
    );
  }
}

function written(updatedAt = WRITTEN_AT): InstructionOutcome {
  return { ok: true, answer: { type: 'doc-written', replyTo: 1, updatedAt } };
}

function content(text: string, updatedAt = WRITTEN_AT): InstructionOutcome {
  return { ok: true, answer: { type: 'doc-content', replyTo: 1, content: text, updatedAt } };
}

describe('the docs feature over a real schema', () => {
  beforeAll(async () => {
    migrated = await openMigratedSchema('docs-probe');
  });

  afterAll(async () => {
    await migrated?.close();
  });

  beforeEach(async () => {
    await db().query('DELETE FROM docs');
    await db().query('DELETE FROM nodes');
    await db().query('DELETE FROM servers');
    await pairServers();
    await makeProject();
    minted = 0;
    asked = [];
    answers = [];
    treeChanges = 0;
  });

  describe('create', () => {
    it('puts the project directory and the name on the wire, and writes both rows', async () => {
      answers = [written()];

      const made = await docs().create(PROJECT, ATTIC, PLAN, '# Plan\n');

      // The directory came out of the hub's own rows. Nothing the caller said
      // reached the frame as a path, which is the whole of the amended rule.
      expect(asked).toEqual([
        {
          server: ATTIC,
          instruction: { type: 'doc-write', directory: WORK, name: PLAN, content: '# Plan\n' },
        },
      ]);
      expect(made.ok).toBe(true);
      if (!made.ok) return;

      const node = await db().query(
        'SELECT kind, parent_id, name, name_source FROM nodes WHERE id = ?',
        [made.nodeId],
      );
      expect(node.rows[0]).toEqual({
        kind: 'doc',
        parent_id: PROJECT,
        name: 'plan.md',
        name_source: 'user',
      });
      const row = await db().query(
        'SELECT project_node_id, server_registration_id, name, updated_at FROM docs WHERE node_id = ?',
        [made.nodeId],
      );
      expect(row.rows[0]).toEqual({
        project_node_id: PROJECT,
        server_registration_id: ATTIC,
        name: 'plan.md',
        // The machine's clock and not the hub's: the hub's `now` is NOW, and
        // what is stored is what the server said.
        updated_at: WRITTEN_AT,
      });
    });

    it('says the tree changed once the node is there, and not when nothing was written', async () => {
      // A document is a node, so a create moves the tree and every client has
      // to hear it. The word goes out after the row, never before: a broadcast
      // ahead of the insert would send clients to read a tree that has not
      // moved yet.
      answers = [
        written(),
        { ok: false, code: 'internal', problem: 'cannot write notes.md: ENOSPC', hold: null },
      ];
      const feature = docs();

      await feature.create(PROJECT, ATTIC, PLAN, '# Plan\n');
      expect(treeChanges).toBe(1);

      await feature.create(PROJECT, ATTIC, docNameSchema.parse('notes.md'), '');
      expect(treeChanges).toBe(1);
    });

    it('writes no row when the machine refused the write', async () => {
      answers = [
        { ok: false, code: 'internal', problem: 'cannot write plan.md: ENOSPC', hold: null },
      ];

      const made = await docs().create(PROJECT, ATTIC, PLAN, '# Plan\n');

      expect(made).toEqual({
        ok: false,
        code: 'internal',
        // The machine's own sentence, passed through: it names the file and
        // what its disk said, and the hub has no better words for either.
        problem: 'cannot write plan.md: ENOSPC',
      });
      expect((await db().query('SELECT node_id FROM docs')).rows).toEqual([]);
      expect((await db().query("SELECT id FROM nodes WHERE kind = 'doc'")).rows).toEqual([]);
    });

    it('refuses a machine that is not connected without asking anybody', async () => {
      const made = await docs().create(PROJECT, LOFT, PLAN, '# Plan\n');

      expect(made.ok).toBe(false);
      if (made.ok) return;
      expect(made.code).toBe('refused');
      expect(made.problem).toContain('loft');
      expect(asked).toEqual([]);
    });

    it('refuses a node that is not a project', async () => {
      const made = await docs().create(nodeIdSchema.parse('folder-1'), ATTIC, PLAN, '');

      expect(made).toEqual({
        ok: false,
        code: 'refused',
        problem: 'this hub has no project by that id',
      });
      expect(asked).toEqual([]);
    });

    it('refuses a second document of that name on that machine before it overwrites one', async () => {
      answers = [written()];
      await docs().create(PROJECT, ATTIC, PLAN, '# Plan\n');

      const second = await docs().create(PROJECT, ATTIC, PLAN, '# Something else\n');

      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.problem).toContain('already has a document called plan.md');
      // The check is before the ask, because a write replaces a file whole: a
      // duplicate found afterwards would have already destroyed the first one.
      expect(asked).toHaveLength(1);
    });

    it('takes the same name on a second machine as a second document', async () => {
      answers = [written(), written(WRITTEN_AT + 1_000)];
      const feature = createDocs({
        database: db(),
        ids: { newId: () => `node-${String((minted += 1))}` },
        clock,
        state: fleet('connected'),
        projects: projects({ project: WORK }),
        connections: {
          async ask(server: ServerRegistrationId, instruction: ServerInstruction) {
            asked.push({ server, instruction });
            const answer = answers.shift();
            if (answer === undefined) throw new Error('nothing queued');
            return answer;
          },
        },
        logger,
        onTreeChanged: () => {
          treeChanges += 1;
        },
      });

      const first = await feature.create(PROJECT, ATTIC, PLAN, 'a');
      const second = await feature.create(PROJECT, LOFT, PLAN, 'b');

      // Two machines, two files, two nodes. The data root is exclusive to one
      // server, so there is no sense in which these are one document.
      expect(first.ok && second.ok).toBe(true);
      expect((await db().query('SELECT node_id FROM docs')).rows).toHaveLength(2);
    });
  });

  describe('save', () => {
    it('addresses the machine and the name off the index, not off the caller', async () => {
      answers = [written(), written(WRITTEN_AT + 1_000)];
      const feature = docs();
      const made = await feature.create(PROJECT, ATTIC, PLAN, '# Plan\n');
      if (!made.ok) throw new Error('the create was refused');
      asked = [];

      const saved = await feature.save(made.nodeId, '# Plan\n\n- and a second line\n');

      expect(asked).toEqual([
        {
          server: ATTIC,
          instruction: {
            type: 'doc-write',
            directory: WORK,
            name: PLAN,
            content: '# Plan\n\n- and a second line\n',
          },
        },
      ]);
      expect(saved).toEqual({ ok: true, updatedAt: WRITTEN_AT + 1_000 });
      const row = await db().query('SELECT updated_at FROM docs WHERE node_id = ?', [made.nodeId]);
      expect(row.rows[0]).toEqual({ updated_at: WRITTEN_AT + 1_000 });
    });

    it('leaves the index at the last truthful time when the machine refused', async () => {
      answers = [written(), { ok: false, code: 'internal', problem: 'EACCES', hold: null }];
      const feature = docs();
      const made = await feature.create(PROJECT, ATTIC, PLAN, '# Plan\n');
      if (!made.ok) throw new Error('the create was refused');

      const saved = await feature.save(made.nodeId, 'anything');

      expect(saved).toEqual({ ok: false, code: 'internal', problem: 'EACCES' });
      const row = await db().query('SELECT updated_at FROM docs WHERE node_id = ?', [made.nodeId]);
      expect(row.rows[0]).toEqual({ updated_at: WRITTEN_AT });
    });

    it('refuses a node this hub has no document for', async () => {
      const saved = await docs().save(nodeIdSchema.parse('nothing'), 'x');

      expect(saved).toEqual({
        ok: false,
        code: 'refused',
        problem: 'this hub has no document by that id',
      });
    });
  });

  describe('open', () => {
    it('reads the document back and records a write the hub had not heard about', async () => {
      answers = [written(), content('# Plan\n\n- edited on the machine\n', WRITTEN_AT + 60_000)];
      const feature = docs();
      const made = await feature.create(PROJECT, ATTIC, PLAN, '# Plan\n');
      if (!made.ok) throw new Error('the create was refused');
      asked = [];

      const opened = await feature.open(made.nodeId);

      expect(asked).toEqual([
        { server: ATTIC, instruction: { type: 'doc-read', directory: WORK, name: PLAN } },
      ]);
      expect(opened).toEqual({
        ok: true,
        content: '# Plan\n\n- edited on the machine\n',
        updatedAt: WRITTEN_AT + 60_000,
      });
      // Somebody edited the file on the machine. The reply is the only evidence
      // this hub will ever get, so the index takes it.
      const row = await db().query('SELECT updated_at FROM docs WHERE node_id = ?', [made.nodeId]);
      expect(row.rows[0]).toEqual({ updated_at: WRITTEN_AT + 60_000 });
    });

    it('refuses in words naming the machine when it is not connected', async () => {
      answers = [written()];
      const feature = createDocs({
        database: db(),
        ids: { newId: () => `node-${String((minted += 1))}` },
        clock,
        // Connected for the create, away by the time somebody opens it.
        state: { snapshot: () => fleetAt('connected') },
        projects: projects({ project: WORK }),
        connections: {
          async ask(server: ServerRegistrationId, instruction: ServerInstruction) {
            asked.push({ server, instruction });
            const answer = answers.shift();
            if (answer === undefined) throw new Error('nothing queued');
            return answer;
          },
        },
        logger,
        onTreeChanged: () => {
          treeChanges += 1;
        },
      });
      const made = await feature.create(PROJECT, LOFT, PLAN, '# Plan\n');
      if (!made.ok) throw new Error('the create was refused');

      const away = docs();
      const opened = await away.open(made.nodeId);

      expect(opened.ok).toBe(false);
      if (opened.ok) return;
      expect(opened.code).toBe('refused');
      expect(opened.problem).toContain('loft');
      expect(opened.problem).toContain('the hub holds no copy');
    });
  });

  describe('list', () => {
    it('answers out of the index, asking no machine anything', async () => {
      answers = [written(), written(WRITTEN_AT + 1_000)];
      const feature = docs();
      await feature.create(PROJECT, ATTIC, PLAN, 'a');
      await feature.create(PROJECT, ATTIC, docNameSchema.parse('notes.txt'), 'b');
      asked = [];

      const listed = await feature.list(PROJECT);

      expect(asked).toEqual([]);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.docs.map((doc) => doc.name)).toEqual(['notes.txt', 'plan.md']);
      expect(listed.docs.every((doc) => doc.label === 'attic')).toBe(true);
    });

    it('lists a document whose machine is away, and says it is not reachable', async () => {
      answers = [written()];
      const feature = createDocs({
        database: db(),
        ids: { newId: () => `node-${String((minted += 1))}` },
        clock,
        state: { snapshot: () => fleetAt('connected') },
        projects: projects({ project: WORK }),
        connections: {
          async ask() {
            const answer = answers.shift();
            if (answer === undefined) throw new Error('nothing queued');
            return answer;
          },
        },
        logger,
        onTreeChanged: () => {
          treeChanges += 1;
        },
      });
      await feature.create(PROJECT, LOFT, PLAN, 'a');

      // The same rows read through a hub whose fleet says that machine is away.
      const listed = await docs().list(PROJECT);

      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      // The row is still there: an index the hub keeps is exactly what lets a
      // project's documents be seen while the machine holding them is off.
      expect(listed.docs).toHaveLength(1);
      expect(listed.docs[0]?.label).toBe('loft');
      expect(listed.docs[0]?.reachable).toBe(false);
    });

    it('refuses a node that is not a project', async () => {
      expect(await docs().list(nodeIdSchema.parse('folder-1'))).toEqual({
        ok: false,
        code: 'refused',
        problem: 'this hub has no project by that id',
      });
    });
  });
});

/** The fleet with the second machine in a chosen phase, as a snapshot. */
function fleetAt(phase: ServerConnectionPhase): HubStateSnapshot {
  return fleet(phase).snapshot();
}
