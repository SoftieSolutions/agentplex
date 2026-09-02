import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const container = document.querySelector('#root');
if (container === null) {
  throw new Error('index.html has no #root to mount into');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
