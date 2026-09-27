import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { browserTokenStore } from './auth/token.js';
import { createMockSwitch } from './mock/mock-switch.js';
import { browserOnboardingDismissal } from './onboarding/dismissal.js';
import { startDocumentTitle } from './pwa/document-title.js';
import { registerServiceWorker } from './pwa/register-service-worker.js';
import { createBrowserDependencies } from './store/browser.js';
import { createHubStore } from './store/hub-store.js';

// Production only: the dev server serves fresh modules itself, and a worker in
// front of it would only add confusion.
if (import.meta.env.PROD) {
  registerServiceWorker('serviceWorker' in navigator ? navigator.serviceWorker : undefined);
}

/**
 * The one hub store for the page, built here and nowhere else. Module scope
 * on purpose: the store is an external store whose socket lifecycle follows
 * subscriber count, and one created in render would be a new socket per
 * remount. Constructing it is inert -- nothing dials until the first
 * subscriber. No token yet is not an error: the ticket exchange refuses the
 * empty credential and the snapshot says so in words, and Settings writes the
 * token through the same store this one reads.
 */
const hub = createHubStore(createBrowserDependencies({ tokens: browserTokenStore }));

// The tab counts for the whole page, not for a screen: started here, once,
// and never stopped. Two things that follows from, both deliberate and both
// argued in document-title.ts -- the title is live during onboarding as well,
// and this subscriber keeps the store's socket up for the life of the page
// because its lifecycle follows subscriber count and this one never leaves.
startDocumentTitle(hub, document);

/**
 * The page's mock switch, built once here for the reason the hub store is:
 * it reads `?mock=1` when it is built, and one built in render would read the
 * address again on every remount and undo a Settings toggle turned off on a
 * page whose address still carries the parameter. Both accesses are inside
 * the switch's guarded calls.
 */
const browserMockSwitch = createMockSwitch({
  storage: () => window.localStorage,
  search: () => window.location.search,
});

const container = document.querySelector('#root');
if (container === null) {
  throw new Error('index.html has no #root to mount into');
}

createRoot(container).render(
  <StrictMode>
    <App
      hub={hub}
      tokens={browserTokenStore}
      dismissal={browserOnboardingDismissal}
      mock={browserMockSwitch}
    />
  </StrictMode>,
);
