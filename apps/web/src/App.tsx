import { useSyncExternalStore, type JSX } from 'react';

import type { TokenStore } from './auth/token.js';
import { useDocRoute } from './docs/doc-route.js';
import { useGraphRoute } from './graphs/graph-route.js';
import type { OnboardingDismissal } from './onboarding/dismissal.js';
import { onboardingVerdict } from './onboarding/onboarding-model.js';
import { useOnboardingRoute } from './onboarding/onboarding-route.js';
import { OnboardingScreen } from './onboarding/onboarding-screen.js';
import { AppShell } from './shell/app-shell.js';
import type { HubStore } from './store/hub-store.js';
import { useHubSnapshot } from './store/use-hub-store.js';
import { useSessionRoute } from './terminal/session-route.js';
import { colorSchemeManager } from './ui/color-scheme.js';
import { MantineProvider } from './ui/components.js';
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
 * The root: provider chrome only. What the page is -- the first-run wizard or
 * the app -- is the gate below, and the app's own frame, the top bar, the
 * sidebar and the content region every screen mounts into, is
 * `shell/app-shell.tsx`. So this file changes when the provider stack changes
 * and for no other reason.
 */
export function App({ hub, tokens, dismissal }: AppProps): JSX.Element {
  return (
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      colorSchemeManager={colorSchemeManager}
      defaultColorScheme="dark"
    >
      <OnboardingGate hub={hub} tokens={tokens} dismissal={dismissal} />
    </MantineProvider>
  );
}

/**
 * Which screen the page is: the first-run wizard, or the app.
 *
 * Above the shell rather than inside it, because the wizard is what the shell
 * is replaced by. It is a `component="main"` page of its own at a full
 * `100dvh` (src/onboarding/onboarding-screen.tsx), so mounting it in the
 * shell's content region would nest one `main` in another and give a person
 * with nothing paired a chrome full of controls for a fleet that does not
 * exist. The wizard instead of the app, not above it, which is the rule
 * AGX-114 landed and this ticket keeps.
 *
 * It yields to a session or a document address, though, which is the one rule
 * the move up added. Those name a thing rather than a place: somebody was sent
 * a link to one session, and answering it with a walkthrough of pairing a
 * first machine drops them somewhere the address they followed cannot be
 * recovered from. The auto-show is a guess about what the person in front of
 * an empty fleet wants; an address is not a guess, so it wins. A typed
 * `#/onboarding` is unaffected -- it is the request `onboardingVerdict` reads
 * before anything else, and it names no thing.
 *
 * Every fact here is read as an external store -- the hub's state, the three
 * addresses, the dismissal -- so none of them needs an effect mirroring it
 * into state, and a dismissal clicked inside the wizard puts the app on screen
 * without a remount. The shell reads the hub and the same two thing-addresses
 * again for its own reasons: duplicate reads of one store and one hash rather
 * than a second socket, because subscribing to a hub store only ever declares
 * that somebody is looking.
 */
function OnboardingGate({ hub, tokens, dismissal }: AppProps): JSX.Element {
  const snapshot = useHubSnapshot(hub);
  const requested = useOnboardingRoute();
  const sessionRef = useSessionRoute();
  const doc = useDocRoute();
  const graph = useGraphRoute();
  const dismissed = useSyncExternalStore(dismissal.subscribe, dismissal.read);
  const verdict = onboardingVerdict({
    machineState: snapshot.machineState,
    dismissed,
    requested,
  });
  // A graph address names a thing too, and yields for the reason the other
  // two do.
  if (verdict === 'show' && sessionRef === null && doc === null && graph === null) {
    return <OnboardingScreen store={hub} dismissal={dismissal} />;
  }
  // 'wait' draws the app too: the list already says it is waiting for the hub,
  // in the words it uses for every other unanswered render, and a second
  // waiting screen over it would be this file inventing one.
  return <AppShell hub={hub} tokens={tokens} />;
}
