import { describe, expect, it } from 'vitest';
import { firstLine } from './text.js';

describe('firstLine', () => {
  it('keeps only the first line of several', () => {
    expect(firstLine('fatal: not a git repository\nusage: git status')).toBe(
      'fatal: not a git repository',
    );
  });

  it('returns a single line whole', () => {
    expect(firstLine('2.1.0 (Claude Code)')).toBe('2.1.0 (Claude Code)');
  });

  it('returns an empty string for empty input, so a caller can supply its own fallback', () => {
    expect(firstLine('')).toBe('');
    expect(firstLine(' \n\t\n')).toBe('');
  });

  it('skips leading blank lines and whitespace before the first word', () => {
    expect(firstLine('\n\n  error: denied  \nmore')).toBe('error: denied');
  });

  it('trims the line it returns, carriage return included', () => {
    expect(firstLine('first  \r\nsecond')).toBe('first');
  });
});
