import { describe, expect, it } from 'vitest';
import { createLogger, type LogRecord } from '@agentplex/node-shared';
import {
  nodeIdSchema,
  sessionIdSchema,
  storeIdSchema,
  type NodeId,
  type SessionDescriptor,
  type StoreId,
} from '@agentplex/protocol';
import type { Database, Queryable, QueryResult } from '../db/database.js';
import { createFakeDatabase, type FakeDatabase } from '../db/fake-database.js';
import type { SessionProject } from '../fleet-state/fleet-state.js';
import { createFakeProjects, type FakeProjects } from '../projects/fake-projects.js';
import { createCatalogue, type Catalogue } from './catalogue.js';

/**
 * What `observe` is for, over a database that records how it was asked.
 *
 * The SQL is exercised against a real schema in `discovery.integration.test`
 * and `prune.integration.test`; what those cannot see is the part this ticket
 * added -- that a reading is written in one transaction, off the turn the
 * report arrived on, coalesced per store, and that a database that refuses
 * costs that store's tree update and nothing else.
 */

const NOW = 1_756_000_000_000;
const clock = { now: () => NOW };

const STORE_A = storeIdSchema.parse('store-a');
const STORE_B = storeIdSchema.parse('store-b');

function descriptor(
  storeId: StoreId,
  sessionId: string,
  title: string | null,
  cwd: string | null = null,
): SessionDescriptor {
  return {
    storeId,
    sessionId: sessionIdSchema.parse(sessionId),
    provider: 'claude',
    status: 'idle',
    updatedAt: NOW,
    cwd,
    branch: null,
    title,
    uncommitted: null,
  };
}

interface Harness {
  readonly catalogue: Catalogue;
  readonly projects: FakeProjects;
  readonly database: FakeDatabase;
  readonly logs: readonly LogRecord[];
  /** What each store currently reads as, which a test changes between passes. */
  readonly stores: Map<StoreId, readonly SessionDescriptor[] | null>;
}

function harness(
  options: {
    readonly failOn?: RegExp;
    readonly nodes?: readonly unknown[];
    /**
     * What the tree is told when it asks where a directory is, in place of the
     * fake's own answer. The rest of the fake stays whole: its methods are
     * closures, so one of them is borrowed rather than the fake copied.
     */
    readonly findByDirectories?: (
      directories: readonly string[],
    ) => Promise<ReadonlyMap<string, NodeId>>;
    /**
     * The database the catalogue is handed, made from the recording fake. The
     * fake is still what the harness returns, so every statement is counted
     * whatever the wrapper does with it.
     */
    readonly wrap?: (database: FakeDatabase) => Database;
  } = {},
): Harness {
  const database = createFakeDatabase({
    ...(options.failOn === undefined ? {} : { failOn: options.failOn }),
    // The rows a read of the whole tree comes back with. Scripted rather than
    // written by a migrated schema, for the reason the rest of this file is a
    // fake: what it is about is when the tree is read and what is done with the
    // answer, and the statement itself is `reads.test`'s subject.
    ...(options.nodes === undefined
      ? {}
      : { respondWith: [{ match: /FROM nodes/, rows: options.nodes }] }),
  });
  const logs: LogRecord[] = [];
  const stores = new Map<StoreId, readonly SessionDescriptor[] | null>();
  // Where the directories are, driven by hand. The placement itself is written
  // against a real schema in `discovery.integration.test`; what this file can
  // see that that one cannot is when the question gets asked.
  const projects = createFakeProjects();
  const catalogue = createCatalogue({
    database: options.wrap === undefined ? database : options.wrap(database),
    ids: { newId: () => 'node-1' },
    clock,
    logger: createLogger('debug', (record) => logs.push(record)),
    readStore: (storeId) => stores.get(storeId) ?? null,
    // Nothing in this file queries, and a query is the only reader of this.
    // An empty fleet rather than no seam at all: a dependency this file does
    // not exercise still has to be a real one, or the suite would be standing
    // on a shape the hub does not build.
    readFleet: () => ({
      version: 0,
      stores: [],
      servers: [],
      candidates: [],
      graphRunApprovals: [],
    }),
    projects:
      options.findByDirectories === undefined
        ? projects
        : {
            directories: () => projects.directories(),
            findByDirectories: options.findByDirectories,
          },
    // Nothing in this file removes a node, and a holder is only ever read to
    // refuse one. `mutations.test` is where that question is asked.
    readHolder: () => null,
  });
  return { catalogue, projects, database, logs, stores };
}

