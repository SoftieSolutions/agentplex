import type { JSX } from 'react';
import { clearHubToken, readHubToken, writeHubToken, type TokenStore } from '../auth/token.js';
import { createBrowserDependencies } from '../store/browser.js';
import { createHubStore } from '../store/hub-store.js';
import { useHubSnapshot } from '../store/use-hub-store.js';
import { discoveredCandidates } from './pairing-form.js';
import { createBrowserPairingOperations } from './pairing-operations.js';
import { SettingsScreen } from './settings-screen.js';

/**
 * The settings route: the screen wired to the browser. The hub store lives at
 * module scope, not in a component — its socket belongs to whether anything is
 * subscribed, and the first `useHubSnapshot` below is what dials.
 *
 * The store reads the token per ticket exchange, so a token saved on this
 * screen is picked up by the next reconnect attempt without rebuilding
 * anything. A missing token becomes an empty Bearer header, a 401, and an
 * honest "reconnecting" with the refusal in words — which is the connection
 * line this screen draws.
 */
const store = createHubStore(createBrowserDependencies({ readToken: () => readHubToken() ?? '' }));

const pairing = createBrowserPairingOperations();

const tokens: TokenStore = { read: readHubToken, write: writeHubToken, clear: clearHubToken };

export function SettingsRoute(): JSX.Element {
  const snapshot = useHubSnapshot(store);
  return (
    <SettingsScreen
      snapshot={snapshot}
      tokens={tokens}
      pairing={pairing}
      candidates={discoveredCandidates(snapshot.machineState)}
    />
  );
}
