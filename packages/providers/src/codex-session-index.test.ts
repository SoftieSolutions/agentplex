import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SESSION_TITLE_MAX_CHARS } from '@agentplex/protocol';
import { parseCodexSessionIndex } from './codex-session-index.js';

/** Captured codex output; see the note in `codex-rollout.test.ts`. */
const SESSION_INDEX = readFileSync(
  join(import.meta.dirname, '..', 'fixtures', 'codex-session-index.jsonl'),
  'utf8',
);

describe('parseCodexSessionIndex', () => {
  it('reads the name codex gave a session out of the real index', () => {
    const names = parseCodexSessionIndex(SESSION_INDEX);

    expect(names.get('01a09386-f378-7b23-83a7-6c263ed59701')).toBe('Reply with pineapple');
  });

  it('keeps the last entry for a session, because a rename appends another', () => {
    const renamed = [
      '{"id":"s-1","thread_name":"First guess","updated_at":"2026-09-12T02:51:39.088639Z"}',
      '{"id":"s-1","thread_name":"What it became","updated_at":"2026-09-12T02:59:01.000000Z"}',
    ].join('\n');

    expect(parseCodexSessionIndex(renamed).get('s-1')).toBe('What it became');
  });

  it('drops a line it cannot read without losing the ones either side', () => {
    // This file is rewritten as sessions are named, so a torn read is routine.
    // One bad line must not cost the whole store its titles.
    const torn = [
      '{"id":"s-1","thread_name":"Before"}',
      '{"id":"s-2","thread_na',
      '{"id":"s-3","thread_name":"After"}',
    ].join('\n');

    const names = parseCodexSessionIndex(torn);

    expect([...names.entries()]).toEqual([
      ['s-1', 'Before'],
      ['s-3', 'After'],
    ]);
  });

  it('clips a name longer than the descriptor carries, rather than losing it', () => {
    // codex names a session with a model, so the length is the model's to
    // choose. Past the bound it would fail the store report every other
    // session rides on; clipped it is still a fair name.
    const long = 'Reply with pineapple '.repeat(20);
    const names = parseCodexSessionIndex(
      SESSION_INDEX.replace('"thread_name":"Reply with pineapple"', `"thread_name":"${long}"`),
    );
    const title = names.get('01a09386-f378-7b23-83a7-6c263ed59701');

    expect(title?.length).toBeLessThanOrEqual(SESSION_TITLE_MAX_CHARS);
    expect(title).toBe(title?.trim());
    expect(long.startsWith(title ?? '-')).toBe(true);
  });

  it('gives no name to a session whose name is nothing that can be drawn', () => {
    const names = parseCodexSessionIndex(
      SESSION_INDEX.replace(
        '"thread_name":"Reply with pineapple"',
        '"thread_name":"\\u202e\\u2066\\u200f"',
      ),
    );

    expect(names.has('01a09386-f378-7b23-83a7-6c263ed59701')).toBe(false);
  });

  it('forgets an earlier name when the rename that replaced it draws as nothing', () => {
    // Last wins, and the last name codex gave is one there is nothing to show
    // for. Keeping the older name would be showing a name codex has replaced.
    const renamed = [
      SESSION_INDEX.trim(),
      SESSION_INDEX.trim().replace(
        '"thread_name":"Reply with pineapple"',
        '"thread_name":"\\u202e"',
      ),
    ].join('\n');

    expect(parseCodexSessionIndex(renamed).has('01a09386-f378-7b23-83a7-6c263ed59701')).toBe(false);
  });

  it('is empty for a store where codex has named nothing', () => {
    expect(parseCodexSessionIndex('').size).toBe(0);
  });
});
