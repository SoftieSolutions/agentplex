import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionRefSchema, storeDescriptorSchema } from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import { CODEX_SESSIONS_DIRECTORY, createCodexAdapter } from './codex-adapter.js';
import { CODEX_HOME, CODEX_SCRUB_PREFIXES } from './codex-launch.js';
import { CODEX_SESSION_INDEX_FILE } from './codex-session-index.js';
import { createFakeProviderFiles } from './fake-provider-files.js';

/** Captured codex output; see the note in `codex-rollout.test.ts`. */
function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, '..', 'fixtures', name), 'utf8');
}

const COMPLETED_TURN = fixture('codex-completed-turn.jsonl');
const PENDING_TOOL_CALL = fixture('codex-pending-tool-call.jsonl');
const ABORTED_TURN = fixture('codex-aborted-turn.jsonl');
const NO_TURNS = fixture('codex-no-turns.jsonl');
const SESSION_INDEX = fixture('codex-session-index.jsonl');

const STORE = storeDescriptorSchema.parse({ storeId: 'store-a', path: '/volumes/codex' });
const CWD = '/Users/dev/Code/agentplex';

/**
 * codex's real directory layout for a rollout, date-partitioned three deep.
 *
 * The file name is here to be half-ignored. `rollout-<ISO-ish timestamp>-<uuid>`
 * spells its timestamp with the same `-` the uuid uses, so the id this adapter
 * reports comes out of the `session_meta` line inside the file, exactly as the
 * Claude adapter takes its cwd out of a transcript rather than out of a lossy
 * directory name.
 */
const SESSIONS = `${STORE.path}/${CODEX_SESSIONS_DIRECTORY}`;

const COMPLETED_ID = '01a09386-f378-7b23-83a7-6c263ed59701';
const PENDING_ID = '01a0937a-0b76-7a90-9ed6-bc31683a0d5a';
const ABORTED_ID = '01a09386-3e58-7072-a070-f99140d2ac91';

const COMPLETED_PATH = `${SESSIONS}/2026/09/11/rollout-2026-09-11T23-51-30-${COMPLETED_ID}.jsonl`;
const PENDING_PATH = `${SESSIONS}/2026/09/11/rollout-2026-09-11T23-37-24-${PENDING_ID}.jsonl`;
const ABORTED_PATH = `${SESSIONS}/2026/09/11/rollout-2026-09-11T23-50-43-${ABORTED_ID}.jsonl`;

function adapterOver(files: Parameters<typeof createFakeProviderFiles>[0]) {
  return createCodexAdapter({ files: createFakeProviderFiles(files) });
}

