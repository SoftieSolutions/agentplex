import { describe, expect, it } from 'vitest';
import { createLogger, type LogRecord } from '@agentplex/node-shared';
import {
  sessionIdSchema,
  storeIdSchema,
  type SessionDescriptor,
  type StoreId,
} from '@agentplex/protocol';
import { createFakeDatabase, type FakeDatabase } from '../../db/fake-database.js';
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

function harness(options: { readonly failOn?: RegExp } = {}): Harness {
  const database = createFakeDatabase(
    options.failOn === undefined ? {} : { failOn: options.failOn },
  );
  const logs: LogRecord[] = [];
  const stores = new Map<StoreId, readonly SessionDescriptor[] | null>();
  // Where the directories are, driven by hand. The placement itself is written
  // against a real schema in `discovery.integration.test`; what this file can
  // see that that one cannot is when the question gets asked.
  const projects = createFakeProjects();
  const catalogue = createCatalogue({
    database,
    ids: { newId: () => 'node-1' },
    clock,
    logger: createLogger('debug', (record) => logs.push(record)),
    readStore: (storeId) => stores.get(storeId) ?? null,
    projects,
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

    expect(test.projects.looked).toEqual(['/srv/work/agentplex']);
    // The write is still one transaction, and the lookup was not in it: the
    // fake projects hold no database, so nothing it did could be.
    expect(transactions(test.database).size).toBe(1);
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
});