/** The transactions a run opened, in order, with the statements each held. */
function transactions(database: FakeDatabase): Map<number, string[]> {
  const grouped = new Map<number, string[]>();
  for (const statement of database.issued) {
    if (statement.transaction === null) continue;
    const held = grouped.get(statement.transaction) ?? [];
    held.push(statement.text);
    grouped.set(statement.transaction, held);
  }
  return grouped;
}

/**
 * The fake with the values of every statement matching `match` kept, inside a
 * transaction or out. The fake records the text of a statement and not what
 * was bound to it, and where a session was filed is a bound value.
 */
function recordingValues(match: RegExp): {
  readonly wrap: (database: FakeDatabase) => Database;
  readonly bound: readonly (readonly unknown[])[];
} {
  const bound: (readonly unknown[])[] = [];
  const recording = (queryable: Queryable): Queryable => ({
    query: <Row>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> => {
      if (match.test(text)) bound.push(values ?? []);
      return queryable.query<Row>(text, values);
    },
  });
  return {
    wrap: (database) => ({
      ...recording(database),
      transaction: (body) => database.transaction((tx) => body(recording(tx))),
      close: () => database.close(),
    }),
    bound,
  };
}

/** The statement a whole reading of the tree issues, and nothing else does. */
const LIST_NODES = /FROM nodes ORDER BY/;

function listNodesReads(database: FakeDatabase): number {
  return database.statements.filter((text) => LIST_NODES.test(text)).length;
}

/**
 * The fake with every whole reading of the tree held until a test lets it go,
 * answering with the rows it is let go with. The statement is still issued to
 * the fake when the read starts, so a count of them is a count of reads begun
 * rather than of reads finished.
 */
function holdingReads(): {
  readonly wrap: (database: FakeDatabase) => Database;
  /** Lets the oldest held read finish with these rows. */
  release(rows: readonly unknown[]): void;
  readonly held: number;
} {
  const waiting: ((rows: readonly unknown[]) => void)[] = [];
  return {
    wrap: (database) => ({
      query: async <Row>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>> => {
        const issued = database.query<Row>(text, values);
        if (!LIST_NODES.test(text)) return issued;
        await issued;
        const rows = await new Promise<readonly unknown[]>((resolve) => waiting.push(resolve));
        return { rows: rows as Row[], rowCount: rows.length };
      },
      transaction: (body) => database.transaction(body),
      close: () => database.close(),
    }),
    release(rows: readonly unknown[]): void {
      const next = waiting.shift();
      if (next === undefined) throw new Error('no read is being held');
      next(rows);
    },
    get held(): number {
      return waiting.length;
    },
  };
}