describe('createCodexAdapter.discover', () => {
  it('finds a session per rollout, dated, located and named by the store itself', async () => {
    const adapter = adapterOver({
      files: {
        [COMPLETED_PATH]: COMPLETED_TURN,
        [`${STORE.path}/${CODEX_SESSION_INDEX_FILE}`]: SESSION_INDEX,
      },
    });

    const discovered = await adapter.discover(STORE);

    expect(discovered.problems).toEqual([]);
    expect(discovered.sessions).toEqual([
      {
        sessionId: COMPLETED_ID,
        signal: 'awaiting-input',
        updatedAt: Date.parse('2026-09-12T02:51:35.024Z'),
        running: false,
        cwd: CWD,
        title: 'Reply with pineapple',
      },
    ]);
  });

  it('walks the date partitions codex files its rollouts under', async () => {
    // `sessions/<year>/<month>/<day>/` is three directories deep, where a
    // Claude Code store is one. Nothing above the seam learns that: a caller
    // hands over a `StoreDescriptor` and the layout inside it is this file's.
    const adapter = adapterOver({
      files: {
        [`${SESSIONS}/2025/12/31/rollout-2025-12-31T00-00-00-${COMPLETED_ID}.jsonl`]:
          COMPLETED_TURN,
      },
    });

    const discovered = await adapter.discover(STORE);

    expect(discovered.sessions.map((session) => session.sessionId)).toEqual([COMPLETED_ID]);
  });

  it('reports a session with no name rather than dropping it', async () => {
    // codex names a session in `session_index.jsonl` once it has learned one,
    // and the file is absent entirely in a store where it never has.
    const adapter = adapterOver({ files: { [ABORTED_PATH]: ABORTED_TURN } });

    const discovered = await adapter.discover(STORE);

    expect(discovered.problems).toEqual([]);
    expect(discovered.sessions).toMatchObject([{ sessionId: ABORTED_ID, title: null }]);
  });

  it('never claims a session is running, because codex gives it no way to know', async () => {
    // The one place this adapter is poorer than the Claude one, and it is a
    // fact about codex rather than a shortcut. Claude Code keeps a per-process
    // registry naming a pid and a start time, which is what makes `running`
    // provable from a store alone. codex 0.154.0 keeps nothing of the kind:
    // the only per-session file beside a rollout is a zero-byte advisory lock
    // under `thread-writer-locks/`, with no pid, no start time and no status,
    // and it stays behind after the process that took it dies. Reading it
    // would be a claim nothing backs, so this adapter makes none and the
    // caller's own liveness carries the whole answer.
    const adapter = adapterOver({ files: { [PENDING_PATH]: PENDING_TOOL_CALL } });

    const discovered = await adapter.discover(STORE);

    expect(discovered.sessions).toMatchObject([{ sessionId: PENDING_ID, running: false }]);
  });

  it('reports nothing and complains about nothing in a store codex has not touched', async () => {
    const discovered = await adapterOver({ files: {} }).discover(STORE);

    expect(discovered).toEqual({ sessions: [], problems: [] });
  });

  it('says so when the sessions directory is there and cannot be listed', async () => {
    const adapter = adapterOver({ directories: [SESSIONS], unreadable: [SESSIONS] });

    const discovered = await adapter.discover(STORE);

    expect(discovered.sessions).toEqual([]);
    expect(discovered.problems).toEqual([{ subject: SESSIONS, problem: `EACCES: ${SESSIONS}` }]);
  });

  it('lets one unreadable rollout cost itself and not the listing', async () => {
    const adapter = adapterOver({
      files: { [COMPLETED_PATH]: COMPLETED_TURN, [PENDING_PATH]: PENDING_TOOL_CALL },
      unreadable: [PENDING_PATH],
    });

    const discovered = await adapter.discover(STORE);

    expect(discovered.sessions.map((session) => session.sessionId)).toEqual([COMPLETED_ID]);
    expect(discovered.problems).toEqual([
      { subject: PENDING_PATH, problem: `cannot read rollout: EACCES: ${PENDING_PATH}` },
    ]);
  });

  it('passes over a rollout with no turn in it without calling it a fault', async () => {
    // codex writes `session_meta` the moment a session opens, before the first
    // turn exists. A store caught mid-open is not a store with a problem.
    const adapter = adapterOver({
      files: { [`${SESSIONS}/2026/09/11/rollout-x-y.jsonl`]: NO_TURNS },
    });

    const discovered = await adapter.discover(STORE);

    expect(discovered).toEqual({ sessions: [], problems: [] });
  });

  it('complains about a rollout that parsed and names no session', async () => {
    // The id is the provider's own statement, and there is no second place to
    // get it from: the file name spells a timestamp with the same separator
    // the uuid uses. A guess would file a session under an id that nothing
    // resumes.
    const nameless = [
      '{"timestamp":"2026-09-12T03:00:01.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t-1"}}',
      '{"timestamp":"2026-09-12T03:00:03.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t-1"}}',
    ].join('\n');
    const path = `${SESSIONS}/2026/09/11/rollout-2026-09-11T23-00-00-nameless.jsonl`;

    const discovered = await adapterOver({ files: { [path]: nameless } }).discover(STORE);

    expect(discovered.sessions).toEqual([]);
    expect(discovered.problems).toEqual([
      { subject: path, problem: 'the rollout does not say which session it is' },
    ]);
  });

  it('complains about a rollout that is there and is not readable as one', async () => {
    const path = `${SESSIONS}/2026/09/11/rollout-2026-09-11T23-00-00-broken.jsonl`;

    const discovered = await adapterOver({ files: { [path]: 'not json at all\n' } }).discover(
      STORE,
    );

    expect(discovered.problems).toEqual([
      { subject: path, problem: 'cannot read rollout: none of 1 lines is JSON' },
    ]);
  });

  it('ignores a file under the partitions that is not a rollout', async () => {
    const adapter = adapterOver({
      files: {
        [COMPLETED_PATH]: COMPLETED_TURN,
        [`${SESSIONS}/2026/09/11/.DS_Store`]: 'junk',
      },
    });

    const discovered = await adapter.discover(STORE);

    expect(discovered.problems).toEqual([]);
    expect(discovered.sessions).toHaveLength(1);
  });
});

