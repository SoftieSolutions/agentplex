import { describe, expect, it } from 'vitest';
import { clearHubToken, createTokenStore, readHubToken, writeHubToken } from './token.js';

/**
 * A stand-in for a localStorage that behaves. The throwing accessors below
 * stand in for the browsers that do not — and the throw sits on the property
 * access itself, because that is where a real privacy-mode browser throws.
 */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const entries = new Map(Object.entries(initial));
  return {
    get length() {
      return entries.size;
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
    clear: () => entries.clear(),
  };
}

describe('the token store', () => {
  it('round-trips a token', () => {
    const storage = fakeStorage();
    const store = createTokenStore(() => storage);
    expect(store.read()).toBeNull();
    expect(store.write('the-hub-token')).toBe(true);
    expect(store.read()).toBe('the-hub-token');
  });

  it('clears a stored token', () => {
    const storage = fakeStorage();
    const store = createTokenStore(() => storage);
    store.write('the-hub-token');
    expect(store.clear()).toBe(true);
    expect(store.read()).toBeNull();
  });

  it('reads an empty stored string as no token', () => {
    // An empty credential authenticates nothing; handing it back as a token
    // would send `Bearer ` to the hub and report the 401 as the hub's fault.
    const store = createTokenStore(() => fakeStorage({ 'agentplex.hubToken': '' }));
    expect(store.read()).toBeNull();
  });

  it('degrades to no token when the storage access itself throws', () => {
    // The privacy-mode shape: `window.localStorage` throws on access, before
    // any getItem could run. The guard must sit on the access, not the read.
    const store = createTokenStore(() => {
      throw new Error('SecurityError: the document is sandboxed');
    });
    expect(store.read()).toBeNull();
    expect(store.write('the-hub-token')).toBe(false);
    expect(store.clear()).toBe(false);
  });

  it('degrades when the storage exists but its methods throw', () => {
    // The quota-exceeded shape: the object is reachable, the write is refused.
    const refusing: Storage = {
      ...fakeStorage(),
      getItem: () => {
        throw new Error('refused');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('refused');
      },
    };
    const store = createTokenStore(() => refusing);
    expect(store.read()).toBeNull();
    expect(store.write('the-hub-token')).toBe(false);
    expect(store.clear()).toBe(false);
  });

  it('the browser-bound functions survive an environment with no window at all', () => {
    // This test process has no `window`; the module-level functions must treat
    // that the way they treat a browser that refuses storage.
    expect(readHubToken()).toBeNull();
    expect(writeHubToken('the-hub-token')).toBe(false);
    expect(clearHubToken()).toBe(false);
  });
});
