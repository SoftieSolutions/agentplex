import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFakeProcessProbe } from '../fake-process-probe.js';
import {
  CLAUDE_SESSIONS_DIRECTORY,
  parseClaudeRegistryEntry,
  readClaudeRegistry,
  resolveWithRegistry,
} from './claude-registry.js';
import { createFakeProviderFiles } from './fake-provider-files.js';

/**
 * The fixture is a captured registry entry, not a shape written from memory.
 *
 * It was copied out of `~/.claude/sessions/71484.json` on this machine (Claude
 * Code 2.1.259) while that session was running, with only payloads replaced:
 * the cwd, the derived session name, and the session id — swapped for the one
 * the transcript fixtures carry so the two captures describe one session. Every
 * key, every type and every value this parser reads is as Claude Code wrote it,
 * including `startedAt` landing 1669ms *after* the process itself started,
 * which is the invariant the liveness check turns on.
 *
 * The status vocabulary is captured too, from the binary rather than a file:
 * `2.1.259` carries `var je=["busy","shell","idle","waiting"]` guarded by
 * `je.includes(e)?e:void 0`, which is both the set and the CLI's own answer to
 * a status it does not know.
 */
const CAPTURED = readFileSync(
  join(import.meta.dirname, 'fixtures', 'claude-session-registry.json'),
  'utf8',
);

const SESSION_ID = '10e6c58c-3fc6-4519-8bb4-1c3f7eef0bde';
const PID = 71_484;
/** The entry's own `startedAt`, as captured. */
const REGISTERED_AT = 1_788_406_129_669;
/** When the process really started, per the `procStart` the same entry carries. */
const PROCESS_STARTED_AT = Date.parse('2026-09-03T03:28:48Z');

/**
 * Bends the captured entry instead of inventing one.
 *
 * The same move `claude-transcript.test.ts` makes: a case this machine did not
 * happen to be in when the capture was taken is reached by changing one value
 * of real output, so every other field stays exactly as the provider writes it.
 */
function captured(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...JSON.parse(CAPTURED), ...overrides });
}

const SESSIONS = `/volumes/claude/${CLAUDE_SESSIONS_DIRECTORY}`;

function registryOver(
  entries: Readonly<Record<string, string>>,
  probe: Parameters<typeof createFakeProcessProbe>[0],
  unreadable?: readonly string[],
) {
  return readClaudeRegistry(
    SESSIONS,
    createFakeProviderFiles({ files: entries, ...(unreadable && { unreadable }) }),
    createFakeProcessProbe(probe),
  );
}

/** A process that really is the one the entry registered. */
const THE_SAME_PROCESS = { processes: { [PID]: PROCESS_STARTED_AT } };

describe('parseClaudeRegistryEntry', () => {
  it('reads a real entry down to the fields liveness turns on', () => {
    expect(parseClaudeRegistryEntry(CAPTURED)).toEqual({
      pid: PID,
      sessionId: SESSION_ID,
      startedAt: REGISTERED_AT,
      status: 'busy',
      statusUpdatedAt: 1_788_407_949_955,
    });
  });

  it('keeps an entry whose status it does not recognise, without a status', () => {
    // What the CLI's own reader does: an unknown status becomes undefined and
    // the entry survives. A newer Claude Code adding a fifth status must not
    // cost agentplex the pid and the dates in the same file.
    const parsed = parseClaudeRegistryEntry(captured({ status: 'hibernating' }));

    expect(parsed?.pid).toBe(PID);
    expect(parsed?.status).toBeUndefined();
  });

  it('refuses an entry that cannot say which session or which process', () => {
    // A session id is opaque to the protocol — any non-empty string up to 200
    // characters — so the shapes rejected here are the ones that leave the
    // entry unable to name a session or a process at all, not ones that fail to
    // look like a uuid. An adapter inventing a stricter id format than the
    // protocol has is how a valid session stops being discoverable.
    expect(parseClaudeRegistryEntry(captured({ pid: 'many' }))).toBeNull();
    expect(parseClaudeRegistryEntry(captured({ pid: -1 }))).toBeNull();
    expect(parseClaudeRegistryEntry(captured({ sessionId: '' }))).toBeNull();
    expect(parseClaudeRegistryEntry(captured({ startedAt: undefined }))).toBeNull();
    expect(parseClaudeRegistryEntry('half a line of js')).toBeNull();
  });
});

