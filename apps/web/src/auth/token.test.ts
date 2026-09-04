import { afterEach, describe, expect, it } from 'vitest';
import { HUB_TOKEN_STORAGE_KEY, readHubToken } from './token.js';

/**
 * The tests run under Node, where `window` does not exist at all -- which is
 * exactly the shape of the browser contexts the guard is for (a private
 * window, a blocked-storage policy): the access itself throws before any key
 * is asked for.
 */

interface WindowStub {
  localStorage: Pick<Storage, 'getItem'>;
}

const globals = globalThis as { window?: WindowStub };

afterEach(() => {
  delete globals.window;
});

describe('readHubToken', () => {
  it('answers null when touching storage throws', () => {
    expect(readHubToken()).toBeNull();
  });

  it('answers null when nothing is stored', () => {
    globals.window = { localStorage: { getItem: () => null } };
    expect(readHubToken()).toBeNull();
  });

  it('reads the stored token by its one agreed key', () => {
    globals.window = {
      localStorage: {
        getItem: (key) => (key === HUB_TOKEN_STORAGE_KEY ? 'the-token' : null),
      },
    };
    expect(readHubToken()).toBe('the-token');
  });

  it('answers null when the lookup itself throws', () => {
    globals.window = {
      localStorage: {
        getItem: () => {
          throw new Error('storage is blocked');
        },
      },
    };
    expect(readHubToken()).toBeNull();
  });
});
