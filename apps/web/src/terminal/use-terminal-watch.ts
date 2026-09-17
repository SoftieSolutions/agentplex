import { useCallback, useSyncExternalStore } from 'react';
import type { ClientTerminalTarget } from '@agentplex/protocol';

import type { HubStore } from '../store/hub-store.js';

/**
 * Standing interest in one terminal, declared the way looking at anything is
 * declared here: a subscription whose lifetime is the component's, through
 * `useSyncExternalStore` rather than an effect. The hook never re-renders --
 * the snapshot is a constant -- it exists purely so the store subscribes while
 * a pane is mounted, replays that subscription on every reconnection, and
 * gives the watch back when the pane goes.
 *
 * The bytes and the facts are not returned here. They live in the store's own
 * snapshot, which a pane already reads through `useHubSnapshot`, so a pane
 * gets the current version of them on every render rather than the version
 * that was true at mount.
 *
 * Shared by the two panes that watch a terminal, and they watch two different
 * kinds of target: a session pane names `{ storeId, sessionId }`, and a
 * pending pane names the start handle that is all a spawn has until the
 * provider writes an id. That is the whole of what differs between them at
 * this seam, which is why the seam takes the target rather than either.
 */
const NOTHING = (): null => null;

export function useTerminalWatch(store: HubStore, target: ClientTerminalTarget): void {
  const subscribe = useCallback(() => store.watchTerminal(target), [store, target]);
  useSyncExternalStore(subscribe, NOTHING);
}
