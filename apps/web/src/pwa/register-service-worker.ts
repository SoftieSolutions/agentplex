/**
 * The slice of ServiceWorkerContainer the registration needs, so a test can
 * hand in its own registrar instead of a browser.
 */
export interface ServiceWorkerRegistrar {
  register(url: string): Promise<unknown>;
}

/**
 * Called from main.tsx in production builds only: the dev server serves fresh
 * modules itself, and a worker in front of that would only add confusion.
 *
 * A failed registration is swallowed deliberately. The app is fully
 * functional without a worker — a browser that refuses (private mode, storage
 * disabled) loses install and the offline fallback, nothing else — and the
 * client has nowhere meaningful to report it.
 */
export function registerServiceWorker(registrar: ServiceWorkerRegistrar | undefined): void {
  if (registrar === undefined) {
    return;
  }
  registrar.register('/sw.js').catch(() => {
    // See above: degraded, not broken.
  });
}
