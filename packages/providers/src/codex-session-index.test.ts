import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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

  it('is empty for a store where codex has named nothing', () => {
    expect(parseCodexSessionIndex('').size).toBe(0);
  });
});
