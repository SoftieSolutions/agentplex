import { describe, expect, it } from 'vitest';
import { fakeStorage } from '../auth/fake-storage.js';
import { clampSidebarWidth, createSidebarWidth, sidebarMaxFor } from './sidebar-width.js';

const KEY = 'agentplex.sidebarWidth';

/** A browser that refuses site data: the property access itself throws. */
function refusing(): Storage {
  throw new Error('SecurityError: the operation is insecure');
}

describe('the widest the sidebar may be drawn', () => {
  it('leaves the content region what the breakpoint leaves it, between the two bounds', () => {
    // At the breakpoint itself the sidebar is as narrow as it gets, and every
    // pixel the window gains past it is a pixel the sidebar may take, up to
    // the cap.
    expect(sidebarMaxFor(768)).toBe(240);
    expect(sidebarMaxFor(900)).toBe(372);
    expect(sidebarMaxFor(1008)).toBe(480);
    expect(sidebarMaxFor(1440)).toBe(480);
  });

  it('never asks for less than the narrowest sidebar, even below the breakpoint', () => {
    expect(sidebarMaxFor(500)).toBe(240);
  });
});

describe('the sidebar width', () => {
  it('is the default on a device that never chose one', () => {
    const width = createSidebarWidth({ storage: () => fakeStorage() });
    expect(width.read()).toBe(240);
  });

  it('reads a word it did not write as the default', () => {
    // What is on disk is a claim. Only a whole number of pixels is a width.
    for (const word of ['abc', '300.5', '', '-300', ' 300', '3e2']) {
      const width = createSidebarWidth({ storage: () => fakeStorage({ [KEY]: word }) });
      expect(width.read(), word).toBe(240);
    }
  });

  it('reads the default when the storage access throws', () => {
    const width = createSidebarWidth({ storage: refusing });
    expect(width.read()).toBe(240);
  });

  it('reads a stored width, clamped into the bounds', () => {
    const read = (word: string): number =>
      createSidebarWidth({ storage: () => fakeStorage({ [KEY]: word }) }).read();
    expect(read('300')).toBe(300);
    expect(read('100')).toBe(240);
    expect(read('0')).toBe(240);
    expect(read('9999')).toBe(480);
    // A digit string long enough to parse to Infinity is still a number the
    // clamp can bound.
    expect(read('9'.repeat(400))).toBe(480);
  });

  it('stores what it is set to, and tells its listeners once', () => {
    const storage = fakeStorage();
    const width = createSidebarWidth({ storage: () => storage });
    let heard = 0;
    width.subscribe(() => {
      heard += 1;
    });
    expect(width.set(320)).toBe(true);
    expect(storage.getItem(KEY)).toBe('320');
    expect(width.read()).toBe(320);
    expect(heard).toBe(1);
  });

  it('stores a width past the cap as the cap', () => {
    const storage = fakeStorage();
    const width = createSidebarWidth({ storage: () => storage });
    width.set(1000);
    expect(storage.getItem(KEY)).toBe('480');
    expect(width.read()).toBe(480);
  });

  it('stores a fractional width as the whole width it rounds to', () => {
    // A pointer reports fractions; the stored word is digits only, so a
    // fraction written as it came would read back as the default.
    const storage = fakeStorage();
    const width = createSidebarWidth({ storage: () => storage });
    width.set(300.6);
    expect(storage.getItem(KEY)).toBe('301');
    expect(width.read()).toBe(301);
  });

  it('clamps what is not a number to the default', () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(240);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(480);
  });

  it('holds a width for this page when the browser refuses to store it', () => {
    const width = createSidebarWidth({ storage: refusing });
    expect(width.set(320)).toBe(false);
    expect(width.read()).toBe(320);
  });

  it('stops telling a listener that left', () => {
    const width = createSidebarWidth({ storage: () => fakeStorage() });
    let staying = 0;
    let leaving = 0;
    width.subscribe(() => {
      staying += 1;
    });
    const unsubscribe = width.subscribe(() => {
      leaving += 1;
    });
    width.set(300);
    unsubscribe();
    width.set(320);
    expect([staying, leaving]).toEqual([2, 1]);
  });
});
