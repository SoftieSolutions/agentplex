import { createBrowserDependencies } from '../store/browser.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';

/**
 * The one hub store the page holds. A lazy singleton rather than a React
 * context: the store's lifecycle is already governed by its own subscriber
 * count (the first subscriber dials, the last one leaving hangs up), so all
 * a provider would add is a second place for that lifecycle to be wrong.
 *
 * The seams `createBrowserDependencies` leaves open — how a terminal
 * keystroke and a session subscription go on the wire — stay open here too:
 * the protocol has no frames for either yet, and the store says so in words
 * when asked to send. Filling them is the terminal-frames protocol ticket.
 */

/**
 * Where the client token lives until the settings ticket builds the screen
 * that manages it. Read per ticket exchange, so pasting a token into
 * localStorage and reloading is a working setup path today.
 */
export const CLIENT_TOKEN_STORAGE_KEY = 'agentplex.client-token';

function readStoredToken(): string {
  try {
    return window.localStorage.getItem(CLIENT_TOKEN_STORAGE_KEY) ?? '';
  } catch {
    // Storage can be denied wholesale; an empty token fails the exchange
    // with the hub's ordinary 401, which the store already words.
    return '';
  }
}

let singleton: HubStore | null = null;

export function appHubStore(): HubStore {
  singleton ??= createHubStore(createBrowserDependencies({ readToken: readStoredToken }));
  return singleton;
}
