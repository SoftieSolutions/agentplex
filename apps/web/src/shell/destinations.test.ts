import { describe, expect, it } from 'vitest';
import { destinationHash, NAV, parseDestinationHash } from './destinations.js';

/**
 * What an address means to the shell, and what the shell is willing to draw a
 * way to. Both are decided here rather than in a component, so neither needs a
 * DOM to be pinned.
 */

describe('the destination an address names', () => {
  it('reads back every address the shell writes', () => {
    expect(parseDestinationHash(destinationHash('settings'))).toBe('settings');
    expect(parseDestinationHash(destinationHash('sessions'))).toBe('sessions');
  });

  it('opens on the session list, which is what an empty hash means', () => {
    expect(parseDestinationHash('')).toBe('sessions');
    expect(parseDestinationHash('#')).toBe('sessions');
  });

  it('answers the session list for an address it does not recognize', () => {
    // Typed, pasted, or left over from a version of the app that had a place
    // this one does not. None of them is an error; all of them are the list.
    expect(parseDestinationHash('#/graphs')).toBe('sessions');
    expect(parseDestinationHash('#/settings/pairing')).toBe('sessions');
    expect(parseDestinationHash('#/session/store-1/session-1')).toBe('sessions');
  });
});

describe('the nav at the foot of the sidebar', () => {
  it('offers only destinations that exist', () => {
    expect(NAV.map((entry) => entry.destination)).toEqual(['settings']);
  });

  it('draws nothing for graphs or the library, which are not built', () => {
    expect(NAV.map((entry) => entry.label)).not.toContain('Graphs');
    expect(NAV.map((entry) => entry.label)).not.toContain('Library');
  });
});
