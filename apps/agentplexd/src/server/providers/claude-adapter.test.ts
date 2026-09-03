import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionRefSchema, storeDescriptorSchema } from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import { CLAUDE_PROJECTS_DIRECTORY, createClaudeAdapter } from './claude-adapter.js';
import { createFakeProviderFiles } from './fake-provider-files.js';

/** Captured Claude Code output; see the note in `claude-transcript.test.ts`. */
function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
}

const COMPLETED_TURN = fixture('claude-completed-turn.jsonl');
const NO_TURNS = fixture('claude-no-turns.jsonl');

const STORE = storeDescriptorSchema.parse({ storeId: 'store-a', path: '/volumes/claude' });
const PROJECTS = `${STORE.path}/${CLAUDE_PROJECTS_DIRECTORY}`;

/**
 * Claude Code's real directory name for `/Users/dev/Code/agentplex`.
 *
 * It is here to be ignored. The encoding flattens `/` and `.` onto the same
 * character — `~/Code/x/.claude/y` becomes `-Users-...-Code-x--claude-y` — so
 * it cannot be decoded back into a path without guessing. The cwd this adapter
 * reports comes out of the transcript, which records it verbatim.
 */
const PROJECT = `${PROJECTS}/-Users-dev-Code-agentplex`;

const SESSION_ID = '10e6c58c-3fc6-4519-8bb4-1c3f7eef0bde';

function adapterOver(files: Parameters<typeof createFakeProviderFiles>[0]) {
  return createClaudeAdapter({ files: createFakeProviderFiles(files) });
}

describe('createClaudeAdapter.discover', () => {
  it('finds a session per transcript, dated and located by the transcript itself', async () => {
    const adapter = adapterOver({
      files: { [`${PROJECT}/${SESSION_ID}.jsonl`]: COMPLETED_TURN },
    });

    const discovered = await adapter.discover(STORE);

    expect(discovered.problems).toEqual([]);
    expect(discovered.sessions).toEqual([
      {
        sessionId: SESSION_ID,
        signal: 'awaiting-input',
        updatedAt: Date.parse('2026-09-03T02:03:10.027Z'),
        cwd: '/Users/dev/Code/agentplex',
        title: 'Docker compose without hub',
      },
    ]);
  });

  it('takes the session id from the file name, not from inside the file', async () => {
    // `--resume` takes the name off the directory listing. When a transcript's
    // own `sessionId` disagrees with its file name — which is what a fork or a
    // copied store leaves behind — the name is the one that can be resumed, so
    // the name is the identity.
    const adapter = adapterOver({
      files: { [`${PROJECT}/9f1d6a2b-0000-4000-8000-000000000000.jsonl`]: COMPLETED_TURN },
    });

    const discovered = await adapter.discover(STORE);

    expect(discovered.sessions.map((session) => session.sessionId)).toEqual([
      '9f1d6a2b-0000-4000-8000-000000000000',
    ]);
  });

  it('leaves a transcript with no turn in it out of the listing, silently', async () => {
    const adapter = adapterOver({
      files: {
        [`${PROJECT}/${SESSION_ID}.jsonl`]: COMPLETED_TURN,
        [`${PROJECT}/40839ba3-652f-4c07-8404-43fcd03ba122.jsonl`]: NO_TURNS,
      },
    });

    const discovered = await adapter.discover(STORE);

    expect(discovered.sessions.map((session) => session.sessionId)).toEqual([SESSION_ID]);
    expect(discovered.problems).toEqual([]);
  });

  it('does not descend into the directories Claude Code keeps beside a transcript', async () => {
    // A session with subagents gets `<sessionId>/subagents/*.jsonl` and
    // `<sessionId>/tool-results/` next to its own file. Those transcripts are
    // real and parseable, and reporting them would double every session that
    // ever ran a Task.
    const adapter = adapterOver({
      files: {
        [`${PROJECT}/${SESSION_ID}.jsonl`]: COMPLETED_TURN,
        [`${PROJECT}/${SESSION_ID}/subagents/aaaaaaaa-0000-4000-8000-000000000000.jsonl`]:
          COMPLETED_TURN,
        [`${PROJECT}/${SESSION_ID}/tool-results/whatever.json`]: '{}',
      },
    });

    const discovered = await adapter.discover(STORE);

    expect(discovered.sessions.map((session) => session.sessionId)).toEqual([SESSION_ID]);
    expect(discovered.problems).toEqual([]);
  });

  it('ignores a file in a project directory that is not a transcript', async () => {
    const adapter = adapterOver({
      files: {
        [`${PROJECT}/${SESSION_ID}.jsonl`]: COMPLETED_TURN,
        [`${PROJECT}/.DS_Store`]: 'not yours',
      },
    });

    const discovered = await adapter.discover(STORE);

    expect(discovered.sessions.map((session) => session.sessionId)).toEqual([SESSION_ID]);
    expect(discovered.problems).toEqual([]);
  });

  it('says nothing at all about a store Claude Code has never written into', async () => {
    const discovered = await adapterOver({}).discover(STORE);

    expect(discovered).toEqual({ sessions: [], problems: [] });
  });

  it('costs one unreadable transcript itself and not the sessions beside it', async () => {
    const unreadable = `${PROJECT}/badbadba-0000-4000-8000-000000000000.jsonl`;
    const adapter = adapterOver({
      files: {
        [`${PROJECT}/${SESSION_ID}.jsonl`]: COMPLETED_TURN,
        [unreadable]: COMPLETED_TURN,
      },
      unreadable: [unreadable],
    });

    const discovered = await adapter.discover(STORE);

    expect(discovered.sessions.map((session) => session.sessionId)).toEqual([SESSION_ID]);
    expect(discovered.problems).toEqual([
      { subject: unreadable, problem: expect.stringContaining('EACCES') },
    ]);
  });

  it('costs one unreadable project directory itself and not the other projects', async () => {
    const locked = `${PROJECTS}/-Users-dev-Code-locked`;
    const adapter = adapterOver({
      files: {
        [`${PROJECT}/${SESSION_ID}.jsonl`]: COMPLETED_TURN,
        [`${locked}/cccccccc-0000-4000-8000-000000000000.jsonl`]: COMPLETED_TURN,
      },
      unreadable: [locked],
    });

    const discovered = await adapter.discover(STORE);

    expect(discovered.sessions.map((session) => session.sessionId)).toEqual([SESSION_ID]);
    expect(discovered.problems).toEqual([
      { subject: locked, problem: expect.stringContaining('EACCES') },
    ]);
  });

  it('names the projects directory as the problem when the whole listing fails', async () => {
    const adapter = adapterOver({ unreadable: [PROJECTS] });

    const discovered = await adapter.discover(STORE);

    expect(discovered.sessions).toEqual([]);
    expect(discovered.problems).toEqual([
      { subject: PROJECTS, problem: expect.stringContaining('EACCES') },
    ]);
  });

  it('names a transcript that is damaged rather than merely empty', async () => {
    const damaged = `${PROJECT}/dddddddd-0000-4000-8000-000000000000.jsonl`;
    const adapter = adapterOver({ files: { [damaged]: 'not json at all\n' } });

    const discovered = await adapter.discover(STORE);

    expect(discovered.sessions).toEqual([]);
    expect(discovered.problems).toEqual([
      { subject: damaged, problem: expect.stringContaining('JSON') },
    ]);
  });
});

