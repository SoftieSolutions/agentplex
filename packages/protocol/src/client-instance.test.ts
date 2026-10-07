import { describe, expect, it } from 'vitest';
import { clientInstanceSchema } from './client-instance.js';

describe('clientInstanceSchema', () => {
  it('accepts sixteen bytes written as 32 lowercase hex digits', () => {
    const hex = '0123456789abcdef0123456789abcdef';
    expect(clientInstanceSchema.parse(hex)).toBe(hex);
  });

  it.each([
    ['empty', ''],
    ['31 digits', '0123456789abcdef0123456789abcde'],
    ['33 digits', '0123456789abcdef0123456789abcdef0'],
    ['uppercase', '0123456789ABCDEF0123456789ABCDEF'],
    ['not hex', '0123456789abcdef0123456789abcdeg'],
    ['padded', ' 0123456789abcdef0123456789abcde'],
  ])('refuses %s', (_label, raw) => {
    expect(clientInstanceSchema.safeParse(raw).success).toBe(false);
  });

  it('refuses a value that is not a string', () => {
    expect(clientInstanceSchema.safeParse(42).success).toBe(false);
    expect(clientInstanceSchema.safeParse(null).success).toBe(false);
  });
});
