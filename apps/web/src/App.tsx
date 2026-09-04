import { type JSX } from 'react';

import { readHubToken } from './auth/token.js';
import { LayoutScreen } from './layout/layout-screen.js';
import { SessionListScreen } from './sessions/session-list-screen.js';
import { SettingsRoute } from './settings/settings-route.js';
import { createBrowserDependencies } from './store/browser.js';
import { createHubStore } from './store/hub-store.js';
import { useSessionRoute } from './terminal/session-route.js';
import { MantineProvider, Stack } from './ui/components.js';
import { cssVariablesResolver, theme } from './ui/theme.js';

/**
 * The one hub store for the whole app, constructed where the routes mount and
 * passed down. Module scope rather than component scope on purpose: the store
 * is an external store whose socket lifecycle follows subscriber count, and a
 * store created in render would be a new socket per remount. Constructing it
 * is inert -- nothing dials until the first subscriber.
 *
 * No token yet is not an error here: the ticket exchange refuses the empty
 * credential and the snapshot says so in words. The settings ticket (AGX-35)
 * owns writing the token, through the seam in auth/token.ts.
 */
const hubStore = createHubStore(
  createBrowserDependencies({ readToken: () => readHubToken() ?? '' }),
);

/**
 * The root: provider chrome only. Everything a feature ticket adds mounts
 * inside AppShell, so this file changes when the provider stack changes and
 * for no other reason.
 */
export function App(): JSX.Element {
  return (
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="dark"
    >
      <AppShell />
    </MantineProvider>
  );
}

/**
 * Where the application lives. The stacked tickets — terminal pane, layout
 * tree, settings — mount their routes and panes here beside the session list;
 * the provider stack above stays out of their way.
 */
function AppShell(): JSX.Element {
  const sessionRef = useSessionRoute();
  if (sessionRef !== null) {
    // Deliberately not keyed on the route: the layout outlives navigation,
    // and the screen shows the addressed session in its focused pane. The
    // panes key their own session mounts.
    return <LayoutScreen session={sessionRef} />;
  }
  return (
    <Stack component="main" gap="md">
      <SessionListScreen store={hubStore} />
      <SettingsRoute />
    </Stack>
  );
}
