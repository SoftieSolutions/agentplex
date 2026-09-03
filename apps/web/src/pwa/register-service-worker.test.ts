import { describe, expect, it } from 'vitest';
import { registerServiceWorker } from './register-service-worker.js';

describe('registerServiceWorker', () => {
  it('registers /sw.js with the injected registrar', () => {
    const urls: string[] = [];
    registerServiceWorker({
      register: (url) => {
        urls.push(url);
        return Promise.resolve(undefined);
      },
    });
    expect(urls).toEqual(['/sw.js']);
  });

  it('does nothing when the browser offers no registrar: degraded, not broken', () => {
    expect(() => {
      registerServiceWorker(undefined);
    }).not.toThrow();
  });

  it('swallows a refused registration instead of surfacing an unhandled rejection', async () => {
    registerServiceWorker({
      register: () => Promise.reject(new Error('storage disabled')),
    });
    // Let the rejection settle; vitest fails the run on any unhandled
    // rejection, so reaching the assertion below is the test.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(true).toBe(true);
  });
});
