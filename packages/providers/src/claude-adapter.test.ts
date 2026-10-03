import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SESSION_CWD_MAX_CHARS,
  SESSION_TITLE_MAX_CHARS,
  sessionRefSchema,
  storeDescriptorSchema,
} from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import { createFakeProcessProbe } from './fake-process-probe.js';
import { CLAUDE_PROJECTS_DIRECTORY, createClaudeAdapter } from './claude-adapter.js';
import { CLAUDE_REGISTRATION_WINDOW_MS, CLAUDE_SESSIONS_DIRECTORY } from './claude-registry.js';
import { createFakeProviderFiles } from './fake-provider-files.js';

/** Captured Claude Code output; see the note in `claude-transcript.test.ts`. */
function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, '..', 'fixtures', name), 'utf8');
}

const COMPLETED_TURN = fixture('claude-completed-turn.jsonl');
const PENDING_TOOL_USE = fixture('claude-pending-tool-use.jsonl');
const NO_TURNS = fixture('claude-no-turns.jsonl');
const REGISTRY_ENTRY = fixture('claude-session-registry.json');

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

const SESSIONS = `${STORE.path}/${CLAUDE_SESSIONS_DIRECTORY}`;

/** The pid and dates the captured registry entry carries. */
const PID = 71_484;
const PROCESS_STARTED_AT = Date.parse('2026-09-03T03:28:48Z');

/**
 * The home of the account the server runs as. `STORE` is not under it, so
 * every launch below names its store; the default-store case has its own test.
 */
const HOME = '/home/dev';

