import { type JSX } from 'react';

import type { TokenStore } from './auth/token.js';
import { LayoutScreen } from './layout/layout-screen.js';
import { SessionListScreen } from './sessions/session-list-screen.js';
import { SettingsRoute } from './settings/settings-route.js';
import type { HubStore } from './store/hub-store.js';
import { useSessionRoute } from './terminal/session-route.js';
import { MantineProvider, Stack } from './ui/components.js';
import { cssVariablesResolver, theme } from './ui/theme.js';

export interface AppProps {
  /**
   * The one hub store for the whole page. Built by `main.tsx` and handed in
   * rather than built here, so a test can mount the page on a store whose
   * platform seams it filled -- and so there is exactly one place that builds
   * one. Every route reads it through props; a second store anywhere would be
   * a second socket, and a second socket dials with whatever credential it
   * was given, which is how a session screen once presented a token nobody
   * had written.
   */
  readonly hub: HubStore;
  /** Where the credential lives: written by Settings, read by the store's ticket exchange. */
  readonly tokens: TokenStore;
}

/**
 * The root: provider chrome only. Everything a feature ticket adds mounts
 * inside AppShell, so this file changes when the provider stack changes and
 * for no other reason.
 */
export function App({ hub, tokens }: AppProps): JSX.Element {
  return (
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="dark"
    >
      <AppShell hub={hub} tokens={tokens} />
    </MantineProvider>
  );
}

/**
 * Where the application lives. The stacked tickets -- terminal pane, layout
 * tree, settings -- mount their routes and panes here beside the session list;
 * the provider stack above stays out of their way.
 */
function AppShell({ hub, tokens }: AppProps): JSX.Element {
  const sessionRef = useSessionRoute();
  if (sessionRef !== null) {
    // Deliberately not keyed on the route: the layout outlives navigation,
    // and the screen shows the addressed session in its focused pane. The
    // panes key their own session mounts.
    return <LayoutScreen session={sessionRef} store={hub} />;
  }
  return (
    <Stack component="main" gap="md">
      <SessionListScreen store={hub} />
      <SettingsRoute store={hub} tokens={tokens} />
    </Stack>
  );
}