/** Lets every promise already queued run, and whatever those queue in turn. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('the catalogue following what a store was read to hold', () => {
  it('places and sweeps one reading in a single transaction', async () => {
    const test = harness();
    test.stores.set(STORE_A, [descriptor(STORE_A, 's1', 'fixing the parser')]);

    await test.catalogue.observe(STORE_A);

    const opened = transactions(test.database);
    expect(opened.size).toBe(1);
    const statements = [...opened.values()][0] ?? [];
    // Every statement of both halves, and nothing outside the transaction: a
    // tree with the placements committed and the sweep not agrees with no
    // reading that ever happened.
    expect(statements.some((text) => text.includes('INSERT INTO nodes'))).toBe(true);
    expect(statements.some((text) => text.includes('DELETE FROM nodes'))).toBe(true);
    expect(statements.some((text) => text.includes('DELETE FROM node_removals'))).toBe(true);
    expect(test.database.issued.every((statement) => statement.transaction !== null)).toBe(true);
  });

  /**
   * The lookup is the tree's question and the transaction is the tree's write,
   * and they are deliberately not the same moment.
   *
   * Asking inside the transaction would mean another feature's statements
   * running on a handle it was never given -- one connection, so they would
   * land inside this `BEGIN` -- and that is a second owner of one transaction
   * rather than a seam. The window it opens is argued where it is opened.
   */
  it('asks where a directory is before it opens the transaction it writes in', async () => {
    const test = harness();
    test.stores.set(STORE_A, [
      descriptor(STORE_A, 's1', 'in a checkout', '/srv/work/agentplex'),
      // A provider that records no working directory. There is nothing to ask
      // about, and guessing the store's own path would file sessions under a
      // project nobody started them in.
      descriptor(STORE_A, 's2', 'nowhere in particular'),
    ]);

    await test.catalogue.observe(STORE_A);

    expect(test.projects.looked).toEqual([['/srv/work/agentplex']]);
    // The write is still one transaction, and the lookup was not in it: the
    // fake projects hold no database, so nothing it did could be.
    expect(transactions(test.database).size).toBe(1);
  });

  /**
   * One question per pass, whatever the reading holds: a report of twenty
   * sessions asked twenty times was twenty round trips to place what one read
   * of a few project rows answers.
   */
  it('asks once where every session in a reading is, however many it holds', async () => {
    const PROJECT = nodeIdSchema.parse('node-project');
    const inserts = recordingValues(/INSERT INTO nodes/);
    const test = harness({ wrap: inserts.wrap });
    test.projects.hold(PROJECT, '/srv/work/agentplex');
    const sessions = Array.from({ length: 20 }, (_, index) =>
      descriptor(
        STORE_A,
        `s${String(index)}`,
        null,
        // Half in the project, one of those spelled with a trailing slash, and
        // half somewhere no project is.
        index % 2 === 0
          ? index === 0
            ? '/srv/work/agentplex/'
            : '/srv/work/agentplex'
          : `/srv/elsewhere/${String(index)}`,
      ),
    );
    test.stores.set(STORE_A, sessions);

    await test.catalogue.observe(STORE_A);

    expect(test.projects.looked).toHaveLength(1);
    expect(test.projects.looked[0]).toHaveLength(20);
    // Filed as a lookup per session filed them: a session whose directory is
    // the project's goes under it, and every other one at the root. The parent
    // is the second value bound and the session the sixth.
    const parents = new Map(inserts.bound.map((values) => [String(values[5]), values[1] ?? null]));
    expect(parents.size).toBe(20);
    for (const [index, session] of sessions.entries()) {
      expect(parents.get(session.sessionId)).toBe(index % 2 === 0 ? PROJECT : null);
    }
  });

  it('asks nothing for a reading in which no session said where it ran', async () => {
    const test = harness();
    test.stores.set(STORE_A, [descriptor(STORE_A, 's1', null), descriptor(STORE_A, 's2', null)]);

    await test.catalogue.observe(STORE_A);

    expect(test.projects.looked).toEqual([]);
  });

  it('sweeps against the sessions the reading named', async () => {
    const test = harness();
    test.stores.set(STORE_A, [descriptor(STORE_A, 's1', null), descriptor(STORE_A, 's2', null)]);

    await test.catalogue.observe(STORE_A);

    const sweep = test.database.statements.find((text) => text.includes('DELETE FROM nodes'));
    expect(sweep).toContain('anchor_session_id NOT IN (?, ?)');
  });

  it('issues no statement on the turn the report arrived on', async () => {
    const test = harness();
    test.stores.set(STORE_A, [descriptor(STORE_A, 's1', null)]);

    const caughtUp = test.catalogue.observe(STORE_A);
    // The report was answered by the fleet state and the broadcast on the turn
    // it arrived; the tree write is what happens after that.
    expect(test.database.statements).toEqual([]);

    await caughtUp;
    expect(test.database.statements.length).toBeGreaterThan(0);
  });

  it('coalesces repeated readings of one store into one pass', async () => {
    const test = harness();
    test.stores.set(STORE_A, [descriptor(STORE_A, 's1', null)]);

    // Three reports before the writer got a turn: two servers with the volume
    // mounted and one of them reporting twice. A queue would spend three
    // transactions arriving at what the third says.
    const caughtUp = test.catalogue.observe(STORE_A);
    void test.catalogue.observe(STORE_A);
    void test.catalogue.observe(STORE_A);
    await caughtUp;

    expect(transactions(test.database).size).toBe(1);
  });

  it('writes the reading as it is when the write runs, not as it was when told', async () => {
    const test = harness();
    test.stores.set(STORE_A, [descriptor(STORE_A, 's1', null)]);
    const caughtUp = test.catalogue.observe(STORE_A);
    // A second report lands in the same turn, naming one more session. The
    // freshest reading is the only one worth writing.
    test.stores.set(STORE_A, [descriptor(STORE_A, 's1', null), descriptor(STORE_A, 's2', null)]);
    void test.catalogue.observe(STORE_A);
    await caughtUp;

    const sweep = test.database.statements.find((text) => text.includes('DELETE FROM nodes'));
    expect(sweep).toContain('anchor_session_id NOT IN (?, ?)');
  });

  it('starts a new pass for a store reported after the last one finished', async () => {
    const test = harness();
    test.stores.set(STORE_A, [descriptor(STORE_A, 's1', null)]);

    // Coalescing is between a report and the write it is still waiting for, not
    // a memory of stores already done: a store that reports again gets another
    // pass, or the tree would stop following it after the first one.
    await test.catalogue.observe(STORE_A);
    await test.catalogue.observe(STORE_A);

    expect(transactions(test.database).size).toBe(2);
  });

  it('gives each store its own transaction', async () => {
    const test = harness();
    test.stores.set(STORE_A, [descriptor(STORE_A, 's1', null)]);
    test.stores.set(STORE_B, [descriptor(STORE_B, 's2', null)]);

    void test.catalogue.observe(STORE_A);
    await test.catalogue.observe(STORE_B);

    expect(transactions(test.database).size).toBe(2);
  });

  it('leaves the tree alone for a store the hub no longer knows', async () => {
    const test = harness();

    // The store went away between the report and this turn: its last server was
    // revoked, or unmounted the volume. There is no reading, so there is
    // nothing to sweep against -- and an empty list would take every node.
    await test.catalogue.observe(STORE_A);

    expect(test.database.statements).toEqual([]);
  });

  it('costs a refusing database that store and nothing else', async () => {
    const test = harness({ failOn: /INSERT INTO nodes/ });
    test.stores.set(STORE_A, [descriptor(STORE_A, 's1', null)]);
    // Reached and holding nothing, which is a fact a server can establish: the
    // sweep still runs for it, and it places nothing, so the refusal above
    // cannot reach it.
    test.stores.set(STORE_B, []);

    void test.catalogue.observe(STORE_A);
    // Resolves rather than rejecting: nothing on the report's path may be
    // unwound by a tree write, and the store that follows still gets its turn.
    await expect(test.catalogue.observe(STORE_B)).resolves.toBeUndefined();

    expect(
      test.logs.some(
        (record) =>
          record.level === 'warn' &&
          record.message.includes('could not be brought into line') &&
          record.fields.storeId === STORE_A,
      ),
    ).toBe(true);
    const opened = [...transactions(test.database).values()];
    expect(opened).toHaveLength(2);
    expect(opened[1]?.some((text) => text.includes('DELETE FROM nodes'))).toBe(true);
  });

  /**
   * The lookup runs before the transaction and outside it, so a refusal there
   * is not the transaction's to catch. It is the same bargain all the same: a
   * store's tree update lost until its next report, and never the report path
   * unwound or the pass left standing with nobody to finish it.
   */
  it('costs a failed project lookup that store and nothing else', async () => {
    let asked = 0;
    const test = harness({
      findByDirectories: async () => {
        asked += 1;
        if (asked === 1) throw new Error('the projects could not be read');
        return new Map();
      },
    });
    test.stores.set(STORE_A, [descriptor(STORE_A, 's1', null, '/srv/work/agentplex')]);

    await expect(test.catalogue.observe(STORE_A)).resolves.toBeUndefined();

    expect(
      test.logs.some(
        (record) =>
          record.level === 'warn' &&
          record.message.includes('could not be brought into line') &&
          record.fields.storeId === STORE_A,
      ),
    ).toBe(true);
    expect(transactions(test.database).size).toBe(0);
  });

  it('starts a new pass for a store reported after a lookup failed', async () => {
    let asked = 0;
    const test = harness({
      findByDirectories: async () => {
        asked += 1;
        if (asked === 1) throw new Error('the projects could not be read');
        return new Map();
      },
    });
    test.stores.set(STORE_A, [descriptor(STORE_A, 's1', null, '/srv/work/agentplex')]);

    // A pass that failed and left itself standing would have every later
    // report attach to it and wait on a promise that already settled, and the
    // tree would stop following every store for the life of the hub. Whether
    // the first pass resolves is the test above's question, not this one's.
    await test.catalogue.observe(STORE_A).catch(() => undefined);
    await test.catalogue.observe(STORE_A);

    expect(asked).toBe(2);
    expect(transactions(test.database).size).toBe(1);
  });
});

