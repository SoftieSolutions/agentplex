import { storeDescriptorSchema, type SessionRef } from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import type { Clock } from '../../shared/clock.js';
import { createFakeProviderAdapter, FAKE_SESSIONS_DIRECTORY } from './fake-provider-adapter.js';
import { createFakeProviderFiles } from './fake-provider-files.js';
import { createProviderRegistry } from './provider-registry.js';
import { discoverStoreSessions, type SessionLiveness } from './store-discovery.js';

const STORE = storeDescriptorSchema.parse({ storeId: 'store-a', path: '/volumes/claude' });

const NOW = 1_756_000_000_000;
const clock: Clock = { now: () => NOW };

function transcriptsAt(provider: string): string {
  return `${STORE.path}/${provider}${FAKE_SESSIONS_DIRECTORY}`;
}

function transcript(signal: string, updatedAt: number = NOW - 1_000): string {
  return JSON.stringify({ signal, updatedAt, cwd: '/work', title: 'a made-up session' });
}

function liveness(...running: readonly string[]): SessionLiveness {
  const live = new Set(running);
  return { isRunning: (session: SessionRef) => live.has(session.sessionId) };
}

const nothingRunning = liveness();

describe('discoverStoreSessions', () => {
  it('reports a session per transcript, stamped with the store it was found in', async () => {
    const files = createFakeProviderFiles({
      files: {
        [`${transcriptsAt('claude')}/session-a.json`]: transcript('awaiting-permission'),
        [`${transcriptsAt('claude')}/session-b.json`]: transcript('quiet'),
      },
    });
    const registry = createProviderRegistry([createFakeProviderAdapter({ files })]);

    const discovered = await discoverStoreSessions(STORE, {
      registry,
      clock,
      liveness: nothingRunning,
    });

    expect(discovered.problems).toEqual([]);
    expect(discovered.sessions).toEqual([
      {
        storeId: 'store-a',
        sessionId: 'session-a',
        provider: 'claude',
        status: 'awaiting-permission',
        updatedAt: NOW - 1_000,
        cwd: '/work',
        title: 'a made-up session',
      },
      {
        storeId: 'store-a',
        sessionId: 'session-b',
        provider: 'claude',
        status: 'idle',
        updatedAt: NOW - 1_000,
        cwd: '/work',
        title: 'a made-up session',
      },
    ]);
  });

  it('carries a cwd and title the adapter did not find as null, and derives neither itself', async () => {
    // The only place a cwd is reliable is inside the provider's own format —
    // Claude Code's per-project directory name, for one, encodes `/` and `.`
    // onto the same character and cannot be decoded back. So a provider that
    // records neither yields null here rather than something reconstructed.
    const files = createFakeProviderFiles({
      files: {
        [`${transcriptsAt('claude')}/session-a.json`]: JSON.stringify({
          signal: 'quiet',
          updatedAt: NOW - 1_000,
        }),
      },
    });
    const registry = createProviderRegistry([createFakeProviderAdapter({ files })]);

    const discovered = await discoverStoreSessions(STORE, {
      registry,
      clock,
      liveness: nothingRunning,
    });

    expect(discovered.sessions[0]).toMatchObject({ cwd: null, title: null });
  });

  it('hands the adapter liveness and the clock, and takes the status it answers', async () => {
    // Only the adapter knows what its own transcript signal means; only the
    // server knows whether a process is alive and what time it is. Status is
    // where the two meet, so both are arguments and none is read inside.
    const files = createFakeProviderFiles({
      files: { [`${transcriptsAt('claude')}/session-a.json`]: transcript('quiet') },
    });
    const adapter = createFakeProviderAdapter({ files });
    const registry = createProviderRegistry([adapter]);

    const discovered = await discoverStoreSessions(STORE, {
      registry,
      clock,
      liveness: liveness('session-a'),
    });

    expect(adapter.observations).toEqual([
      { signal: 'quiet', updatedAt: NOW - 1_000, running: true, now: NOW },
    ]);
    expect(discovered.sessions[0]?.status).toBe('working');
  });

  it('takes a live process from the adapter for a session it never spawned itself', async () => {
    // Two witnesses to one fact, and the server has only one of them. A session
    // started in somebody's terminal is invisible to this server's own process
    // table and is exactly the session a watcher exists to report, so the
    // adapter's verified answer has to count on its own.
    const files = createFakeProviderFiles({
      files: {
        [`${transcriptsAt('claude')}/session-a.json`]: JSON.stringify({
          signal: 'progressing',
          updatedAt: NOW - 1_000,
          running: true,
        }),
      },
    });
    const adapter = createFakeProviderAdapter({ files });

    const discovered = await discoverStoreSessions(STORE, {
      registry: createProviderRegistry([adapter]),
      clock,
      liveness: nothingRunning,
    });

    expect(adapter.observations).toEqual([
      { signal: 'progressing', updatedAt: NOW - 1_000, running: true, now: NOW },
    ]);
    expect(discovered.sessions[0]?.status).toBe('working');
  });

  it('lets a provider with no directory in this store cost itself and not the store', async () => {
    const files = createFakeProviderFiles({
      files: { [`${transcriptsAt('claude')}/session-a.json`]: transcript('quiet') },
      unreadable: [transcriptsAt('codex')],
    });
    const registry = createProviderRegistry([
      createFakeProviderAdapter({ provider: 'claude', files }),
      createFakeProviderAdapter({ provider: 'codex', files }),
    ]);

    const discovered = await discoverStoreSessions(STORE, {
      registry,
      clock,
      liveness: nothingRunning,
    });

    expect(discovered.sessions.map((session) => session.sessionId)).toEqual(['session-a']);
    expect(discovered.problems).toEqual([
      {
        provider: 'codex',
        subject: transcriptsAt('codex'),
        problem: expect.stringContaining('EACCES'),
      },
    ]);
  });

  it('keeps a transcript it cannot read out of the listing and names it as a problem', async () => {
    const unreadable = `${transcriptsAt('claude')}/session-b.json`;
    const files = createFakeProviderFiles({
      files: {
        [`${transcriptsAt('claude')}/session-a.json`]: transcript('quiet'),
        [unreadable]: transcript('quiet'),
        [`${transcriptsAt('claude')}/session-c.json`]: 'half a transcript',
      },
      unreadable: [unreadable],
    });
    const registry = createProviderRegistry([createFakeProviderAdapter({ files })]);

    const discovered = await discoverStoreSessions(STORE, {
      registry,
      clock,
      liveness: nothingRunning,
    });

    expect(discovered.sessions.map((session) => session.sessionId)).toEqual(['session-a']);
    expect(discovered.problems.map((problem) => problem.subject)).toEqual([
      unreadable,
      `${transcriptsAt('claude')}/session-c.json`,
    ]);
  });

  it('treats an adapter that throws as a problem, not as a store that failed', async () => {
    // An adapter is somebody else's code once this is open source. It getting
    // this wrong must cost its own provider, exactly like an unreadable file.
    const files = createFakeProviderFiles({
      files: { [`${transcriptsAt('claude')}/session-a.json`]: transcript('quiet') },
    });
    const registry = createProviderRegistry([
      createFakeProviderAdapter({ provider: 'claude', files }),
      createFakeProviderAdapter({ provider: 'codex', throwsOnDiscover: 'adapter is broken' }),
    ]);

    const discovered = await discoverStoreSessions(STORE, {
      registry,
      clock,
      liveness: nothingRunning,
    });

    expect(discovered.sessions.map((session) => session.sessionId)).toEqual(['session-a']);
    expect(discovered.problems).toEqual([
      {
        provider: 'codex',
        subject: STORE.path,
        problem: expect.stringContaining('adapter is broken'),
      },
    ]);
  });

  it('says nothing about a provider that has never written into this store', async () => {
    // Absence is the common case, not a fault: most stores hold one provider's
    // sessions. A problem per registered-but-absent provider would put a
    // permanent complaint in front of every user with a normal store.
    const files = createFakeProviderFiles({
      files: { [`${transcriptsAt('claude')}/session-a.json`]: transcript('quiet') },
    });
    const registry = createProviderRegistry([
      createFakeProviderAdapter({ provider: 'claude', files }),
      createFakeProviderAdapter({ provider: 'opencode', files }),
    ]);

    const discovered = await discoverStoreSessions(STORE, {
      registry,
      clock,
      liveness: nothingRunning,
    });

    expect(discovered.problems).toEqual([]);
    expect(discovered.sessions.map((session) => session.provider)).toEqual(['claude']);
  });

  it('finds nothing, and complains about nothing, when no adapter is registered', async () => {
    const discovered = await discoverStoreSessions(STORE, {
      registry: createProviderRegistry([]),
      clock,
      liveness: nothingRunning,
    });

    expect(discovered).toEqual({ sessions: [], problems: [] });
  });
});
