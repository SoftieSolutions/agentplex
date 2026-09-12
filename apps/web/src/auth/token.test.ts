import { describe, expect, it } from 'vitest';
import { fakeStorage } from './fake-storage.js';
import { browserTokenStore, createTokenStore } from './token.js';

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

  it('the browser-bound store survives an environment with no window at all', () => {
    // This test process has no `window`; the module-level store must treat
    // that the way it treats a browser that refuses storage.
    expect(browserTokenStore.read()).toBeNull();
    expect(browserTokenStore.write('the-hub-token')).toBe(false);
    expect(browserTokenStore.clear()).toBe(false);
  });
});
