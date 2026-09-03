/**
 * Minimal, honest service worker.
 *
 * Its jobs are exactly two: make the app installable, and keep the last shell
 * the network actually served available when the network is gone. Strategy is
 * network-first for navigations only — while the hub is reachable the browser
 * always gets the live shell, so a deploy is never masked by a silently stale
 * cache. Assets are fingerprinted by the vite build and need no worker to be
 * cache-correct; the worker leaves them alone.
 *
 * The cache name is versioned so a future strategy change can abandon old
 * entries in activate rather than trusting them.
 */

const SHELL_CACHE = 'agentplex-shell-v1';
const SHELL_URL = '/';

self.addEventListener('install', () => {
  // Take over on the next load instead of waiting for every tab to close.
  // Safe because nothing here serves stale content while online.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== SHELL_CACHE).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  // Navigations only. Fingerprinted assets and API traffic go straight to the
  // network exactly as if no worker existed.
  if (event.request.mode !== 'navigate') {
    return;
  }
  event.respondWith(shellNetworkFirst(event.request));
});

async function shellNetworkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(SHELL_URL, response.clone());
    }
    return response;
  } catch (error) {
    // Offline: serve the last shell the network really produced, if any.
    // No cached shell means the failure surfaces as the browser's own error
    // page, which over-claims nothing.
    const cached = await caches.match(SHELL_URL);
    if (cached !== undefined) {
      return cached;
    }
    throw error;
  }
}