function adapterOver(
  files: Parameters<typeof createFakeProviderFiles>[0],
  probe: Parameters<typeof createFakeProcessProbe>[0] = {},
) {
  return createClaudeAdapter({
    files: createFakeProviderFiles(files),
    probe: createFakeProcessProbe(probe),
    homeDirectory: HOME,
  });
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
        // The first turn, which is what a spawned terminal is joined by; the
        // last one moves every time anybody speaks.
        createdAt: Date.parse('2026-09-03T02:02:01.540Z'),
        updatedAt: Date.parse('2026-09-03T02:03:10.027Z'),
        running: false,
        // No registry entry in this store, so no process this adapter verified.
        pid: null,
        // No `sessions/` directory at all: Claude Code writes an entry for
        // every process it starts, so an absent registry is a look that found
        // none, not a failure to look.
        process: 'none',
        cwd: '/Users/dev/Code/agentplex',
        title: 'Docker compose without hub',
        // Two API responses across four lines, counted once each. The
        // deduplication is `claude-transcript.ts`'s; this is the assertion
        // that the number it reaches leaves the adapter intact.
        usage: {
          inputTokens: 4,
          cacheReadTokens: 77_192,
          cacheWriteTokens: 18_872,
          outputTokens: 1347,
        },
        // What this captured session was actually running, as Claude Code
        // wrote it on every assistant line of the fixture. It leaves the
        // adapter as the string it arrived as: nothing maps it and nothing
        // checks it against a set of models this repository knows.
        model: 'claude-opus-5',
        // This capture's last turn ends in a redacted `text` block, so there
        // is nothing to report and the adapter says so out loud rather than
        // leaving the field off. The session that does have one is below.
        activity: null,
      },
    ]);
  });

  it('carries the tool the last turn called out of the adapter as an activity', async () => {
    // `claude-pending-tool-use.jsonl` stops on an unanswered `tool_use` named
    // `Bash`. The derivation is `claude-transcript.ts`'s; this is the
    // assertion that it leaves the adapter intact, on the seam the store
    // report is built from.
    const adapter = adapterOver({
      files: { [`${PROJECT}/${SESSION_ID}.jsonl`]: PENDING_TOOL_USE },
    });

    const discovered = await adapter.discover(STORE);

    expect(discovered.sessions.map((session) => session.activity)).toEqual([
      { kind: 'command', text: 'Bash' },
    ]);
    expect(discovered.problems).toEqual([]);
  });

  it('reports no model for a transcript that names none, and calls it no problem', async () => {
    // The other half of the rule. A transcript this adapter can read
    // perfectly well but which never says which model answered -- an older
    // Claude Code, or one that stops writing the field -- is a session with
    // no model to show, not a session to guess a model for and not a store
    // with a fault in it.
    const stripped = COMPLETED_TURN.split('\n')
      .map((line) => line.replaceAll('"model":"claude-opus-5",', ''))
      .join('\n');
    const adapter = adapterOver({ files: { [`${PROJECT}/${SESSION_ID}.jsonl`]: stripped } });

    const discovered = await adapter.discover(STORE);

    expect(discovered.sessions.map((session) => session.model)).toEqual([null]);
    expect(discovered.problems).toEqual([]);
  });

  it('lists a session whose title is too long for the wire, under a clipped title', async () => {
    // The bound is the parser's; this is the assertion that it costs the
    // title its tail and nothing else on the seam the store report is built
    // from -- the session is listed, and nobody is told something is wrong.
    const long = 'Docker compose without hub '.repeat(20);
    const adapter = adapterOver({
      files: {
        [`${PROJECT}/${SESSION_ID}.jsonl`]: COMPLETED_TURN.replace(
          '"aiTitle":"Docker compose without hub"',
          `"aiTitle":"${long}"`,
        ),
      },
    });

    const discovered = await adapter.discover(STORE);

    expect(discovered.problems).toEqual([]);
    expect(discovered.sessions.map((session) => session.sessionId)).toEqual([SESSION_ID]);
    const title = discovered.sessions[0]?.title ?? '';
    expect(title.length).toBeGreaterThan(0);
    expect(title.length).toBeLessThanOrEqual(SESSION_TITLE_MAX_CHARS);
    expect(long.startsWith(title)).toBe(true);
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

describe('createClaudeAdapter.discover, against the session registry', () => {
  const TRANSCRIPT = `${PROJECT}/${SESSION_ID}.jsonl`;
  const ENTRY = `${SESSIONS}/${PID}.json`;
  const theSameProcess = { processes: { [PID]: PROCESS_STARTED_AT } };

  /** The captured entry with only its status changed; see `claude-registry.test.ts`. */
  function entrySaying(status: string): string {
    return JSON.stringify({ ...JSON.parse(REGISTRY_ENTRY), status });
  }

  /**
   * The one session these tests are about, and the status the server would send
   * for it — derived once, from what discovery reported, with `now` supplied.
   */
  async function discoverOne(
    files: Record<string, string>,
    probe: Parameters<typeof createFakeProcessProbe>[0] = theSameProcess,
  ) {
    const adapter = adapterOver({ files }, probe);
    const [session] = (await adapter.discover(STORE)).sessions;
    if (session === undefined) throw new Error('the fixture discovered no session');

    return {
      session,
      status: adapter.status({
        signal: session.signal,
        updatedAt: session.updatedAt,
        running: session.running,
        now: session.updatedAt + 1_000,
      }),
    };
  }

  it('turns an unanswered tool call into a permission prompt when the registry says so', async () => {
    // End to end, and the reason this ticket exists. The transcript alone says
    // `progressing` — an assistant `tool_use` with no `tool_result` after it —
    // which is what a permission prompt and a long-running tool both look like
    // on disk. Only the registry entry separates them.
    const found = await discoverOne({
      [TRANSCRIPT]: PENDING_TOOL_USE,
      [ENTRY]: entrySaying('waiting'),
    });

    expect(found.session.signal).toBe('awaiting-permission');
    expect(found.status).toBe('awaiting-permission');
  });

  it('makes working reachable for a session this server never spawned', async () => {
    const found = await discoverOne({ [TRANSCRIPT]: PENDING_TOOL_USE, [ENTRY]: REGISTRY_ENTRY });

    expect(found.session.running).toBe(true);
    expect(found.status).toBe('working');
  });

  it('names the pid of the process it verified, which is what a spawn is joined by', async () => {
    // The pid a server spawned and the pid Claude Code registered are the
    // same process when the spawn exec'd Claude Code, and that is the one
    // join no other session's timing can confuse.
    const found = await discoverOne({ [TRANSCRIPT]: PENDING_TOOL_USE, [ENTRY]: REGISTRY_ENTRY });

    expect(found.session.pid).toBe(PID);
  });

  it('says a verified registry entry is a process running the session', async () => {
    const found = await discoverOne({ [TRANSCRIPT]: PENDING_TOOL_USE, [ENTRY]: REGISTRY_ENTRY });

    expect(found.session.process).toBe('verified');
  });

  it('says no process runs a session whose registry entry outlived its pid', async () => {
    const found = await discoverOne(
      { [TRANSCRIPT]: PENDING_TOOL_USE, [ENTRY]: REGISTRY_ENTRY },
      {},
    );

    expect(found.session.process).toBe('none');
  });

  it('keeps the AGX-17 answer when the registry entry outlived its process', async () => {
    // The entry is still on disk — they always are — and its pid is gone.
    const found = await discoverOne(
      { [TRANSCRIPT]: PENDING_TOOL_USE, [ENTRY]: REGISTRY_ENTRY },
      {},
    );

    expect(found.session.running).toBe(false);
    // An entry is a claim, and one whose process is gone names nobody.
    expect(found.session.pid).toBeNull();
    expect(found.session.signal).toBe('progressing');
    expect(found.status).toBe('idle');
  });

  it('keeps the AGX-17 answer when the pid is alive but has been recycled', async () => {
    const found = await discoverOne(
      { [TRANSCRIPT]: PENDING_TOOL_USE, [ENTRY]: entrySaying('waiting') },
      { processes: { [PID]: Date.parse('2026-09-04T00:00:00Z') } },
    );

    expect(found.session.signal).toBe('progressing');
    expect(found.status).toBe('idle');
  });

  it('says no process runs a session whose registered pid was recycled', async () => {
    // A recycled pid is verified to be some other process, which is a look
    // that found this session's process gone.
    const found = await discoverOne(
      { [TRANSCRIPT]: PENDING_TOOL_USE, [ENTRY]: REGISTRY_ENTRY },
      { processes: { [PID]: Date.parse('2026-09-04T00:00:00Z') } },
    );

    expect(found.session.process).toBe('none');
  });

  it('cannot say whether a process runs a session whose live pid it cannot date', async () => {
    // Alive and undatable is as likely to be the session's own process as a
    // recycled one, so it is neither `verified` nor `none`.
    const found = await discoverOne(
      { [TRANSCRIPT]: PENDING_TOOL_USE, [ENTRY]: REGISTRY_ENTRY },
      { undatable: [PID] },
    );

    expect(found.session.pid).toBeNull();
    expect(found.session.process).toBe('unknown');
  });

  it('cannot say whether a process runs a session when a registry entry will not read', async () => {
    // The entry that failed might be this session's, and nothing short of
    // reading it says which session it names.
    const adapter = adapterOver(
      {
        files: { [TRANSCRIPT]: PENDING_TOOL_USE, [ENTRY]: REGISTRY_ENTRY },
        unreadable: [ENTRY],
      },
      theSameProcess,
    );

    const discovered = await adapter.discover(STORE);

    expect(discovered.sessions.map((session) => session.process)).toEqual(['unknown']);
  });

  it('cannot say whether a process runs a session when a registry entry reads torn', async () => {
    const found = await discoverOne(
      { [TRANSCRIPT]: PENDING_TOOL_USE, [ENTRY]: '{"pid":71484,"sessi' },
      theSameProcess,
    );

    expect(found.session.process).toBe('unknown');
  });

  it('reports a registry it cannot read without dropping a single session', async () => {
    const adapter = adapterOver(
      { files: { [TRANSCRIPT]: PENDING_TOOL_USE }, unreadable: [SESSIONS] },
      {},
    );

    const discovered = await adapter.discover(STORE);

    expect(discovered.sessions.map((session) => session.sessionId)).toEqual([SESSION_ID]);
    expect(discovered.problems).toEqual([
      { subject: SESSIONS, problem: expect.stringContaining('EACCES') },
    ]);
  });

  it('cannot say whether a process runs a session when the registry is unreadable', async () => {
    // Not `none`. A registry this server may not list is no look at all, and
    // `none` is the word a client reads as permission to resume.
    const adapter = adapterOver(
      { files: { [TRANSCRIPT]: PENDING_TOOL_USE }, unreadable: [SESSIONS] },
      {},
    );

    const discovered = await adapter.discover(STORE);

    expect(discovered.sessions.map((session) => session.process)).toEqual(['unknown']);
    expect(discovered.problems).toEqual([
      { subject: SESSIONS, problem: expect.stringContaining('EACCES') },
    ]);
  });
});

describe('createClaudeAdapter.discover, a live claude that has not typed yet', () => {
  // Claude Code registers `sessions/<pid>.json` with its session id within
  // seconds of starting and before anyone types, and writes no transcript
  // until a turn lands (2.1.287, run at the origin for AGX-373). These are the
  // sessions only the registry knows about.
  const TRANSCRIPT = `${PROJECT}/${SESSION_ID}.jsonl`;
  const ENTRY = `${SESSIONS}/${PID}.json`;
  const theSameProcess = { processes: { [PID]: PROCESS_STARTED_AT } };
  /** The captured entry's own `startedAt` and `statusUpdatedAt`. */
  const REGISTERED_AT = 1_788_406_129_669;
  const STATUS_UPDATED_AT = 1_788_407_949_955;

  function entryWith(overrides: Record<string, unknown>): string {
    return JSON.stringify({ ...JSON.parse(REGISTRY_ENTRY), ...overrides });
  }

  async function discoverOver(
    files: Record<string, string>,
    probe: Parameters<typeof createFakeProcessProbe>[0] = theSameProcess,
    unreadable?: readonly string[],
  ) {
    const adapter = adapterOver({ files, ...(unreadable && { unreadable }) }, probe);
    const discovered = await adapter.discover(STORE);
    const statuses = discovered.sessions.map((session) =>
      adapter.status({
        signal: session.signal,
        updatedAt: session.updatedAt,
        running: session.running,
        now: session.updatedAt + 1_000,
      }),
    );
    return { ...discovered, statuses };
  }

  it('lists a verified entry with no transcript as a session, under the entry’s cwd', async () => {
    const found = await discoverOver({ [ENTRY]: REGISTRY_ENTRY });

    expect(found.problems).toEqual([]);
    expect(found.sessions).toEqual([
      {
        sessionId: SESSION_ID,
        // Nothing written, so nothing pending: the registry's status is what
        // says whether the process is at work.
        signal: 'quiet',
        createdAt: REGISTERED_AT,
        updatedAt: STATUS_UPDATED_AT,
        running: true,
        pid: PID,
        process: 'verified',
        cwd: '/Users/dev/Code/agentplex',
        // A transcript is the only place these are written, and there is none.
        title: null,
        usage: null,
        model: null,
        activity: null,
      },
    ]);
    // The captured entry is `busy`.
    expect(found.statuses).toEqual(['working']);
  });

  it('reads an idle entry as idle', async () => {
    const found = await discoverOver({ [ENTRY]: entryWith({ status: 'idle' }) });

    expect(found.sessions.map((session) => session.running)).toEqual([false]);
    expect(found.statuses).toEqual(['idle']);
  });

  it('reads a waiting entry as idle, because there is no tool call for it to be waiting on', async () => {
    // Only `progressing` is promoted to a permission prompt, and a session
    // with no transcript has no unanswered tool call to promote. A claude that
    // is blocked on a human before its first turn -- a dialog at launch -- is
    // not a permission prompt this adapter can name.
    const found = await discoverOver({ [ENTRY]: entryWith({ status: 'waiting' }) });

    expect(found.sessions.map((session) => session.signal)).toEqual(['quiet']);
    expect(found.statuses).toEqual(['idle']);
  });

  it('dates a session by its registration when the entry has never changed status', async () => {
    const found = await discoverOver({ [ENTRY]: entryWith({ statusUpdatedAt: undefined }) });

    expect(found.sessions.map((session) => session.updatedAt)).toEqual([REGISTERED_AT]);
  });

  it('lists one session, the transcript’s, once a turn has landed', async () => {
    // The same id from both sources is one session. The transcript's row is
    // the richer one and is dated by the first turn, which is what a spawn is
    // joined by when the pid is not enough.
    const found = await discoverOver({ [TRANSCRIPT]: COMPLETED_TURN, [ENTRY]: REGISTRY_ENTRY });

    expect(found.sessions).toHaveLength(1);
    expect(found.sessions[0]).toMatchObject({
      sessionId: SESSION_ID,
      createdAt: Date.parse('2026-09-03T02:02:01.540Z'),
      title: 'Docker compose without hub',
      pid: PID,
      process: 'verified',
    });
  });

  it('lists nothing for an entry whose process is gone', async () => {
    const found = await discoverOver({ [ENTRY]: REGISTRY_ENTRY }, {});

    expect(found.sessions).toEqual([]);
    expect(found.problems).toEqual([]);
  });

  it('lists nothing for an entry whose pid was handed to another process', async () => {
    const found = await discoverOver(
      { [ENTRY]: REGISTRY_ENTRY },
      { processes: { [PID]: REGISTERED_AT + 60_000 } },
    );

    expect(found.sessions).toEqual([]);
  });

  it('lists nothing for an entry whose live pid it cannot date', async () => {
    // In doubt is not verified. A row here would claim a live process on the
    // strength of a pid that may have been handed to anything since.
    const found = await discoverOver({ [ENTRY]: REGISTRY_ENTRY }, { undatable: [PID] });

    expect(found.sessions).toEqual([]);
  });

  it('lists a verified entry whose transcript has no turn in it yet', async () => {
    // A transcript with no turn is not a session on its own; a live process
    // running it is.
    const found = await discoverOver({ [TRANSCRIPT]: NO_TURNS, [ENTRY]: REGISTRY_ENTRY });

    expect(found.sessions.map((session) => [session.sessionId, session.title])).toEqual([
      [SESSION_ID, null],
    ]);
    expect(found.problems).toEqual([]);
  });

  it('lists a verified entry whose transcript is damaged, and still names the damage', async () => {
    // A process this server verified is running the session, so leaving it out
    // would under-report a live agent; listing it claims only what the
    // registry proves. The transcript is still somebody's to go and look at.
    const found = await discoverOver({
      [TRANSCRIPT]: 'not json at all\n',
      [ENTRY]: REGISTRY_ENTRY,
    });

    expect(found.sessions.map((session) => [session.sessionId, session.process])).toEqual([
      [SESSION_ID, 'verified'],
    ]);
    expect(found.problems).toEqual([
      { subject: TRANSCRIPT, problem: expect.stringContaining('JSON') },
    ]);
  });

  it('lists a verified entry whose transcript cannot be read, and still names it', async () => {
    const found = await discoverOver(
      { [TRANSCRIPT]: COMPLETED_TURN, [ENTRY]: REGISTRY_ENTRY },
      theSameProcess,
      [TRANSCRIPT],
    );

    expect(found.sessions.map((session) => [session.sessionId, session.title])).toEqual([
      [SESSION_ID, null],
    ]);
    expect(found.problems).toEqual([
      { subject: TRANSCRIPT, problem: expect.stringContaining('EACCES') },
    ]);
  });

  it('lists a session under no cwd when the entry names none or one too long for the wire', async () => {
    const missing = await discoverOver({ [ENTRY]: entryWith({ cwd: undefined }) });
    const tooLong = await discoverOver({
      [ENTRY]: entryWith({ cwd: `/${'d'.repeat(SESSION_CWD_MAX_CHARS)}` }),
    });

    expect(missing.sessions.map((session) => session.cwd)).toEqual([null]);
    expect(tooLong.sessions.map((session) => session.cwd)).toEqual([null]);
  });
});

describe('createClaudeAdapter.liveProcess', () => {
  // The question a retake asks before it signals anything: which process runs
  // this session, and is it at a point where ending it loses no work. Every
  // answer below is read at the moment it is asked, because a pid is stale the
  // moment it is read and this one is about to be sent a signal.
  const ENTRY = `${SESSIONS}/${PID}.json`;
  const OTHER_SESSION_ID = '6a1f3b2c-1d4e-4f5a-8b6c-7d8e9f0a1b2c';
  const SESSION = sessionRefSchema.parse({ storeId: STORE.storeId, sessionId: SESSION_ID });
  /** The captured entry's own `startedAt`. */
  const REGISTERED_AT = 1_788_406_129_669;
  const theSameProcess = { processes: { [PID]: PROCESS_STARTED_AT } };

  function entryWith(overrides: Record<string, unknown>): string {
    return JSON.stringify({ ...JSON.parse(REGISTRY_ENTRY), ...overrides });
  }

  function liveProcessOver(
    files: Record<string, string>,
    probe: Parameters<typeof createFakeProcessProbe>[0] = theSameProcess,
    unreadable?: readonly string[],
  ) {
    const adapter = adapterOver({ files, ...(unreadable && { unreadable }) }, probe);
    return adapter.liveProcess(STORE, SESSION);
  }

  it.each([
    ['idle', 'idle'],
    ['waiting', 'waiting'],
    ['busy', 'working'],
    // `shell` is a `!` command the human typed, running. Status reads it as
    // not running, because Claude Code reduces it to idle; a retake must not,
    // because ending the process ends that command.
    ['shell', 'working'],
  ])('names the verified process at registry status %s as %s', async (status, phase) => {
    expect(await liveProcessOver({ [ENTRY]: entryWith({ status }) })).toEqual({
      pid: PID,
      phase,
      startedAt: PROCESS_STARTED_AT,
    });
  });

  it('names a process whose entry states no status as being in an unknown phase', async () => {
    expect(await liveProcessOver({ [ENTRY]: entryWith({ status: undefined }) })).toEqual({
      pid: PID,
      phase: 'unknown',
      startedAt: PROCESS_STARTED_AT,
    });
  });

  it('names no process for an entry whose pid is dead', async () => {
    expect(await liveProcessOver({ [ENTRY]: entryWith({ status: 'idle' }) }, {})).toBeNull();
  });

  it('names no process for a pid issued after the entry was written', async () => {
    const recycled = { processes: { [PID]: REGISTERED_AT + 60_000 } };
    expect(await liveProcessOver({ [ENTRY]: entryWith({ status: 'idle' }) }, recycled)).toBeNull();
  });

  it('names no process for a pid that was running well before the entry registered', async () => {
    // A store shared by two machines carries the other machine's entries, and
    // a local process that has held the same pid since earlier passes the
    // check discovery makes, which bounds a start only from above. A signal
    // needs the process to have started in the beat before it registered.
    const files = { [ENTRY]: entryWith({ status: 'idle' }) };
    const earlier = { processes: { [PID]: REGISTERED_AT - CLAUDE_REGISTRATION_WINDOW_MS - 1_000 } };

    expect(await liveProcessOver(files, earlier)).toBeNull();
    // Discovery's own reading is left alone: there a real claude that wrote its
    // entry late reading as none would invite a resume onto a live transcript.
    const [session] = (await adapterOver({ files }, earlier).discover(STORE)).sessions;
    expect(session?.process).toBe('verified');
  });

  it('names a pid that started inside the window before its entry registered', async () => {
    const inside = { processes: { [PID]: REGISTERED_AT - CLAUDE_REGISTRATION_WINDOW_MS + 1_000 } };
    expect(await liveProcessOver({ [ENTRY]: entryWith({ status: 'idle' }) }, inside)).toEqual({
      pid: PID,
      phase: 'idle',
      startedAt: REGISTERED_AT - CLAUDE_REGISTRATION_WINDOW_MS + 1_000,
    });
  });

  it('names no process for a live pid this machine cannot date', async () => {
    const undatable = { undatable: [PID] };
    expect(await liveProcessOver({ [ENTRY]: entryWith({ status: 'idle' }) }, undatable)).toBeNull();
  });

  it('names no process while any entry in the registry will not read', async () => {
    // The unread entry could name this session under a more current pid, and
    // the pid this one names would then be the wrong process to signal.
    const unreadable = `${SESSIONS}/4242.json`;
    expect(
      await liveProcessOver(
        { [ENTRY]: entryWith({ status: 'idle' }), [unreadable]: '{}' },
        theSameProcess,
        [unreadable],
      ),
    ).toBeNull();
  });

  it('names no process for a session no entry names', async () => {
    const files = { [ENTRY]: entryWith({ status: 'idle', sessionId: OTHER_SESSION_ID }) };
    expect(await liveProcessOver(files)).toBeNull();
  });

  it('reads the registry again on every ask, so a process that has exited is gone', async () => {
    const probe = createFakeProcessProbe(theSameProcess);
    const adapter = createClaudeAdapter({
      files: createFakeProviderFiles({ files: { [ENTRY]: entryWith({ status: 'idle' }) } }),
      probe,
      homeDirectory: HOME,
    });

    expect(await adapter.liveProcess(STORE, SESSION)).toEqual({
      pid: PID,
      phase: 'idle',
      startedAt: PROCESS_STARTED_AT,
    });
    probe.exit(PID);
    expect(await adapter.liveProcess(STORE, SESSION)).toBeNull();
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

const CWD = '/Users/dev/Code/agentplex';
const SESSION = sessionRefSchema.parse({ storeId: STORE.storeId, sessionId: SESSION_ID });

/** Every argv this adapter can produce, for the rules that hold across all of them. */
function everyArgv() {
  const adapter = adapterOver({});
  const plans = [
    adapter.spawn({ store: STORE, cwd: CWD, prompt: null, approval: null }),
    adapter.spawn({ store: STORE, cwd: CWD, prompt: 'fix the flaky test', approval: null }),
    adapter.resume({ store: STORE, session: SESSION, cwd: CWD, approval: null }),
  ];
  return plans.flatMap((launch) => (launch.ok ? [launch.plan.args] : []));
}

describe('createClaudeAdapter.spawn', () => {
  it('runs claude in the directory the caller resolved, with no prompt to open with', () => {
    const spawned = adapterOver({}).spawn({ store: STORE, cwd: CWD, prompt: null, approval: null });

    expect(spawned).toEqual({
      ok: true,
      plan: {
        command: 'claude',
        args: [],
        cwd: CWD,
        env: { CLAUDE_CONFIG_DIR: STORE.path },
        scrubEnvPrefixes: ['CLAUDE', 'AI_AGENT'],
      },
    });
  });

  it('places the prompt as one argv element', () => {
    // One element, whatever is in it. It is user text, it will contain spaces
    // and quotes and newlines, and the only reason that is safe is that there
    // is no shell anywhere on this path.
    const spawned = adapterOver({}).spawn({
      store: STORE,
      cwd: CWD,
      prompt: 'rm -rf / ; echo "not a command"',
      approval: null,
    });

    expect(spawned.ok && spawned.plan.args).toEqual(['rm -rf / ; echo "not a command"']);
  });

  it('points the child at this store instead of the default config directory', () => {
    // Without this the spawned session writes its transcript into the user's
    // own `~/.claude` and the store agentplex is watching never hears about the
    // session it just started. The variable is set *after* the CLAUDE scrub,
    // which is the whole reason the supervisor applies a plan's variables last.
    const spawned = adapterOver({}).spawn({ store: STORE, cwd: CWD, prompt: null, approval: null });

    expect(spawned.ok && spawned.plan.env.CLAUDE_CONFIG_DIR).toBe(STORE.path);
    expect(spawned.ok && spawned.plan.scrubEnvPrefixes).toContain('CLAUDE');
  });

  it("leaves the account's own Claude config alone in its default store", () => {
    // Naming `~/.claude` in `CLAUDE_CONFIG_DIR` moves Claude Code's global
    // config and keychain item away from the account's, so the session opens
    // on onboarding, logged out. Unset, the transcript lands in the same place.
    const defaultStore = storeDescriptorSchema.parse({
      storeId: 'store-a',
      path: `${HOME}/.claude`,
    });
    const adapter = adapterOver({});
    const spawned = adapter.spawn({ store: defaultStore, cwd: CWD, prompt: null, approval: null });
    const resumed = adapter.resume({
      store: defaultStore,
      session: SESSION,
      cwd: CWD,
      approval: null,
    });

    expect(spawned.ok && spawned.plan.env).toEqual({});
    expect(resumed.ok && resumed.plan.env).toEqual({});
  });

  it('gives a login the environment a session gets, for one store and one home', () => {
    // A login that landed its credentials somewhere a session does not look
    // would be a login that changed nothing.
    const adapter = adapterOver({});
    for (const path of [STORE.path, `${HOME}/.claude`]) {
      const store = storeDescriptorSchema.parse({ storeId: 'store-a', path });
      const spawned = adapter.spawn({ store, cwd: CWD, prompt: null, approval: null });
      const login = adapter.provisioning.login({ store, cwd: CWD });
      if (!spawned.ok || !login.ok) throw new Error('both launches plan');
      expect(login.plan.env).toEqual(spawned.plan.env);
    }
  });

  it('refuses a working directory inside the store', () => {
    const spawned = adapterOver({}).spawn({
      store: STORE,
      cwd: `${STORE.path}/${CLAUDE_PROJECTS_DIRECTORY}`,
      prompt: null,
      approval: null,
    });

    expect(spawned.ok).toBe(false);
    expect(!spawned.ok && spawned.problem).toContain('inside the store');
  });

  it('refuses a working directory that is not an absolute path', () => {
    const spawned = adapterOver({}).spawn({
      store: STORE,
      cwd: 'Code/agentplex',
      prompt: null,
      approval: null,
    });

    expect(spawned.ok).toBe(false);
  });
});

describe('createClaudeAdapter.resume', () => {
  it('resumes by session id, in the directory the session already had', () => {
    const resumed = adapterOver({}).resume({
      store: STORE,
      session: SESSION,
      cwd: CWD,
      approval: null,
    });

    expect(resumed).toEqual({
      ok: true,
      plan: {
        command: 'claude',
        args: ['--resume', SESSION_ID],
        cwd: CWD,
        env: { CLAUDE_CONFIG_DIR: STORE.path },
        scrubEnvPrefixes: ['CLAUDE', 'AI_AGENT'],
      },
    });
  });

  it('refuses a session whose working directory the provider never recorded', () => {
    // `DiscoveredSession.cwd` is null for these. Resuming one in a directory
    // somebody guessed would silently continue the conversation somewhere it
    // has never run, with every relative path in its history now pointing
    // somewhere else.
    const resumed = adapterOver({}).resume({
      store: STORE,
      session: SESSION,
      cwd: null,
      approval: null,
    });

    expect(resumed.ok).toBe(false);
    expect(!resumed.ok && resumed.problem).toContain('working directory');
  });
});

describe('createClaudeAdapter argv invariants', () => {
  it('never names a session id and never forks one', () => {
    // The pin, and the reason it is a test rather than a comment. Both flags
    // are real and both are one edit away from looking like the obvious fix
    // for a resume bug: `--session-id` makes agentplex mint the id instead of
    // Claude Code, and `--fork-session` gives a resumed session a *new* id.
    // Either one splits a history in two — the client keeps watching the
    // transcript it knows and the work continues in a file nobody is reading.
    // Claude Code mints the id, discovery finds it afterwards.
    for (const args of everyArgv()) {
      expect(args).not.toContain('--fork-session');
      expect(args).not.toContain('--session-id');
    }
  });

  it('passes no flag as anything but its own argv element', () => {
    // A joined string is the shape that only works with a shell, and the
    // registry exists so that no spawn ever has one.
    for (const args of everyArgv()) {
      for (const element of args) expect(element).not.toMatch(/^--\S+[ =]/);
    }
  });
});

describe('createClaudeAdapter.transcript', () => {
  const session = sessionRefSchema.parse({ storeId: STORE.storeId, sessionId: SESSION_ID });

  it('reads one session’s transcript out of whichever project directory holds it', async () => {
    const adapter = adapterOver({
      files: {
        [`${PROJECTS}/-Users-dev-Code-other/99999999-3fc6-4519-8bb4-1c3f7eef0bde.jsonl`]: NO_TURNS,
        [`${PROJECT}/${SESSION_ID}.jsonl`]: PENDING_TOOL_USE,
      },
    });

    const read = await adapter.transcript({ store: STORE, session, limit: 10 });

    expect(read).toEqual({
      ok: true,
      transcript: { activities: [{ kind: 'command', text: 'Bash' }], olderExist: false },
    });
  });

  it('refuses, in words, a session no project directory holds', async () => {
    // The hub's view of a store is a scan or two old, so asking for a session
    // that has since been deleted is ordinary rather than exceptional. A
    // sentence naming the session is what a screen shows.
    const adapter = adapterOver({ files: { [`${PROJECT}/${SESSION_ID}.jsonl`]: COMPLETED_TURN } });

    const read = await adapter.transcript({
      store: STORE,
      session: sessionRefSchema.parse({
        storeId: STORE.storeId,
        sessionId: '99999999-3fc6-4519-8bb4-1c3f7eef0bde',
      }),
      limit: 10,
    });

    expect(read).toEqual({
      ok: false,
      problem: 'this store holds no claude transcript for that session',
    });
  });

  it('refuses, in words, a transcript that is there and will not be read', async () => {
    const adapter = adapterOver({
      files: { [`${PROJECT}/${SESSION_ID}.jsonl`]: COMPLETED_TURN },
      unreadable: [`${PROJECT}/${SESSION_ID}.jsonl`],
    });

    const read = await adapter.transcript({ store: STORE, session, limit: 10 });

    expect(read.ok).toBe(false);
    expect(!read.ok && read.problem).toContain('cannot read transcript');
  });

  it('never recurses into the directories a session with subagents leaves behind', async () => {
    // A session that ran subagents gets `<sessionId>/subagents/*.jsonl` beside
    // its own transcript, and those files would parse. Discovery already takes
    // files and only files out of a project directory; this reads one named
    // file, so a subagent's transcript is not reachable by asking for the
    // session it belongs to.
    const adapter = adapterOver({
      files: {
        [`${PROJECT}/${SESSION_ID}/subagents/${SESSION_ID}.jsonl`]: PENDING_TOOL_USE,
      },
    });

    const read = await adapter.transcript({ store: STORE, session, limit: 10 });

    expect(read.ok).toBe(false);
  });

  it('answers only what was asked for, and says there is more behind it', async () => {
    const adapter = adapterOver({
      files: { [`${PROJECT}/${SESSION_ID}.jsonl`]: PENDING_TOOL_USE },
    });

    const read = await adapter.transcript({ store: STORE, session, limit: 0 });

    expect(read).toEqual({ ok: true, transcript: { activities: [], olderExist: true } });
  });

  describe('for a live claude that has not typed yet', () => {
    // Discovery lists these off a verified registry entry alone, so asking for
    // one's transcript is ordinary: there is none on disk until a turn lands.
    const ENTRY = `${SESSIONS}/${PID}.json`;
    const theSameProcess = { processes: { [PID]: PROCESS_STARTED_AT } };

    it('answers an empty transcript for a session only its verified registry entry names', async () => {
      const adapter = adapterOver({ files: { [ENTRY]: REGISTRY_ENTRY } }, theSameProcess);

      const read = await adapter.transcript({ store: STORE, session, limit: 10 });

      expect(read).toEqual({ ok: true, transcript: { activities: [], olderExist: false } });
    });

    it('still refuses a session neither a transcript nor a verified entry names', async () => {
      const adapter = adapterOver({ files: { [ENTRY]: REGISTRY_ENTRY } }, theSameProcess);

      const read = await adapter.transcript({
        store: STORE,
        session: sessionRefSchema.parse({
          storeId: STORE.storeId,
          sessionId: '99999999-3fc6-4519-8bb4-1c3f7eef0bde',
        }),
        limit: 10,
      });

      expect(read).toEqual({
        ok: false,
        problem: 'this store holds no claude transcript for that session',
      });
    });

    it('still refuses a session whose entry names a live pid it cannot date', async () => {
      // In doubt is not verified, the same line discovery draws: the pid may
      // belong to anything by now, and an empty transcript would vouch for it.
      const adapter = adapterOver({ files: { [ENTRY]: REGISTRY_ENTRY } }, { undatable: [PID] });

      const read = await adapter.transcript({ store: STORE, session, limit: 10 });

      expect(read).toEqual({
        ok: false,
        problem: 'this store holds no claude transcript for that session',
      });
    });
  });
});

describe('createClaudeAdapter.discover, scan after scan', () => {
  const TRANSCRIPT = `${PROJECT}/${SESSION_ID}.jsonl`;
  const ENTRY = `${SESSIONS}/${PID}.json`;

  /**
   * The first `count` lines of a captured transcript, as the file stood when
   * Claude Code had written only those. A transcript is appended one line at a
   * time, so a prefix of a capture is a capture of an earlier moment.
   */
  function firstLines(contents: string, count: number): string {
    return `${contents.split('\n').slice(0, count).join('\n')}\n`;
  }

  /** Up to the first assistant response; the second one is what gets appended. */
  const EARLIER = firstLines(COMPLETED_TURN, 7);

  /** The transcripts a scan read whole, as opposed to the registry files it also reads. */
  function transcriptReads(reads: readonly string[]): string[] {
    return reads.filter((path) => path.startsWith(PROJECTS));
  }

  async function freshAnswer(files: Record<string, string>) {
    return await adapterOver({ files }).discover(STORE);
  }

  it('reads no transcript on a second scan of a store where nothing changed', async () => {
    const files = createFakeProviderFiles({
      files: {
        [TRANSCRIPT]: COMPLETED_TURN,
        [`${PROJECT}/40839ba3-652f-4c07-8404-43fcd03ba122.jsonl`]: NO_TURNS,
      },
    });
    const adapter = createClaudeAdapter({
      files,
      probe: createFakeProcessProbe(),
      homeDirectory: HOME,
    });

    const first = await adapter.discover(STORE);
    const readBefore = files.reads.length;
    const second = await adapter.discover(STORE);

    // The one with no turns included: "not a session" is an answer about the
    // file, and it is as settled as a parse that found one.
    expect(transcriptReads(files.reads.slice(readBefore))).toEqual([]);
    expect(second).toEqual(first);
  });

  it('reads a transcript again once a turn is appended, and reports what it added', async () => {
    const files = createFakeProviderFiles({ files: { [TRANSCRIPT]: EARLIER } });
    const adapter = createClaudeAdapter({
      files,
      probe: createFakeProcessProbe(),
      homeDirectory: HOME,
    });
    const [before] = (await adapter.discover(STORE)).sessions;

    files.write(TRANSCRIPT, COMPLETED_TURN);
    const readBefore = files.reads.length;
    const after = await adapter.discover(STORE);

    expect(transcriptReads(files.reads.slice(readBefore))).toEqual([TRANSCRIPT]);
    expect(after).toEqual(await freshAnswer({ [TRANSCRIPT]: COMPLETED_TURN }));
    const [session] = after.sessions;
    expect(session?.updatedAt).toBeGreaterThan(before?.updatedAt ?? Number.POSITIVE_INFINITY);
    expect(session?.usage?.outputTokens).toBeGreaterThan(before?.usage?.outputTokens ?? 0);
  });

  it('reads a truncated transcript again in full, and answers as if seeing it first', async () => {
    // Shorter is not an append, so nothing about the last parse can be kept.
    // The answer has to be the one an adapter that never saw the longer file
    // would give.
    const files = createFakeProviderFiles({ files: { [TRANSCRIPT]: COMPLETED_TURN } });
    const adapter = createClaudeAdapter({
      files,
      probe: createFakeProcessProbe(),
      homeDirectory: HOME,
    });
    await adapter.discover(STORE);

    files.write(TRANSCRIPT, EARLIER);
    const readBefore = files.reads.length;
    const after = await adapter.discover(STORE);

    expect(transcriptReads(files.reads.slice(readBefore))).toEqual([TRANSCRIPT]);
    expect(after).toEqual(await freshAnswer({ [TRANSCRIPT]: EARLIER }));
  });

  it('reads a transcript again when only its mtime moved', async () => {
    const files = createFakeProviderFiles({
      files: { [TRANSCRIPT]: COMPLETED_TURN },
      mtimes: { [TRANSCRIPT]: 1_000 },
    });
    const adapter = createClaudeAdapter({
      files,
      probe: createFakeProcessProbe(),
      homeDirectory: HOME,
    });
    await adapter.discover(STORE);

    files.write(TRANSCRIPT, COMPLETED_TURN, 2_000);
    const readBefore = files.reads.length;
    await adapter.discover(STORE);

    expect(transcriptReads(files.reads.slice(readBefore))).toEqual([TRANSCRIPT]);
  });

  it('still resolves an unchanged transcript against this scan’s registry', async () => {
    // What is remembered is the parse of the file, not the session built from
    // it. The registry says what is happening now, and a cached answer that
    // froze it would keep a session waiting for a permission long answered.
    const files = createFakeProviderFiles({
      files: {
        [TRANSCRIPT]: PENDING_TOOL_USE,
        [ENTRY]: JSON.stringify({ ...JSON.parse(REGISTRY_ENTRY), status: 'waiting' }),
      },
    });
    const adapter = createClaudeAdapter({
      files,
      probe: createFakeProcessProbe({ processes: { [PID]: PROCESS_STARTED_AT } }),
      homeDirectory: HOME,
    });
    const [waiting] = (await adapter.discover(STORE)).sessions;

    files.write(ENTRY, REGISTRY_ENTRY);
    const readBefore = files.reads.length;
    const [busy] = (await adapter.discover(STORE)).sessions;

    expect(transcriptReads(files.reads.slice(readBefore))).toEqual([]);
    expect(waiting?.signal).toBe('awaiting-permission');
    expect(busy?.signal).toBe('progressing');
    expect(busy?.running).toBe(true);
  });

  it('names a damaged transcript on every scan, without reading it again', async () => {
    const damaged = `${PROJECT}/dddddddd-0000-4000-8000-000000000000.jsonl`;
    const files = createFakeProviderFiles({ files: { [damaged]: 'not json at all\n' } });
    const adapter = createClaudeAdapter({
      files,
      probe: createFakeProcessProbe(),
      homeDirectory: HOME,
    });
    const first = await adapter.discover(STORE);

    const readBefore = files.reads.length;
    const second = await adapter.discover(STORE);

    expect(transcriptReads(files.reads.slice(readBefore))).toEqual([]);
    expect(second.problems).toEqual(first.problems);
    expect(second.problems).toEqual([
      { subject: damaged, problem: expect.stringContaining('JSON') },
    ]);
  });

  it('tries an unreadable transcript again on every scan rather than remembering it failed', async () => {
    // A permission fixed without touching the file leaves its size and mtime
    // where they were, so a remembered failure would outlive the fault.
    const unreadable = `${PROJECT}/badbadba-0000-4000-8000-000000000000.jsonl`;
    const files = createFakeProviderFiles({
      files: { [unreadable]: COMPLETED_TURN },
      unreadable: [unreadable],
    });
    const adapter = createClaudeAdapter({
      files,
      probe: createFakeProcessProbe(),
      homeDirectory: HOME,
    });
    await adapter.discover(STORE);

    const readBefore = files.reads.length;
    const second = await adapter.discover(STORE);

    expect(transcriptReads(files.reads.slice(readBefore))).toEqual([unreadable]);
    expect(second.problems).toEqual([
      { subject: unreadable, problem: expect.stringContaining('EACCES') },
    ]);
  });

  it('names a transcript it cannot stat, and reads nothing it cannot stamp', async () => {
    const unstatable = `${PROJECT}/eeeeeeee-0000-4000-8000-000000000000.jsonl`;
    const files = createFakeProviderFiles({
      files: { [TRANSCRIPT]: COMPLETED_TURN, [unstatable]: COMPLETED_TURN },
      unstatable: [unstatable],
    });
    const adapter = createClaudeAdapter({
      files,
      probe: createFakeProcessProbe(),
      homeDirectory: HOME,
    });

    const discovered = await adapter.discover(STORE);

    expect(transcriptReads(files.reads)).toEqual([TRANSCRIPT]);
    expect(discovered.sessions.map((session) => session.sessionId)).toEqual([SESSION_ID]);
    expect(discovered.problems).toEqual([
      { subject: unstatable, problem: expect.stringContaining('EACCES') },
    ]);
  });

  it('forgets a deleted transcript, so a file put back in its place is read afresh', async () => {
    const files = createFakeProviderFiles({
      files: { [TRANSCRIPT]: COMPLETED_TURN },
      mtimes: { [TRANSCRIPT]: 1_000 },
    });
    const adapter = createClaudeAdapter({
      files,
      probe: createFakeProcessProbe(),
      homeDirectory: HOME,
    });
    await adapter.discover(STORE);

    files.remove(TRANSCRIPT);
    expect((await adapter.discover(STORE)).sessions).toEqual([]);

    // Back with the very same size and mtime, so only a cache that let go of
    // the path when it disappeared reads it again.
    files.write(TRANSCRIPT, COMPLETED_TURN, 1_000);
    const readBefore = files.reads.length;
    const back = await adapter.discover(STORE);

    expect(transcriptReads(files.reads.slice(readBefore))).toEqual([TRANSCRIPT]);
    expect(back.sessions.map((session) => session.sessionId)).toEqual([SESSION_ID]);
  });

  it('keeps one store’s transcripts remembered while it scans another', async () => {
    // One adapter serves every store on the server. A scan of B forgetting
    // everything it did not see would forget all of A.
    const storeB = storeDescriptorSchema.parse({ storeId: 'store-b', path: '/volumes/other' });
    const inB = `${storeB.path}/${CLAUDE_PROJECTS_DIRECTORY}/-Users-dev-Code-other/${SESSION_ID}.jsonl`;
    const files = createFakeProviderFiles({
      files: { [TRANSCRIPT]: COMPLETED_TURN, [inB]: PENDING_TOOL_USE },
    });
    const adapter = createClaudeAdapter({
      files,
      probe: createFakeProcessProbe(),
      homeDirectory: HOME,
    });

    await adapter.discover(STORE);
    await adapter.discover(storeB);
    const readBefore = files.reads.length;
    await adapter.discover(STORE);
    await adapter.discover(storeB);

    expect(files.reads.slice(readBefore).filter((path) => path.endsWith('.jsonl'))).toEqual([]);
  });
});
