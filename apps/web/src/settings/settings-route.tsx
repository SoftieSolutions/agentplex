import type { JSX } from 'react';
import type { TokenStore } from '../auth/token.js';
import type { HubStore } from '../store/hub-store.js';
import { useHubSnapshot } from '../store/use-hub-store.js';
import { discoveredCandidates } from './pairing-form.js';
import { createBrowserPairingOperations, type PairingOperations } from './pairing-operations.js';
import { createBrowserPushOperations, type PushOperations } from './push-operations.js';
import { SettingsScreen } from './settings-screen.js';

/**
 * The settings route: the screen wired to the browser. The hub store and the
 * token store both arrive from the root, because they are the page's one of
 * each: the token this screen writes is read by that store's next ticket
 * exchange, so nothing is rebuilt when it changes. A missing token becomes an
 * empty Bearer header, a 401, and an honest "reconnecting" with the refusal
 * in words -- which is the connection line this screen draws.
 */

/**
 * Pairing over the same store, and therefore over the same socket.
 *
 * Built once per store rather than inside the screen because it belongs to
 * the store's lifetime and not to a component's: a pairing in flight when a
 * render throws away its component is still a pairing the hub is answering.
 * The store arrives as a prop (the page builds exactly one), so the memo is
 * keyed by it rather than held at module scope.
 *
 * Exported because the first-run wizard pairs over the same store: the two
 * screens are two places the same panel is drawn, and a wizard that built its
 * own operations would put a second pairing path on one socket. It stays here,
 * beside the store-keyed memo it is the whole of, rather than moving to a file
 * of its own for the sake of the second caller.
 */
const pairingByStore = new WeakMap<HubStore, PairingOperations>();

export function pairingFor(store: HubStore): PairingOperations {
  const existing = pairingByStore.get(store);
  if (existing !== undefined) return existing;
  const built = createBrowserPairingOperations(store);
  pairingByStore.set(store, built);
  return built;
}

/**
 * This browser's side of push, built once.
 *
 * Not keyed by the store, because it is not about the hub: it is the one
 * browser this page is running in, and the control keys its read of it by
 * identity. Built on first use rather than at import, so that importing this
 * route touches no global -- `navigator.serviceWorker.ready` is a getter, and
 * a module that reads it on load reads it in every test that imports the
 * route for something else.
 */
let browserPush: PushOperations | null = null;

export function pushFor(): PushOperations {
  browserPush ??= createBrowserPushOperations(globalThis);
  return browserPush;
}

export interface SettingsRouteProps {
  readonly store: HubStore;
  readonly tokens: TokenStore;
}

export function SettingsRoute({ store, tokens }: SettingsRouteProps): JSX.Element {
  const snapshot = useHubSnapshot(store);
  return (
    <SettingsScreen
      snapshot={snapshot}
      tokens={tokens}
      store={store}
      pairing={pairingFor(store)}
      push={pushFor()}
      candidates={discoveredCandidates(snapshot.machineState)}
    />
  );
}
