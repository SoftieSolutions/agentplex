import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SESSION_TASK_MAX_CHARS,
  sessionIdSchema,
  startIdSchema,
  storeIdSchema,
  type SessionRef,
} from '@agentplex/protocol';
import { createLogger } from '@agentplex/node-shared';
import { openMigratedSchema, type MigratedSchema } from '../db/test-migrated-schema.js';
import { createTasks } from './tasks.js';

/**
 * The task rows, against a real database.
 *
 * Over a migrated schema rather than a fake, for the reason the attention
 * suite is: what is worth asserting here is SQL -- that one session has one
 * task however many times it is started, and that the row the second start
 * finds is the one the first wrote. A fake that agreed with whatever it was
 * handed could not tell an upsert from an insert that does nothing.
 */

const logger = createLogger('error', () => {});

const WORK = storeIdSchema.parse('store-work');
const ATTIC = storeIdSchema.parse('store-attic');
const RESUMED = sessionIdSchema.parse('session-fix-auth');
const SPAWNED = sessionIdSchema.parse('session-migrate-db');
const START = startIdSchema.parse('start-1');

const A_PROMPT = 'fix the auth refresh loop and open a PR against main';

let migrated: MigratedSchema | null = null;
let announced: { ref: SessionRef; task: string | null }[] = [];

function db(): MigratedSchema['database'] {
  if (migrated === null) throw new Error('no database: beforeEach did not run');
  return migrated.database;
}

function feature(): ReturnType<typeof createTasks> {
  return createTasks({
    database: db(),
    logger,
    onChanged: (ref, task) => announced.push({ ref, task }),
  });
}

async function storedTasks(): Promise<readonly unknown[]> {
  const result = await db().query(
    'SELECT store_id, session_id, task FROM session_task ORDER BY session_id',
  );
  return result.rows;
}