describe('createClaudeAdapter.status', () => {
  const observed = { updatedAt: 1_756_000_000_000, now: 1_756_000_001_000 };

  it('reports a verified live process as working', () => {
    const status = adapterOver({}).status({ ...observed, signal: 'progressing', running: true });

    expect(status).toBe('working');
  });

  it('passes a state that wants a human straight through, running or not', () => {
    const adapter = adapterOver({});

    expect(adapter.status({ ...observed, signal: 'awaiting-input', running: false })).toBe(
      'awaiting-input',
    );
    expect(adapter.status({ ...observed, signal: 'awaiting-permission', running: true })).toBe(
      'awaiting-permission',
    );
  });

  it('calls a session with nothing verifiably running idle rather than working', () => {
    // Under-claiming on purpose. Nothing this server can verify is running, so
    // saying "working" would put a spinner next to a session that may have died
    // hours ago, and a status nobody can trust is worse than a quiet one.
    const adapter = adapterOver({});

    expect(adapter.status({ ...observed, signal: 'progressing', running: false })).toBe('idle');
    expect(adapter.status({ ...observed, signal: 'quiet', running: false })).toBe('idle');
  });

  it('keeps a transcript it could not read as unknown rather than guessing idle', () => {
    const status = adapterOver({}).status({ ...observed, signal: 'unknown', running: false });

    expect(status).toBe('unknown');
  });
});

describe('createClaudeAdapter launch plans', () => {
  it('refuses to build one, naming what is missing', () => {
    // A refusal is the honest value here and an invented argv is not. Claude
    // Code takes its working directory from the process it is spawned in, and
    // neither request carries one — the store path is the config directory
    // (`~/.claude` generalized), and launching a session with that as its cwd
    // would point the agent at the provider's own state directory, which is
    // the one place the spec forbids agentplex to write.
    const adapter = adapterOver({});

    const spawned = adapter.spawn({ store: STORE, prompt: null });
    const resumed = adapter.resume({
      store: STORE,
      session: sessionRefSchema.parse({ storeId: STORE.storeId, sessionId: SESSION_ID }),
    });

    expect(spawned.ok).toBe(false);
    expect(resumed.ok).toBe(false);
    expect(!spawned.ok && spawned.problem).toContain('working directory');
    expect(!resumed.ok && resumed.problem).toContain('working directory');
  });
});