describe('createCodexAdapter.spawn', () => {
  it('starts codex in the store it was asked about, with the prompt as one argument', () => {
    const adapter = adapterOver({ files: {} });

    const launch = adapter.spawn({ store: STORE, cwd: CWD, prompt: 'look at the failing test' });

    expect(launch).toEqual({
      ok: true,
      plan: {
        command: 'codex',
        // One element. A prompt is user content and never an option, and no
        // shell ever sees it.
        args: ['look at the failing test'],
        cwd: CWD,
        env: { [CODEX_HOME]: STORE.path },
        scrubEnvPrefixes: CODEX_SCRUB_PREFIXES,
      },
    });
  });

  it('leaves codex at its own prompt when there is nothing to open with', () => {
    const launch = adapterOver({ files: {} }).spawn({ store: STORE, cwd: CWD, prompt: null });

    expect(launch).toMatchObject({ ok: true, plan: { args: [] } });
  });

  it('names no session id, because codex mints its own', () => {
    const launch = adapterOver({ files: {} }).spawn({ store: STORE, cwd: CWD, prompt: null });

    expect(launch.ok && launch.plan.args).toEqual([]);
  });

  it('refuses to start a session inside the store it would be writing about', () => {
    const launch = adapterOver({ files: {} }).spawn({
      store: STORE,
      cwd: `${STORE.path}/sessions`,
      prompt: null,
    });

    expect(launch).toMatchObject({ ok: false });
  });
});

describe('createCodexAdapter.resume', () => {
  it('reattaches to the session by the id codex knows it by', () => {
    // `codex resume <id>`, confirmed against codex-cli 0.154.0: it reopens the
    // same session and goes on appending to the same rollout. Not `fork`,
    // which is the flag family that gives the continued work a new id and
    // leaves the client watching a file nobody writes to any more.
    const launch = adapterOver({ files: {} }).resume({
      store: STORE,
      session: sessionRefSchema.parse({ storeId: STORE.storeId, sessionId: COMPLETED_ID }),
      cwd: CWD,
    });

    expect(launch).toEqual({
      ok: true,
      plan: {
        command: 'codex',
        args: ['resume', COMPLETED_ID],
        cwd: CWD,
        env: { [CODEX_HOME]: STORE.path },
        scrubEnvPrefixes: CODEX_SCRUB_PREFIXES,
      },
    });
  });

  it('refuses a session codex never recorded a directory for', () => {
    const launch = adapterOver({ files: {} }).resume({
      store: STORE,
      session: sessionRefSchema.parse({ storeId: STORE.storeId, sessionId: COMPLETED_ID }),
      cwd: null,
    });

    expect(launch).toMatchObject({ ok: false });
  });
});

describe('createCodexAdapter.status', () => {
  const now = Date.parse('2026-09-12T03:00:00.000Z');
  const updatedAt = Date.parse('2026-09-12T02:51:35.024Z');

  it('is working only while something says a process is alive', () => {
    const adapter = adapterOver({ files: {} });

    expect(adapter.status({ signal: 'progressing', updatedAt, running: true, now })).toBe(
      'working',
    );
    expect(adapter.status({ signal: 'progressing', updatedAt, running: false, now })).toBe('idle');
  });

  it('is idle for a turn nobody interrupted and nobody is running', () => {
    const adapter = adapterOver({ files: {} });

    expect(adapter.status({ signal: 'quiet', updatedAt, running: false, now })).toBe('idle');
  });

  it('passes a turn that ended straight through as awaiting input', () => {
    const adapter = adapterOver({ files: {} });

    expect(adapter.status({ signal: 'awaiting-input', updatedAt, running: true, now })).toBe(
      'awaiting-input',
    );
  });
});

describe('createCodexAdapter', () => {
  it('answers to the name the protocol already has for it', () => {
    expect(adapterOver({ files: {} }).provider).toBe('codex');
  });

  it('offers the directory codex uses when nothing tells it otherwise', () => {
    expect(adapterOver({ files: {} }).defaultStoreDirectory).toBe('.codex');
  });
});
