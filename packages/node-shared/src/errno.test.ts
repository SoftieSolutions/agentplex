import { describe, expect, it } from 'vitest';
import { errnoCode, isErrno } from './errno.js';

function withCode(code: unknown): Error {
  return Object.assign(new Error('boom'), { code });
}

describe('errnoCode', () => {
  it('reads the string code an Error carries', () => {
    expect(errnoCode(withCode('ENOENT'))).toBe('ENOENT');
  });

  it('reads it off a plain object too, because a thrown value need not be an Error', () => {
    expect(errnoCode({ code: 'EACCES' })).toBe('EACCES');
  });

  it('refuses a code that is not a string', () => {
    expect(errnoCode(withCode(1))).toBeUndefined();
  });

  it('refuses an Error with no code', () => {
    expect(errnoCode(new Error('boom'))).toBeUndefined();
  });

  it('refuses a value that is not an object', () => {
    expect(errnoCode('ENOENT')).toBeUndefined();
    expect(errnoCode(undefined)).toBeUndefined();
  });

  it('refuses null', () => {
    expect(errnoCode(null)).toBeUndefined();
  });
});

describe('isErrno', () => {
  it('is true for the code it names', () => {
    expect(isErrno(withCode('ENOENT'), 'ENOENT')).toBe(true);
  });

  it('is false for another code', () => {
    expect(isErrno(withCode('EACCES'), 'ENOENT')).toBe(false);
  });

  it('is false for a value with no code', () => {
    expect(isErrno(new Error('ENOENT'), 'ENOENT')).toBe(false);
    expect(isErrno(null, 'ENOENT')).toBe(false);
  });
});
