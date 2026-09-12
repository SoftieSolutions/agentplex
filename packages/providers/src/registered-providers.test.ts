import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { storeDescriptorSchema } from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import { CLAUDE_PROJECTS_DIRECTORY } from './claude-adapter.js';
import { createFakeProviderFiles } from './fake-provider-files.js';
import { createFakeProcessRunner } from './operations/fake-process-runner.js';
import { createRegisteredProviders } from './registered-providers.js';

/** Captured Claude Code output; see the note in `claude-transcript.test.ts`. */
const COMPLETED_TURN = readFileSync(
  join(import.meta.dirname, '..', 'fixtures', 'claude-completed-turn.jsonl'),
  'utf8',
);

const STORE = storeDescriptorSchema.parse({ storeId: 'store-a', path: '/volumes/claude' });
const SESSION_ID = '10e6c58c-3fc6-4519-8bb4-1c3f7eef0bde';
const TRANSCRIPT = `${STORE.path}/${CLAUDE_PROJECTS_DIRECTORY}/-Users-dev-Code-agentplex/${SESSION_ID}.jsonl`;

function registeredOver(files: Record<string, string> = {}) {
  return createRegisteredProviders({
    files: createFakeProviderFiles({ files }),
    runner: createFakeProcessRunner(),
  });
}

describe('createRegisteredProviders', () => {
  it('drives every provider this build ships', () => {
    const providers = registeredOver();

    expect(providers.providers).toEqual(['claude']);
    expect(providers.lookup('claude')).toMatchObject({ ok: true });
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

  it('says this build has no adapter for a provider it does not ship', () => {
    // The protocol names codex and opencode because a session frame has to be
    // able to say what it is. Registering one is a line in the composition and
    // nowhere else, and until that line exists the honest answer is this one.
    const providers = registeredOver();

    expect(providers.lookup('codex')).toMatchObject({ ok: false, reason: 'no-adapter' });
  });
});