describe('the catalogue saying which project each session is in', () => {
  const PROJECT_NODE = {
    id: 'node-universe',
    parent_id: null,
    kind: 'project',
    position: 0,
    name: 'universe',
    name_source: 'user',
    anchor_store_id: null,
    anchor_session_id: null,
    created_at: NOW,
  };
  const SESSION_NODE = {
    id: 'node-bench',
    parent_id: 'node-universe',
    kind: 'session',
    position: 0,
    name: null,
    name_source: 'discovered',
    anchor_store_id: 'store-a',
    anchor_session_id: 'session-bench',
    created_at: NOW,
  };

  it('reads the tree and answers where it puts each session', async () => {
    const test = harness({ nodes: [PROJECT_NODE, SESSION_NODE] });

    const reading = await test.catalogue.sessionProjects();

    expect([...reading.placements.values()]).toEqual([
      { nodeId: 'node-universe', name: 'universe' },
    ]);
  });

  it('carries the version the tree was at when the read began, not when it ended', async () => {
    const test = harness({ nodes: [PROJECT_NODE, SESSION_NODE] });
    test.catalogue.changed();

    // The change lands while the read is in flight, which is the case the
    // number is for: a reading labelled with the version it finished at would
    // claim to hold a change it read the tree before.
    const reading = test.catalogue.sessionProjects();
    test.catalogue.changed();

    expect((await reading).version).toBe(1);
    expect((await test.catalogue.sessionProjects()).version).toBe(2);
  });
});

