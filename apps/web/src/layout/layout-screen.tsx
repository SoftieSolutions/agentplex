import { useCallback, useState, useSyncExternalStore, type JSX } from 'react';
import type { SessionRef } from '@agentplex/protocol';
import type { HubStore } from '../store/hub-store.js';
import { browserTimers } from '../store/timers.js';
import { appHubStore } from '../terminal/hub.js';
import { createShortcutRegistry, type ShortcutRegistry } from '../terminal/shortcuts.js';
import { Stack, Text, useComputedColorScheme } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { createLayoutStore, type LayoutStore } from './layout-store.js';
import { NodeView, pathKey, type PaneViewDependencies } from './split-view.js';
import type { FocusDirection } from './operations.js';

/**
 * The screen that hosts the layout: one layout store, one shortcut registry,
 * and the recursive split view under a single capture-phase key handler.
 *
 * The chords live at this root, in the registry AGX-33 built, consulted by
 * the same capture pattern the session pane uses for its own keys: the
 * layout's handler sits on an outer element, so it decides its chords before
 * any pane's handler — let alone the emulator — can see them. The bindings
 * are layout verbs (split, close, move focus); everything inside a pane stays
 * the pane's.
 *
 * The route's session is declared to the layout through the subscription
 * callback rather than an effect: `useSyncExternalStore` re-subscribes when
 * the callback's identity changes, the parsed session ref is memoized on the
 * hash, so "the address names a session" reaches the store exactly when the
 * address changes, and outside render.
 */

/** What each chord does; the keys avoid T and S, which the session pane owns. */
const SHORTCUTS = {
  splitRight: 'd',
  splitDown: 'e',
  closePane: 'x',
} as const;

interface HeldStores {
  readonly layout: LayoutStore;
  readonly registry: ShortcutRegistry;
  registerPane(key: string, element: HTMLDivElement | null): void;
}

/**
 * Everything with a pane-lifetime identity, built once per mounted screen.
 * Lives outside the component so nothing in here can close over a render.
 */
function buildHeldStores(hub: HubStore, injected: LayoutStore | undefined): HeldStores {
  const layout = injected ?? createLayoutStore({ hub, timers: browserTimers });
  const registry = createShortcutRegistry();

  // Where each pane's element landed, so a focus change in the tree can move
  // DOM focus with it. A pane created by a split is not in the document yet
  // when its chord runs; the pending key hands the focus to the ref callback
  // that will see the element mount.
  const paneElements = new Map<string, HTMLDivElement>();
  let pendingFocusKey: string | null = null;

  function focusFocusedPane(): void {
    const key = pathKey(layout.getSnapshot().focus);
    const element = paneElements.get(key);
    if (element !== undefined) {
      pendingFocusKey = null;
      element.focus();
    } else {
      pendingFocusKey = key;
    }
  }

  function registerPane(key: string, element: HTMLDivElement | null): void {
    if (element === null) {
      paneElements.delete(key);
      return;
    }
    paneElements.set(key, element);
    if (key === pendingFocusKey) {
      pendingFocusKey = null;
      element.focus();
    }
  }

  registry.register({
    key: SHORTCUTS.splitRight,
    description: 'split the pane, new pane to the right',
    run: () => {
      layout.split('row');
      focusFocusedPane();
    },
  });
  registry.register({
    key: SHORTCUTS.splitDown,
    description: 'split the pane, new pane below',
    run: () => {
      layout.split('column');
      focusFocusedPane();
    },
  });
  registry.register({
    key: SHORTCUTS.closePane,
    description: 'close the pane',
    run: () => {
      layout.close();
      focusFocusedPane();
    },
  });
  const arrows: readonly { key: string; word: string; direction: FocusDirection }[] = [
    { key: 'arrowleft', word: 'left', direction: 'left' },
    { key: 'arrowright', word: 'right', direction: 'right' },
    { key: 'arrowup', word: 'up', direction: 'up' },
    { key: 'arrowdown', word: 'down', direction: 'down' },
  ];
  for (const { key, word, direction } of arrows) {
    registry.register({
      key,
      description: `focus the pane to the ${word}`,
      run: () => {
        layout.focusMove(direction);
        focusFocusedPane();
      },
    });
  }

  return { layout, registry, registerPane };
}

export interface LayoutScreenProps {
  /** The session the address names, or `null` for no session route. */
  readonly session: SessionRef | null;
  /** Injected by tests; the page uses the app singleton. */
  readonly store?: HubStore;
  readonly layoutStore?: LayoutStore;
}

export function LayoutScreen({ session, store, layoutStore }: LayoutScreenProps): JSX.Element {
  const hub = store ?? appHubStore();
  const scheme: Scheme = useComputedColorScheme('dark');
  const [held] = useState<HeldStores>(() => buildHeldStores(hub, layoutStore));
  const { layout, registry, registerPane } = held;

  // The subscription is also where the route's session reaches the layout:
  // `useSessionRoute` memoizes the ref on the hash, so this callback changes
  // identity exactly when the address does, and React re-subscribes through
  // it — a call outside render, once per address.
  const subscribe = useCallback(
    (listener: () => void) => {
      const detach = layout.subscribe(listener);
      if (session !== null) layout.showSession(session);
      return detach;
    },
    [layout, session],
  );
  const snapshot = useSyncExternalStore(subscribe, layout.getSnapshot);

  const view: PaneViewDependencies = {
    hub,
    scheme,
    focus: snapshot.focus,
    onCommitRatio: (path, ratio) => layout.commitRatio(path, ratio),
    onFocusPane: (path) => layout.focusPane(path),
    registerPane,
  };

  return (
    <div
      style={{ height: '100dvh', background: colorForRole('background', scheme) }}
      // Capture phase, outermost: a layout chord is decided before any pane
      // — or its emulator — can turn the keydown into terminal bytes.
      onKeyDownCapture={(event) => registry.handleKeyDown(event)}
    >
      {snapshot.loaded ? (
        <NodeView node={snapshot.tree} path={[]} view={view} />
      ) : (
        <Stack align="center" justify="center" style={{ height: '100%' }}>
          <Text fz={12} style={{ color: colorForRole('textMuted', scheme) }}>
            Waiting for the hub to answer with the stored layout
          </Text>
        </Stack>
      )}
    </div>
  );
}