describe('readClaudeRegistry', () => {
  it('trusts an entry whose process is alive and started before the entry did', async () => {
    const registry = await registryOver(
      { [`${SESSIONS}/${PID}.json`]: CAPTURED },
      THE_SAME_PROCESS,
    );

    expect(registry.problems).toEqual([]);
    expect(registry.live.get(SESSION_ID)?.status).toBe('busy');
  });

  it('refuses an entry whose pid is gone', async () => {
    const registry = await registryOver({ [`${SESSIONS}/${PID}.json`]: CAPTURED }, {});

    expect(registry.live.size).toBe(0);
  });

  it('refuses a recycled pid, which is alive and is not the same process', async () => {
    // The whole reason the epoch check exists. Entries are never cleaned up, so
    // a months-old entry keeps naming a pid the kernel has since handed to
    // something else — and that something else started *after* the entry was
    // written, which is the one thing that tells them apart.
    const registry = await registryOver(
      { [`${SESSIONS}/${PID}.json`]: CAPTURED },
      {
        processes: { [PID]: REGISTERED_AT + 60_000 },
      },
    );

    expect(registry.live.size).toBe(0);
  });

  it('refuses a live pid it cannot date at all', async () => {
    // A platform with neither `/proc` nor `ps`. An undatable pid is exactly the
    // pid a recycled one is indistinguishable from, so it proves nothing.
    const registry = await registryOver(
      { [`${SESSIONS}/${PID}.json`]: CAPTURED },
      {
        undatable: [PID],
      },
    );

    expect(registry.live.size).toBe(0);
  });

  it('keeps the most recent entry when several claim one session', async () => {
    // A resumed session registers again under a new pid and the old file stays
    // behind forever. Claude Code settles this the same way, sorting its own
    // holders by `statusUpdatedAt` and taking the first.
    const registry = await registryOver(
      {
        [`${SESSIONS}/${PID}.json`]: CAPTURED,
        [`${SESSIONS}/900.json`]: captured({
          pid: 900,
          status: 'waiting',
          statusUpdatedAt: 1_788_407_949_955 + 1,
        }),
      },
      { processes: { [PID]: PROCESS_STARTED_AT, 900: PROCESS_STARTED_AT } },
    );

    expect(registry.live.get(SESSION_ID)?.status).toBe('waiting');
  });

  it('prefers a verified entry over a newer one it could not verify', async () => {
    const registry = await registryOver(
      {
        [`${SESSIONS}/${PID}.json`]: CAPTURED,
        [`${SESSIONS}/900.json`]: captured({
          pid: 900,
          status: 'waiting',
          statusUpdatedAt: 1_788_407_949_955 + 1,
        }),
      },
      THE_SAME_PROCESS,
    );

    expect(registry.live.get(SESSION_ID)?.status).toBe('busy');
  });

  it('says nothing about a store whose provider keeps no registry', async () => {
    const registry = await registryOver({}, {});

    expect(registry).toEqual({ live: new Map(), problems: [] });
  });

  it('reports a registry it is not allowed to read, and keeps going', async () => {
    // Worth a complaint rather than silence: the directory is mode 0700, so a
    // daemon running as another user reads none of it and every session it
    // watches quietly loses its permission prompts. That is a fixable
    // misconfiguration and the user is the only one who can fix it.
    const registry = await registryOver({}, {}, [SESSIONS]);

    expect(registry.live.size).toBe(0);
    expect(registry.problems).toEqual([
      { subject: SESSIONS, problem: expect.stringContaining('EACCES') },
    ]);
  });

  it('drops an entry it cannot parse without complaining about it', async () => {
    // Rewritten on every status change, so a torn read is routine and transient
    // — and costs precision on one session rather than any session at all. A
    // problem here would flap in and out of the listing for no one's benefit.
    const registry = await registryOver(
      {
        [`${SESSIONS}/${PID}.json`]: CAPTURED,
        [`${SESSIONS}/901.json`]: '{"pid":901,"sessi',
      },
      THE_SAME_PROCESS,
    );

    expect(registry.live.get(SESSION_ID)?.status).toBe('busy');
    expect(registry.problems).toEqual([]);
  });

  it('ignores the key files Claude Code keeps beside its entries', async () => {
    const registry = await registryOver(
      {
        [`${SESSIONS}/${PID}.json`]: CAPTURED,
        [`${SESSIONS}/${PID}.ada020ed45ad3c7e.key`]: 'not json',
      },
      THE_SAME_PROCESS,
    );

    expect(registry.live.get(SESSION_ID)?.status).toBe('busy');
    expect(registry.problems).toEqual([]);
  });
});

describe('resolveWithRegistry', () => {
  it('calls a pending tool call a permission prompt when the registry says waiting', () => {
    // The question AGX-17 could not answer. On disk, a session stopped at a
    // permission prompt and a session running a long tool are the same bytes:
    // an assistant `tool_use` with no `tool_result` after it. The registry is
    // the provider declaring which, and this is the only place it is read.
    expect(resolveWithRegistry('progressing', { status: 'waiting' })).toEqual({
      signal: 'awaiting-permission',
      running: false,
    });
  });

  it('lets the transcript keep a wait it has already described', () => {
    // `waiting` is the provider's word for blocked-on-a-human and covers being
    // asked a question as much as being asked for permission — its `waitingFor`
    // field is free-form display text, not a discriminator. So it promotes only
    // the case the transcript genuinely cannot call, and never overrides a
    // transcript that already says a turn ended.
    expect(resolveWithRegistry('awaiting-input', { status: 'waiting' })).toEqual({
      signal: 'awaiting-input',
      running: false,
    });
  });

  it('makes a busy entry the proof of work the transcript cannot be', () => {
    expect(resolveWithRegistry('progressing', { status: 'busy' })).toEqual({
      signal: 'progressing',
      running: true,
    });
  });

  it('does not call an idle or shell session working', () => {
    // Claude Code's own reduction, captured from the same binary:
    // `status==="busy"?"active":status==="waiting"?"blocked":"idle"`. A live
    // process sitting at its prompt is not work in progress.
    expect(resolveWithRegistry('progressing', { status: 'idle' }).running).toBe(false);
    expect(resolveWithRegistry('progressing', { status: 'shell' }).running).toBe(false);
  });

  it('leaves a session with no verified entry exactly as the transcript left it', () => {
    expect(resolveWithRegistry('progressing', undefined)).toEqual({
      signal: 'progressing',
      running: false,
    });
    expect(resolveWithRegistry('unknown', undefined)).toEqual({
      signal: 'unknown',
      running: false,
    });
  });
});