describe('the task rows', () => {
  beforeEach(async () => {
    migrated = await openMigratedSchema('tasks-probe');
    announced = [];
  });

  afterEach(async () => {
    await migrated?.close();
    migrated = null;
  });

  it('records what a resumed session was started to do, under the session it named', async () => {
    await feature().noteStart({
      startId: START,
      storeId: WORK,
      sessionId: RESUMED,
      prompt: A_PROMPT,
    });

    expect(await storedTasks()).toEqual([{ store_id: WORK, session_id: RESUMED, task: A_PROMPT }]);
    expect(announced).toEqual([{ ref: { storeId: WORK, sessionId: RESUMED }, task: A_PROMPT }]);
  });

  it('holds a spawn until the provider names it, because a start is not a session', async () => {
    const tasks = feature();
    // A spawn: the provider mints the session id and writes it, so there is
    // nothing to file this under yet.
    await tasks.noteStart({ startId: START, storeId: WORK, sessionId: null, prompt: A_PROMPT });
    expect(await storedTasks()).toEqual([]);
    expect(announced).toEqual([]);

    // The next report carries the pair, which is the one moment the task has
    // somewhere to go.
    await tasks.noteStarts(WORK, [{ startId: START, sessionId: SPAWNED }]);
    expect(await storedTasks()).toEqual([{ store_id: WORK, session_id: SPAWNED, task: A_PROMPT }]);
    expect(announced).toEqual([{ ref: { storeId: WORK, sessionId: SPAWNED }, task: A_PROMPT }]);
  });

  it('says nothing about a start it is still waiting on', async () => {
    const tasks = feature();
    await tasks.noteStart({ startId: START, storeId: WORK, sessionId: null, prompt: A_PROMPT });
    // The tag a server sends until the provider has written an id: the hub is
    // told the start is running, and nothing more.
    await tasks.noteStarts(WORK, [{ startId: START, sessionId: null }]);
    expect(await storedTasks()).toEqual([]);
  });

  it('takes the naming before the prompt, which is the order a quick machine produces', async () => {
    // The race nothing decides: the instruction is answered on one socket and
    // the tag comes back on another, and a server that has already scanned
    // reports the pair while the hub is still returning from the answer. A
    // feature that only ever waited for the naming would lose the task of
    // every session started on a machine that scans quickly.
    const tasks = feature();
    await tasks.noteStarts(WORK, [{ startId: START, sessionId: SPAWNED }]);
    expect(await storedTasks()).toEqual([]);

    await tasks.noteStart({ startId: START, storeId: WORK, sessionId: null, prompt: A_PROMPT });
    expect(await storedTasks()).toEqual([{ store_id: WORK, session_id: SPAWNED, task: A_PROMPT }]);
    expect(announced).toEqual([{ ref: { storeId: WORK, sessionId: SPAWNED }, task: A_PROMPT }]);
  });

  it('refuses a naming that arrived first under a store the start was not for', async () => {
    const tasks = feature();
    await tasks.noteStarts(ATTIC, [{ startId: START, sessionId: SPAWNED }]);
    await tasks.noteStart({ startId: START, storeId: WORK, sessionId: null, prompt: A_PROMPT });
    expect(await storedTasks()).toEqual([]);
    expect(announced).toEqual([]);
  });

  it('writes nothing for a tag whose start carried no prompt', async () => {
    // A naming with nothing to attach to it. The hub keeps the pair in case a
    // prompt is still on its way, and a start made at the agent's own prompt
    // never sends one -- so no row appears, which is what "no task" is.
    const tasks = feature();
    await tasks.noteStarts(WORK, [{ startId: START, sessionId: SPAWNED }]);
    await tasks.noteStart({ startId: START, storeId: WORK, sessionId: null, prompt: null });
    expect(await storedTasks()).toEqual([]);
    expect(announced).toEqual([]);
  });

  it('refuses a tag reported under a store the start was not for', async () => {
    // The row a client sees is filed under the store the report was about, so
    // writing this one under either store would be a task the panel shows on a
    // session it is not about. A server disagreeing with the start it was sent
    // costs the label and nothing else.
    const tasks = feature();
    await tasks.noteStart({ startId: START, storeId: WORK, sessionId: null, prompt: A_PROMPT });
    await tasks.noteStarts(ATTIC, [{ startId: START, sessionId: SPAWNED }]);
    expect(await storedTasks()).toEqual([]);
    expect(announced).toEqual([]);
  });

  it('records nothing for a start made at the provider’s own prompt', async () => {
    // No task is the absence of a row. A session started with no prompt reads
    // exactly like one this hub never started, which is what it is.
    await feature().noteStart({ startId: START, storeId: WORK, sessionId: RESUMED, prompt: null });
    expect(await storedTasks()).toEqual([]);
    expect(announced).toEqual([]);
  });

  it('records nothing for a prompt that is only whitespace', async () => {
    await feature().noteStart({
      startId: START,
      storeId: WORK,
      sessionId: RESUMED,
      prompt: '   \n ',
    });
    expect(await storedTasks()).toEqual([]);
  });

  it('bounds what it keeps, because a prompt can be an essay', async () => {
    await feature().noteStart({
      startId: START,
      storeId: WORK,
      sessionId: RESUMED,
      prompt: 'x'.repeat(SESSION_TASK_MAX_CHARS + 500),
    });

    const [row] = await storedTasks();
    expect(row).toEqual({
      store_id: WORK,
      session_id: RESUMED,
      task: 'x'.repeat(SESSION_TASK_MAX_CHARS),
    });
    expect(announced[0]?.task).toHaveLength(SESSION_TASK_MAX_CHARS);
  });

  it('keeps the task a session was started with when it is started again', async () => {
    const tasks = feature();
    await tasks.noteStart({ startId: START, storeId: WORK, sessionId: RESUMED, prompt: A_PROMPT });
    announced = [];

    // A resume sends a new message to a conversation that is still doing what
    // it was started for. A label that changed every time somebody typed would
    // say the last thing asked under a heading claiming to say what the
    // session is for.
    await tasks.noteStart({
      startId: startIdSchema.parse('start-2'),
      storeId: WORK,
      sessionId: RESUMED,
      prompt: 'now write the release notes',
    });

    expect(await storedTasks()).toEqual([{ store_id: WORK, session_id: RESUMED, task: A_PROMPT }]);
    expect(announced).toEqual([]);
  });

  it('reads its rows back at boot and announces each one', async () => {
    const written = feature();
    await written.noteStart({
      startId: START,
      storeId: WORK,
      sessionId: RESUMED,
      prompt: A_PROMPT,
    });
    await written.noteStart({
      startId: startIdSchema.parse('start-2'),
      storeId: ATTIC,
      sessionId: SPAWNED,
      prompt: 'update the changelog',
    });

    // A second instance over the same file: the restart, which has to produce
    // the tasks the sessions were started with rather than a fleet of rows
    // that suddenly have no labels.
    announced = [];
    await feature().load();
    expect(
      [...announced].sort((left, right) => (left.ref.sessionId < right.ref.sessionId ? -1 : 1)),
    ).toEqual([
      { ref: { storeId: WORK, sessionId: RESUMED }, task: A_PROMPT },
      { ref: { storeId: ATTIC, sessionId: SPAWNED }, task: 'update the changelog' },
    ]);
  });

  it('lets one unreadable row cost itself rather than every task the hub holds', async () => {
    await feature().noteStart({
      startId: START,
      storeId: WORK,
      sessionId: RESUMED,
      prompt: A_PROMPT,
    });
    // A row nothing here wrote: an empty store id names no store, which is
    // what a hand-edited database looks like from up here.
    await db().query(
      `INSERT INTO session_task (store_id, session_id, task) VALUES ('', 'session-broken', 'x')`,
    );

    announced = [];
    await feature().load();
    expect(announced).toEqual([{ ref: { storeId: WORK, sessionId: RESUMED }, task: A_PROMPT }]);
  });

  it('says nothing at all about a session nobody started here', async () => {
    await feature().load();
    expect(announced).toEqual([]);
  });
});
