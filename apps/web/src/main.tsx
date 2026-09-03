import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { registerServiceWorker } from './pwa/register-service-worker.js';

// Production only: the dev server serves fresh modules itself, and a worker in
// front of it would only add confusion.
if (import.meta.env.PROD) {
  registerServiceWorker('serviceWorker' in navigator ? navigator.serviceWorker : undefined);
}

const container = document.querySelector('#root');
if (container === null) {
  throw new Error('index.html has no #root to mount into');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
