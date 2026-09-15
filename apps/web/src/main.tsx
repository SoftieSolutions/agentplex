import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { browserTokenStore } from './auth/token.js';
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

const container = document.querySelector('#root');
if (container === null) {
  throw new Error('index.html has no #root to mount into');
}

createRoot(container).render(
  <StrictMode>
    <App hub={hub} tokens={browserTokenStore} />
  </StrictMode>,
);
