import { describe, expect, it } from 'vitest';
import { fakeStorage } from '../auth/fake-storage.js';
import { createMockSwitch } from './mock-switch.js';

const KEY = 'agentplex.mock';

/** A browser that refuses site data: the property access itself throws. */
function refusing(): Storage {
  throw new Error('SecurityError: the operation is insecure');
}

describe('the mock switch', () => {
  it('is off on a device that never turned it on', () => {
    const mock = createMockSwitch({ storage: () => fakeStorage(), search: () => '' });
    expect(mock.read()).toBe(false);
  });

  it('keeps "on" as the one word it writes, and tells its listeners', () => {
    const storage = fakeStorage();
    const mock = createMockSwitch({ storage: () => storage, search: () => '' });
    let heard = 0;
    mock.subscribe(() => {
      heard += 1;
    });
    expect(mock.set(true)).toBe(true);
    expect(mock.read()).toBe(true);
    expect(storage.getItem(KEY)).toBe('on');
    expect(heard).toBe(1);
  });

  it('reads a stored "on" from an earlier page', () => {
    const mock = createMockSwitch({
      storage: () => fakeStorage({ [KEY]: 'on' }),
      search: () => '',
    });
    expect(mock.read()).toBe(true);
  });

  it('turns off by forgetting the word, and stops telling a listener that left', () => {
    const storage = fakeStorage({ [KEY]: 'on' });
    const mock = createMockSwitch({ storage: () => storage, search: () => '' });
    let staying = 0;
    let leaving = 0;
    mock.subscribe(() => {
      staying += 1;
    });
    const unsubscribe = mock.subscribe(() => {
      leaving += 1;
    });
    expect(mock.set(false)).toBe(true);
    expect(mock.read()).toBe(false);
    expect(storage.getItem(KEY)).toBeNull();
    unsubscribe();
    mock.set(true);
    expect([staying, leaving]).toEqual([2, 1]);
  });

  it('reads a word it did not write as off', () => {
    // What is on disk is a claim. Only "on" means on: sample data shown
    // because of a stray value would be the app inventing facts, which is the
    // direction a misread must not go.
    for (const word of ['yes', '1', 'true', 'ON', '', 'garbage']) {
      const mock = createMockSwitch({
        storage: () => fakeStorage({ [KEY]: word }),
        search: () => '',
      });
      expect(mock.read(), word).toBe(false);
    }
  });

  it('reads off when the storage access throws, and still turns on for this page', () => {
    const mock = createMockSwitch({ storage: refusing, search: () => '' });
    expect(mock.read()).toBe(false);
    expect(mock.set(true)).toBe(false);
    expect(mock.read()).toBe(true);
  });

  it('holds off for this page when storage refuses to forget an earlier "on"', () => {
    // The page flag is three-valued for this case: "off" chosen here outranks
    // an "on" the browser will not let go of.
    const storage = fakeStorage({ [KEY]: 'on' });
    let refuse = false;
    const mock = createMockSwitch({
      storage: () => (refuse ? refusing() : storage),
      search: () => '',
    });
    expect(mock.read()).toBe(true);
    refuse = true;
    expect(mock.set(false)).toBe(false);
    expect(mock.read()).toBe(false);
  });

  it('turns on and persists from ?mock=1, as flipping the toggle would', () => {
    const storage = fakeStorage();
    const mock = createMockSwitch({ storage: () => storage, search: () => '?mock=1' });
    expect(mock.read()).toBe(true);
    expect(storage.getItem(KEY)).toBe('on');
  });

  it('turns on for this page from ?mock=1 when storage refuses', () => {
    const mock = createMockSwitch({ storage: refusing, search: () => '?foo=bar&mock=1' });
    expect(mock.read()).toBe(true);
  });

  it('reads the address once, when it is built', () => {
    let reads = 0;
    const mock = createMockSwitch({
      storage: () => fakeStorage(),
      search: () => {
        reads += 1;
        return '?mock=1';
      },
    });
    mock.set(false);
    expect(mock.read()).toBe(false);
    expect(reads).toBe(1);
  });

  it('changes nothing for any other value of the parameter', () => {
    // The parameter only turns the switch on; off is the toggle. So ?mock=0
    // leaves a stored "on" alone, and a word it does not know is no word.
    for (const search of ['?mock=0', '?mock=yes', '?mock=', '?mock', '?mocks=1']) {
      const empty = fakeStorage();
      expect(createMockSwitch({ storage: () => empty, search: () => search }).read(), search).toBe(
        false,
      );
      expect(empty.getItem(KEY), search).toBeNull();

      const on = fakeStorage({ [KEY]: 'on' });
      expect(createMockSwitch({ storage: () => on, search: () => search }).read(), search).toBe(
        true,
      );
      expect(on.getItem(KEY), search).toBe('on');
    }
  });

  it('reads off when the address itself cannot be read', () => {
    const mock = createMockSwitch({
      storage: () => fakeStorage(),
      search: () => {
        throw new Error('no location here');
      },
    });
    expect(mock.read()).toBe(false);
  });
});
