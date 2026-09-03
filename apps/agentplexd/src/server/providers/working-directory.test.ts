import { storeDescriptorSchema } from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import { parseWorkingDirectory } from './working-directory.js';

const STORE = storeDescriptorSchema.parse({ storeId: 'store-a', path: '/volumes/claude' });

const problem = (result: ReturnType<typeof parseWorkingDirectory>): string =>
  result.ok ? '' : result.problem;

describe('parseWorkingDirectory', () => {
  it('accepts an absolute path outside the store', () => {
    expect(parseWorkingDirectory('/Users/dev/Code/agentplex', STORE)).toEqual({
      ok: true,
      cwd: '/Users/dev/Code/agentplex',
    });
  });

  it('normalises before answering, so the path checked is the path opened', () => {
    expect(parseWorkingDirectory('/Users/dev/Code/../Code/agentplex/', STORE)).toEqual({
      ok: true,
      cwd: '/Users/dev/Code/agentplex',
    });
  });

  it('refuses a session that has no working directory at all', () => {
    // What discovery reports for a session whose provider never wrote one down.
    // A guess — the store, the home directory, wherever agentplexd was started
    // — would resume the session somewhere it has never run.
    expect(parseWorkingDirectory(null, STORE).ok).toBe(false);
    expect(parseWorkingDirectory('   ', STORE).ok).toBe(false);
  });

  it('refuses a relative path', () => {
    const result = parseWorkingDirectory('Code/agentplex', STORE);

    expect(result.ok).toBe(false);
    expect(problem(result)).toContain('absolute');
  });

  it('refuses a path with a null byte in it', () => {
    // The syscall stops at the NUL, so the directory opened is a prefix of the
    // one that passed the check.
    const result = parseWorkingDirectory('/Users/dev/Code\0/../../etc', STORE);

    expect(result.ok).toBe(false);
    expect(problem(result)).toContain('null byte');
  });

  it('refuses the store itself', () => {
    const result = parseWorkingDirectory('/volumes/claude', STORE);

    expect(result.ok).toBe(false);
    expect(problem(result)).toContain('inside the store');
  });

  it('refuses a directory inside the store', () => {
    // The rule that carries over from v1: a store holds the provider's own
    // state, and an agent running there would be editing the transcripts
    // agentplex reads to find out what the agent is doing.
    expect(parseWorkingDirectory('/volumes/claude/projects', STORE).ok).toBe(false);
  });

  it('refuses a path that climbs into the store rather than naming it', () => {
    expect(parseWorkingDirectory('/volumes/claude/../claude/projects', STORE).ok).toBe(false);
  });

  it('allows a sibling whose name merely starts with the store path', () => {
    // A string prefix test would call this one a child of the store. It is not
    // one, and refusing it would take a real directory away for no reason.
    expect(parseWorkingDirectory('/volumes/claude-work', STORE)).toEqual({
      ok: true,
      cwd: '/volumes/claude-work',
    });
  });
});
