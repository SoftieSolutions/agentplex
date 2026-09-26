/**
 * Minimal, honest service worker.
 *
 * Its jobs are exactly three: make the app installable, keep the last shell
 * the network actually served available when the network is gone, and be the
 * part of this app that is awake when nobody is looking — the push section at
 * the bottom, which is the only thing here that reaches a person who has the
 * page shut.
 *
 * Shell strategy is network-first for navigations only, with a deadline. While
 * the hub answers within `SHELL_NETWORK_TIMEOUT_MS` the browser gets the live
 * shell. A stale shell is served only when the network misses that deadline
 * and a previous visit left one behind; the late response still replaces it
 * in the cache, so the next load is current. Assets are fingerprinted by the
 * vite build and need no worker to be cache-correct; the worker leaves them
 * alone.
 *
 * The accepted risk: on a link slower than the deadline right after a deploy,
 * the old shell may name fingerprinted assets the hub no longer has
 * (`apps/hub/src/web/web.ts` serves only the current build's), and the page
 * fails to load them until the late response has updated the cache and the
 * person reloads. The alternative is a phone that shows a blank screen for as
 * long as a sleeping laptop's TCP retry takes, on every open.
 *
 * The cache name is versioned so a future strategy change can abandon old
 * entries in activate rather than trusting them. Push is not such a change:
 * nothing below reads or writes a cache, so `SHELL_CACHE` keeps the name it
 * has. Bumping it would throw away somebody's offline shell on the next
 * activate in exchange for nothing.
 *
 * This file is outside the module graph — a classic worker registered as
 * `/sw.js`, importing nothing and imported by nothing, so `tsc` never sees it.
 * `src/pwa/service-worker.test.ts` is what stands in for that: it reads this
 * file and runs it against a fake `self`, `registration`, `clients` and
 * `caches`. The functions below are named and small so that suite can reach
 * them, and `sessionHashFor` is pinned there against the app's own
 * `sessionHash`, which this file may not import.
 */

const SHELL_CACHE = 'agentplex-shell-v1';
const SHELL_URL = '/';

/**
 * How long a navigation waits on the network before a cached shell is served.
 *
 * A hub on the LAN answers a navigation in well under a second. Three seconds
 * covers a laptop's first TCP retry after waking from sleep, when the socket
 * it had is dead and the next one has not yet been tried. Much longer than
 * that reads as a hang to a person standing with a phone in hand.
 */
const SHELL_NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', () => {
  // Take over on the next load instead of waiting for every tab to close.
  // Safe because nothing here serves stale content while the hub answers in
  // time, and a stale shell served past the deadline is replaced behind it.
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
  const network = fetchShell(event.request);
  // Kept alive past the response: when the cached shell wins the race, the
  // network's late answer still has to reach the cache, and a worker the
  // browser may stop once `respondWith` settles is only held open by
  // `waitUntil`. Its failure is swallowed here because the navigation below
  // reports it; this branch exists only to finish the write.
  event.waitUntil(network.catch(() => undefined));
  event.respondWith(shellNetworkFirst(network));
});

/** The live shell, written to the cache before it is handed on when it is good. */
async function fetchShell(request) {
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(SHELL_CACHE);
    await cache.put(SHELL_URL, response.clone());
  }
  return response;
}

/** What the deadline resolves to, so the race can tell it from any response. */
const DEADLINE_PASSED = Symbol('deadline passed');

