import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { storeDescriptorSchema } from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import { CLAUDE_PROJECTS_DIRECTORY } from './claude-adapter.js';
import { CODEX_SESSIONS_DIRECTORY } from './codex-adapter.js';
import { createFakeProviderFiles } from './fake-provider-files.js';
import { createFakeProcessRunner } from './operations/fake-process-runner.js';
import { createRegisteredProviders } from './registered-providers.js';

/** Captured provider output; see the notes in the two transcript tests. */
function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, '..', 'fixtures', name), 'utf8');
}

const COMPLETED_TURN = fixture('claude-completed-turn.jsonl');
const CODEX_COMPLETED_TURN = fixture('codex-completed-turn.jsonl');

const STORE = storeDescriptorSchema.parse({ storeId: 'store-a', path: '/volumes/claude' });
const SESSION_ID = '10e6c58c-3fc6-4519-8bb4-1c3f7eef0bde';
const TRANSCRIPT = `${STORE.path}/${CLAUDE_PROJECTS_DIRECTORY}/-Users-dev-Code-agentplex/${SESSION_ID}.jsonl`;

const CODEX_SESSION_ID = '01a09386-f378-7b23-83a7-6c263ed59701';
const ROLLOUT = `${STORE.path}/${CODEX_SESSIONS_DIRECTORY}/2026/09/11/rollout-2026-09-11T23-51-30-${CODEX_SESSION_ID}.jsonl`;

function registeredOver(files: Record<string, string> = {}) {
  return createRegisteredProviders({
    files: createFakeProviderFiles({ files }),
    runner: createFakeProcessRunner(),
  });
}

describe('createRegisteredProviders', () => {
  it('drives every provider this build ships', () => {
    const providers = registeredOver();

    expect(providers.providers).toEqual(['claude', 'codex']);
    expect(providers.lookup('claude')).toMatchObject({ ok: true });
    expect(providers.lookup('codex')).toMatchObject({ ok: true });
  });

  it('builds its adapters over the store filesystem it was handed', async () => {
    // The assertion the composition exists for: the seams stay the caller's.
    // An adapter built over a filesystem of its own choosing would answer from
    // the machine the test is running on, and the entrypoints could no longer
    // decide what their adapters read.
    const lookup = registeredOver({ [TRANSCRIPT]: COMPLETED_TURN }).lookup('claude');
    if (!lookup.ok) throw new Error(lookup.problem);

    const discovered = await lookup.adapter.discover(STORE);

    expect(discovered.problems).toEqual([]);
    expect(discovered.sessions.map((session) => session.sessionId)).toEqual([SESSION_ID]);
  });

  it('builds the codex adapter over that same filesystem', async () => {
    // The same assertion for the second provider, and the point of making it
    // twice: registering codex was one line in this composition, and the two
    // adapters read the store the entrypoint handed over rather than one each
    // has gone and found.
    const lookup = registeredOver({ [ROLLOUT]: CODEX_COMPLETED_TURN }).lookup('codex');
    if (!lookup.ok) throw new Error(lookup.problem);

    const discovered = await lookup.adapter.discover(STORE);

    expect(discovered.problems).toEqual([]);
    expect(discovered.sessions.map((session) => session.sessionId)).toEqual([CODEX_SESSION_ID]);
  });

  it("keeps one provider out of the other provider's store", async () => {
    // Both adapters are asked about every store, so a store holding only
    // Claude Code transcripts has to come back empty from codex rather than
    // complaining about a provider that was simply never used there.
    const providers = registeredOver({ [TRANSCRIPT]: COMPLETED_TURN });
    const codex = providers.lookup('codex');
    if (!codex.ok) throw new Error(codex.problem);

    expect(await codex.adapter.discover(STORE)).toEqual({ sessions: [], problems: [] });
  });

  it('says this build has no adapter for a provider it does not ship', () => {
    // The protocol names opencode because a session frame has to be able to
    // say what it is. Registering one is a line in this composition and
    // nowhere else, and until that line exists the honest answer is this one.
    const providers = registeredOver();

    expect(providers.lookup('opencode')).toMatchObject({ ok: false, reason: 'no-adapter' });
  });
});
