import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readAbsolutePaths, readFlags, readPort, settingValue } from './settings.js';

const KNOWN = ['--port', '--store-path'];

describe('readFlags', () => {
  it('accepts both spellings of a flag', () => {
    const result = readFlags(['--port=1', '--store-path', '/a'], KNOWN);

    expect(result).toEqual({
      ok: true,
      values: new Map([
        ['--port', ['1']],
        ['--store-path', ['/a']],
      ]),
    });
  });

  it('keeps every occurrence, because one flag is a list', () => {
    const result = readFlags(['--store-path', '/a', '--store-path=/b'], KNOWN);

    expect(result.ok && result.values.get('--store-path')).toEqual(['/a', '/b']);
  });

  it('refuses an unknown flag rather than silently ignoring a typo', () => {
    const result = readFlags(['--prot=1'], KNOWN);

    expect(result).toEqual({ ok: false, problems: ['unknown argument: --prot=1'] });
  });

  it('refuses a flag left without a value, and reports every problem at once', () => {
    const result = readFlags(['--port', '--store-path', '--nope'], KNOWN);

    expect(result.ok ? [] : result.problems).toEqual([
      '--port needs a value',
      '--store-path needs a value',
      'unknown argument: --nope',
    ]);
  });
});

describe('settingValue', () => {
  const setting = { flag: '--port', env: 'PORT' };

  it('lets a flag win over the environment, because a flag was just typed', () => {
    expect(settingValue(new Map([['--port', ['1', '2']]]), { PORT: '9' }, setting)).toBe('2');
  });

  it('falls back to the environment', () => {
    expect(settingValue(new Map(), { PORT: ' 9 ' }, setting)).toBe('9');
  });

  it('treats an empty environment variable as absent, not as an empty value', () => {
    expect(settingValue(new Map(), { PORT: '   ' }, setting)).toBeUndefined();
  });
});

describe('readPort', () => {
  it('takes the default when nothing is given', () => {
    const problems: string[] = [];
    expect(readPort(undefined, '--port', 8080, problems)).toBe(8080);
    expect(problems).toEqual([]);
  });

  it('refuses a port outside the range instead of letting bind fail later', () => {
    const problems: string[] = [];
    readPort('70000', '--port', 8080, problems);
    readPort('eight', '--port', 8080, problems);
    expect(problems).toHaveLength(2);
    expect(problems[1]).toContain('port number');
  });
});

describe('readAbsolutePaths', () => {
  const setting = { flag: '--store-path' };

  it('splits the environment variable on the path delimiter and drops empty segments', () => {
    const problems: string[] = [];
    const paths = readAbsolutePaths(setting, undefined, `/a${delimiter}${delimiter}/b/`, problems);
    expect(paths).toEqual(['/a', '/b']);
    expect(problems).toEqual([]);
  });

  it('lets flags replace the environment rather than adding to it', () => {
    expect(readAbsolutePaths(setting, ['/c'], '/a', [])).toEqual(['/c']);
  });

  it('refuses a relative path, which means nothing to a service started from anywhere', () => {
    const problems: string[] = [];
    expect(readAbsolutePaths(setting, ['relative'], undefined, problems)).toEqual([]);
    expect(problems[0]).toContain('absolute');
  });

  it('normalizes so the same directory named twice is listed once', () => {
    expect(readAbsolutePaths(setting, ['/a/', '/b/../a'], undefined, [])).toEqual(['/a']);
  });

  it('tells a flag given no path from a trailing delimiter in the environment', () => {
    const problems: string[] = [];
    readAbsolutePaths(setting, [' '], undefined, problems);
    expect(problems).toEqual(['--store-path needs a path']);
  });
});
