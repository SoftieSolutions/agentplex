import { describe, expect, it } from 'vitest';
import { activitySchema, type Activity } from '@agentplex/protocol';
import { activityWords, activityWordsText } from './activity-words.js';

/**
 * Every activity here goes through `activitySchema` rather than being asserted
 * as the union's type. Two of the six kinds are the only ones an adapter emits
 * today, so a hand-built object typed into this file is the one thing that
 * could quietly drift from what the wire actually carries; parsing it here
 * means a widget test fails the day the schema stops accepting the shape it
 * draws.
 */
function parsed(raw: unknown): Activity {
  const result = activitySchema.safeParse(raw);
  if (!result.success)
    throw new Error(`the fixture activity did not parse: ${result.error.message}`);
  return result.data;
}

describe('the words an activity is drawn with', () => {
  it('quotes a command and says nothing else while it is running', () => {
    expect(activityWords(parsed({ kind: 'command', text: 'pnpm test auth' }))).toEqual({
      lead: null,
      quoted: 'pnpm test auth',
      detail: null,
    });
  });

  it('says a non-zero exit status in words, never as a bare number', () => {
    const words = activityWords(parsed({ kind: 'command', text: 'pnpm test', exitStatus: 1 }));
    expect(words.detail).toBe('failed with exit status 1');
    expect(words.detail).not.toBe('1');
  });

  it('says nothing about an exit status of zero, which is what finishing looks like', () => {
    expect(activityWords(parsed({ kind: 'command', text: 'ls', exitStatus: 0 })).detail).toBeNull();
  });

  it('leads an edit with the verb and quotes the path', () => {
    expect(activityWords(parsed({ kind: 'edit', path: 'src/auth/refresh.ts' }))).toEqual({
      lead: 'editing',
      quoted: 'src/auth/refresh.ts',
      detail: null,
    });
  });

  it('spells both edit counts when the adapter has both', () => {
    const words = activityWords(
      parsed({ kind: 'edit', path: 'src/auth/refresh.ts', added: 18, removed: 4 }),
    );
    expect(words.detail).toBe('18 added, 4 removed');
  });

  it('spells one edit count alone, because a missing count is not a zero', () => {
    expect(activityWords(parsed({ kind: 'edit', path: 'a.ts', added: 22 })).detail).toBe(
      '22 added',
    );
    expect(activityWords(parsed({ kind: 'edit', path: 'a.ts', removed: 4 })).detail).toBe(
      '4 removed',
    );
    expect(activityWords(parsed({ kind: 'edit', path: 'a.ts', added: 0 })).detail).toBe('0 added');
  });

  it('counts a test run, and says only what it was told', () => {
    expect(activityWords(parsed({ kind: 'tests', passed: 212, failed: 2 })).lead).toBe(
      '212 passed, 2 failed',
    );
    expect(activityWords(parsed({ kind: 'tests', passed: 212 })).lead).toBe('212 passed');
    expect(activityWords(parsed({ kind: 'tests', failed: 2 })).lead).toBe('2 failed');
  });

  it('says tests are running when it has no count at all', () => {
    expect(activityWords(parsed({ kind: 'tests' }))).toEqual({
      lead: 'running tests',
      quoted: null,
      detail: null,
    });
  });

  it('gives the three text kinds their text and claims nothing over it', () => {
    for (const kind of ['narration', 'approval', 'plain'] as const) {
      expect(activityWords(parsed({ kind, text: 'reading the auth module' }))).toEqual({
        lead: 'reading the auth module',
        quoted: null,
        detail: null,
      });
    }
  });

  it('joins what it says into the one string a search matches', () => {
    expect(activityWordsText(parsed({ kind: 'command', text: 'pnpm test', exitStatus: 1 }))).toBe(
      'pnpm test failed with exit status 1',
    );
    expect(
      activityWordsText(parsed({ kind: 'edit', path: 'src/auth/refresh.ts', added: 18 })),
    ).toBe('editing src/auth/refresh.ts 18 added');
    expect(activityWordsText(parsed({ kind: 'tests', passed: 212, failed: 2 }))).toBe(
      '212 passed, 2 failed',
    );
  });
});
