import type { JSX } from 'react';
import type { TokenStore } from '../auth/token.js';
import type { HubStore } from '../store/hub-store.js';
import { useHubSnapshot } from '../store/use-hub-store.js';
import { discoveredCandidates } from './pairing-form.js';
import { createBrowserPairingOperations, type PairingOperations } from './pairing-operations.js';
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
 */
const pairingByStore = new WeakMap<HubStore, PairingOperations>();

function pairingFor(store: HubStore): PairingOperations {
  const existing = pairingByStore.get(store);
  if (existing !== undefined) return existing;
  const built = createBrowserPairingOperations(store);
  pairingByStore.set(store, built);
  return built;
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
      pairing={pairingFor(store)}
      candidates={discoveredCandidates(snapshot.machineState)}
    />
  );
}