async function shellNetworkFirst(network) {
  let timer;
  // Scheduled before the first await, so the deadline counts from the
  // navigation and not from whenever this function next runs.
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(DEADLINE_PASSED), SHELL_NETWORK_TIMEOUT_MS);
  });
  const stopDeadline = () => clearTimeout(timer);
  network.then(stopDeadline, stopDeadline);
  try {
    const first = await Promise.race([network, deadline]);
    if (first !== DEADLINE_PASSED) {
      return first;
    }
    // Too slow: the last shell the network produced, if there is one. The
    // response still on its way updates the cache when it lands.
    const cached = await caches.match(SHELL_URL);
    if (cached !== undefined) {
      return cached;
    }
    // Nothing cached means nothing better to show than whatever the network
    // eventually says, so keep waiting on it rather than fail early.
    return await network;
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

/**
 * Push: one session has newly started wanting a human, said on a lock screen.
 *
 * The hub decides when (apps/hub/src/push/attention-edge.ts) and what
 * may be said (apps/hub/src/push/push.ts). What arrives here is
 * `{ title, body, data: { storeId, sessionId } }`, where `title` is the
 * provider and `body` is the status in words -- or, for a graph run waiting
 * on a person, `{ title, body, data: { graph } }`, where `body` names the run
 * and the node and `graph` is the graph's tree node. Nothing else is in either
 * by design: a session's title, its working directory and its branch, and a
 * run's request text, are the fields that would put a proposal or a path on a
 * screen somebody else can read, and the hub never sends them.
 *
 * What this file decides is only how those words are shown. The notification's
 * own title is the app, not the provider, because a notification arrives with
 * no page around it and the first question it has to answer is which program
 * is asking for you; the hub's two words then read as one sentence underneath
 * — "claude awaiting permission". So nothing is invented here and nothing the
 * hub sent is dropped.
 */

/**
 * Restated from `src/pwa/manifest.ts`, which this file may not import: a
 * classic worker has no module graph. It is deliberately the same word as the
 * installed app's name, because a notification titled anything else would be
 * from a program the person does not remember installing.
 */
const APP_NAME = 'agentplex';

/**
 * What a notification says when the payload is not one we can read.
 *
 * It exists because a push that shows nothing is worse than a vague one: the
 * browsers that enforce this revoke the permission after a few silent pushes,
 * so the honest degraded answer is to say the true but unspecific thing and
 * send the tap to the app's front door.
 */
const GENERIC_BODY = 'a session wants you';

/** The tag a generic notification carries: one, so vague ones never stack. */
const GENERIC_TAG = APP_NAME;

/** The app's session address, spelled exactly as `src/terminal/session-route.ts` spells it. */
const SESSION_PREFIX = '#/session/';
/** Restated from `src/graphs/graph-route.ts`, for the same reason. */
const GRAPH_PREFIX = '#/graph/';

self.addEventListener('push', (event) => {
  // Nothing in this path is allowed to throw or to reject: every payload,
  // including one that is not JSON at all, has to end in a notification.
  const notification = notificationFor(readPayload(event.data));
  event.waitUntil(self.registration.showNotification(notification.title, notification.options));
});

self.addEventListener('notificationclick', (event) => {
  // Closed first and unconditionally. A notification the browser leaves up
  // after a tap is one the person taps again.
  event.notification.close();
  event.waitUntil(openApp(addressFor(targetIn(event.notification.data))));
});

/** The payload as JSON, or `null` for anything that is not readable as such. */
function readPayload(data) {
  if (data === null || data === undefined) {
    return null;
  }
  try {
    return data.json();
  } catch {
    // A push with no body, or a body that is not JSON. Not ours, but ours to
    // show something for.
    return null;
  }
}

/**
 * The notification one payload becomes: a title, and the options the browser
 * is handed. Total — every input has an answer, including `null`.
 */
function notificationFor(payload) {
  const words = displayWords(payload);
  const target = targetIn(payload === null || typeof payload !== 'object' ? null : payload.data);
  if (words === null || target === null) {
    return { title: APP_NAME, options: { body: GENERIC_BODY, tag: GENERIC_TAG, data: null } };
  }
  return {
    title: APP_NAME,
    options: {
      body: words,
      // Tagged per subject, so the second prompt from one session -- or the
      // second request from one graph -- replaces the first instead of
      // stacking. The address is already one string per subject and already
      // unique, so it is the tag rather than a second spelling of the same fact.
      tag: hashFor(target),
      // Carried so the tap knows where to go: the ids and nothing else.
      data: target.data,
    },
  };
}

/**
 * What a payload or a notification is about: a session, a graph, or nothing
 * this worker can address. Parsed and never assumed, for the reason
 * `sessionRefIn` gives; the graph's id is one non-empty string.
 */
function targetIn(data) {
  const ref = sessionRefIn(data);
  if (ref !== null) {
    return { kind: 'session', data: ref };
  }
  if (data === null || typeof data !== 'object') {
    return null;
  }
  const { graph } = data;
  if (typeof graph !== 'string' || graph === '') {
    return null;
  }
  return { kind: 'graph', data: { graph } };
}

/** The app's address for whatever a notification is about. */
function hashFor(target) {
  return target.kind === 'session'
    ? sessionHashFor(target.data)
    : `${GRAPH_PREFIX}${encodeURIComponent(target.data.graph)}`;
}

/** The hub's two display fields as one line, or `null` if either is missing. */
function displayWords(payload) {
  if (payload === null || typeof payload !== 'object') {
    return null;
  }
  if (typeof payload.title !== 'string' || typeof payload.body !== 'string') {
    return null;
  }
  const words = `${payload.title} ${payload.body}`.trim();
  return words === '' ? null : words;
}

/**
 * The session a payload or a notification names, parsed and never assumed.
 *
 * This is the one place a claim from the network becomes an address, so it
 * checks rather than trusts: an object, two non-empty strings, and nothing
 * taken on faith about what the other end sent.
 */
function sessionRefIn(data) {
  if (data === null || typeof data !== 'object') {
    return null;
  }
  const { storeId, sessionId } = data;
  if (typeof storeId !== 'string' || storeId === '') {
    return null;
  }
  if (typeof sessionId !== 'string' || sessionId === '') {
    return null;
  }
  return { storeId, sessionId };
}

/**
 * The app's address for a session.
 *
 * The original is `sessionHash` in `src/terminal/session-route.ts`. It is
 * restated here because a classic worker can import nothing from the bundle,
 * and the two are held together by `src/pwa/service-worker.test.ts`, which
 * reads this function out of the loaded worker and compares it with that one
 * over ids that need escaping. A tap that arrived at an address the app's
 * parser rejects would open the placeholder screen and look like a lost push.
 */
function sessionHashFor(ref) {
  return `${SESSION_PREFIX}${encodeURIComponent(ref.storeId)}/${encodeURIComponent(ref.sessionId)}`;
}

/** Where a tap goes: the session or the graph, or the app's front door when there is neither. */
function addressFor(target) {
  return target === null ? '/' : `/${hashFor(target)}`;
}

/**
 * Brings the app up at `address`: the window already open, or a new one.
 *
 * Reusing a window is the point rather than an optimisation. The app holds a
 * live socket and an emulator per session, and a tap that opened a second copy
 * would leave the person with two of both and the one they were using behind
 * the one they were not.
 */
async function openApp(address) {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const existing = windows.filter(isThisOrigin)[0];
  if (existing === undefined) {
    await self.clients.openWindow(address);
    return;
  }
  const navigated = await navigateTo(existing, address);
  // `navigate` resolves with `null` when the client is already gone, and the
  // one we started from is then still the best thing to focus.
  await (navigated ?? existing).focus();
}

/**
 * Whether a window is this app's.
 *
 * A worker's client list is scoped to its own origin already; this says so at
 * the point where it matters anyway, because the alternative to being wrong
 * here is navigating somebody else's page from a notification.
 */
function isThisOrigin(client) {
  try {
    return new URL(client.url).origin === self.location.origin;
  } catch {
    return false;
  }
}

/** Navigates a client, or answers `null` when the browser refuses to. */
async function navigateTo(client, address) {
  try {
    return await client.navigate(address);
  } catch {
    // Some browsers refuse to navigate a client this worker does not control.
    // The window is then focused where it stands: the person gets the app they
    // asked for, one hop from the session, which is a smaller failure than the
    // second window the alternative would open.
    return null;
  }
}
