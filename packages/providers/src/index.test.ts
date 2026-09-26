import { describe, expect, it } from 'vitest';

/**
 * The server grant store is the server's own state, with one consumer, so it
 * lives in apps/server and not here. Object.keys sees only runtime exports, so
 * a type-only export slips past this check; the case-insensitive match catches
 * the constants and schemas as well as the functions.
 */
describe('the providers surface', () => {
  it('exports nothing about server grants', async () => {
    const entry = await import('./index.js');
    expect(Object.keys(entry).filter((name) => /grant/i.test(name))).toEqual([]);
  });

  it('exports no grant fakes from its testing entry', async () => {
    const testing = await import('./testing.js');
    expect(Object.keys(testing).filter((name) => /grant/i.test(name))).toEqual([]);
  });
});
