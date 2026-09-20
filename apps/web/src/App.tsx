import { useSyncExternalStore, type JSX } from 'react';

import type { TokenStore } from './auth/token.js';
import { useDocRoute } from './docs/doc-route.js';
import { LayoutScreen } from './layout/layout-screen.js';
import type { OnboardingDismissal } from './onboarding/dismissal.js';
import { onboardingVerdict } from './onboarding/onboarding-model.js';
import { useOnboardingRoute } from './onboarding/onboarding-route.js';
import { OnboardingScreen } from './onboarding/onboarding-screen.js';
import { SessionListScreen } from './sessions/session-list-screen.js';
import { SettingsRoute } from './settings/settings-route.js';
import type { HubStore } from './store/hub-store.js';
import { useHubSnapshot } from './store/use-hub-store.js';
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
  /**
   * Whether this device has closed the first-run wizard. Handed in beside the
   * two stores rather than reached for here, for the same reason they are:
   * the wizard's close button and the gate that reads it have to be looking at
   * one dismissal, and a test has no browser storage worth trusting.
   */
  readonly dismissal: OnboardingDismissal;
}

/**
 * The root: provider chrome only. Everything a feature ticket adds mounts
 * inside AppShell, so this file changes when the provider stack changes and
 * for no other reason.
 */
export function App({ hub, tokens, dismissal }: AppProps): JSX.Element {
  return (
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="dark"
    >
      <AppShell hub={hub} tokens={tokens} dismissal={dismissal} />
    </MantineProvider>
  );
}

/**
 * Where the application lives. The stacked tickets -- terminal pane, layout
 * tree, settings -- mount their routes and panes here beside the session list;
 * the provider stack above stays out of their way.
 */
function AppShell({ hub, tokens, dismissal }: AppProps): JSX.Element {
  const sessionRef = useSessionRoute();
  const doc = useDocRoute();
  if (sessionRef !== null || doc !== null) {
    // Deliberately not keyed on the route: the layout outlives navigation,
    // and the screen shows the addressed session -- or document -- in its
    // focused pane. The panes key their own mounts.
    return <LayoutScreen session={sessionRef} doc={doc} store={hub} tokens={tokens} />;
  }
  return (
    <Stack component="main" gap="md">
      <OnboardingGate hub={hub} tokens={tokens} dismissal={dismissal} />
    </Stack>
  );
}

/**
 * Which screen the page is on its default route: the first-run wizard, or the
 * app.
 *
 * A component of its own rather than three more hooks in AppShell, because
 * AppShell returns early for the session and document routes and hooks may not
 * follow a return. Moving the early return below the gate's hooks would make
 * every session screen subscribe to the hash, the dismissal and the whole
 * machine state to decide a question it never asks. So the gate is mounted
 * where its answer matters and reads its three facts there.
 *
 * All three are read as external stores -- the hub's state, the address, the
 * dismissal -- so none of them needs an effect mirroring it into state, and a
 * dismissal clicked inside the wizard puts the app on screen without a remount.
 */
function OnboardingGate({ hub, tokens, dismissal }: AppProps): JSX.Element {
  const snapshot = useHubSnapshot(hub);
  const requested = useOnboardingRoute();
  const dismissed = useSyncExternalStore(dismissal.subscribe, dismissal.read);
  const verdict = onboardingVerdict({
    machineState: snapshot.machineState,
    dismissed,
    requested,
  });
  if (verdict === 'show') return <OnboardingScreen store={hub} dismissal={dismissal} />;
  // 'wait' draws the app too: the list already says it is waiting for the hub,
  // in the words it uses for every other unanswered render, and a second
  // waiting screen over it would be this file inventing one.
  return (
    <>
      <SessionListScreen store={hub} tokens={tokens} />
      <SettingsRoute store={hub} tokens={tokens} />
    </>
  );
}