describe('the catalogue handing on where it puts sessions as the tree changes', () => {
  const PROJECT_NODE = {
    id: 'node-universe',
    parent_id: null,
    kind: 'project',
    position: 0,
    name: 'universe',
    name_source: 'user',
    anchor_store_id: null,
    anchor_session_id: null,
    created_at: NOW,
  };
  const SESSION_NODE = {
    id: 'node-bench',
    parent_id: 'node-universe',
    kind: 'session',
    position: 0,
    name: null,
    name_source: 'discovered',
    anchor_store_id: 'store-a',
    anchor_session_id: 'session-bench',
    created_at: NOW,
  };

  /**
   * The read a hub needs after a restart. The tree is already on disk, so the
   * first pass of every store creates nothing and changes nothing -- and a
   * follower that waited for a change would leave every session in no project
   * until somebody moved something.
   */
  it('reads once as it starts following, with no change to prompt it', async () => {
    const test = harness({ nodes: [PROJECT_NODE, SESSION_NODE] });
    const heard: ReadonlyMap<string, SessionProject>[] = [];

    test.catalogue.followSessionProjects((placements) => heard.push(placements));
    await settle();

    expect(listNodesReads(test.database)).toBe(1);
    expect(heard).toEqual([(await test.catalogue.sessionProjects()).placements]);
  });

  it('reads once for a burst of changes in one turn', async () => {
    const test = harness({ nodes: [PROJECT_NODE, SESSION_NODE] });
    const heard: ReadonlyMap<string, SessionProject>[] = [];
    test.catalogue.followSessionProjects((placements) => heard.push(placements));
    await settle();

    // Five writers on one turn: a pass bumping per store, a rename, a move. A
    // read per bump is five whole reads of the tree to arrive at what the last
    // one says.
    for (let bump = 0; bump < 5; bump += 1) test.catalogue.changed();
    await settle();

    expect(listNodesReads(test.database)).toBe(2);
    expect(heard).toHaveLength(2);
  });

  /**
   * Changes that land while a read is out are one more read after it and not
   * one each, and that read starts only once the first has answered: two in
   * flight could settle in either order, and the older one landing last would
   * publish a tree from before the change.
   */
  it('reads once more for changes made while a read was out, and hands on the newest', async () => {
    const reads = holdingReads();
    const test = harness({ wrap: reads.wrap });
    const heard: ReadonlyMap<string, SessionProject>[] = [];
    test.catalogue.followSessionProjects((placements) => heard.push(placements));
    await settle();
    expect(reads.held).toBe(1);

    for (let bump = 0; bump < 5; bump += 1) test.catalogue.changed();
    await settle();
    // Still one out: the changes wait for it rather than racing it.
    expect(listNodesReads(test.database)).toBe(1);

    reads.release([PROJECT_NODE, SESSION_NODE]);
    await settle();
    expect(listNodesReads(test.database)).toBe(2);

    reads.release([{ ...PROJECT_NODE, name: 'renamed' }, SESSION_NODE]);
    await settle();

    expect(listNodesReads(test.database)).toBe(2);
    expect(heard.map((placements) => [...placements.values()])).toEqual([
      [{ nodeId: 'node-universe', name: 'universe' }],
      [{ nodeId: 'node-universe', name: 'renamed' }],
    ]);
  });

  it('logs a read that failed, and reads again on the next change', async () => {
    const test = harness({ failOn: LIST_NODES });
    const heard: ReadonlyMap<string, SessionProject>[] = [];
    test.catalogue.followSessionProjects((placements) => heard.push(placements));
    await settle();

    expect(heard).toEqual([]);
    expect(
      test.logs.some(
        (record) =>
          record.level === 'warn' &&
          record.message === 'the tree could not be read for the projects its sessions are in',
      ),
    ).toBe(true);

    test.catalogue.changed();
    await settle();
    expect(listNodesReads(test.database)).toBe(2);
  });

  it('reads nothing more once it has been stopped', async () => {
    const test = harness({ nodes: [PROJECT_NODE, SESSION_NODE] });
    const heard: ReadonlyMap<string, SessionProject>[] = [];
    const stop = test.catalogue.followSessionProjects((placements) => heard.push(placements));
    await settle();

    stop();
    test.catalogue.changed();
    await settle();

    expect(listNodesReads(test.database)).toBe(1);
    expect(heard).toHaveLength(1);
  });
});
