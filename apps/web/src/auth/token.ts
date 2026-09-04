/**
 * The hub token, typed once per device and kept in this browser only.
 *
 * The token never leaves the device except as the Authorization header of the
 * ticket exchange (see store/browser.ts). It is stored in localStorage because
 * the credential is per device by design: the spec's client auth is "shared
 * token typed on the device", and a token synced anywhere else would be a
 * credential the user did not place there.
 *
 * Every access is guarded, not just the reads. Touching `window.localStorage`
 * itself can throw — a privacy mode, an embedded webview, a browser configured
 * to refuse site data — so the guard wraps the property access, and a browser
 * that refuses storage degrades to "no token stored" rather than a crash. That
 * is the direction that does not over-claim: the user is asked to type the
 * token again, which is annoying and honest, rather than shown a screen that
 * believes a token it could not keep.
 */

const STORAGE_KEY = 'agentplex.hubToken';

export interface TokenStore {
  /** The stored token, or `null` when none is stored or storage is refused. */
  read(): string | null;
  /** True when the token is now stored; false when this browser refused. */
  write(token: string): boolean;
  /** True when nothing is stored any more; false when this browser refused. */
  clear(): boolean;
}

/**
 * The storage access is injected because a test cannot supply a browser whose
 * `localStorage` property throws — but it can supply a function that does,
 * which is exactly how such a browser behaves at this seam.
 */
export function createTokenStore(access: () => Storage): TokenStore {
  return {
    read(): string | null {
      try {
        const stored = access().getItem(STORAGE_KEY);
        return stored === null || stored === '' ? null : stored;
      } catch {
        return null;
      }
    },
    write(token: string): boolean {
      try {
        access().setItem(STORAGE_KEY, token);
        return true;
      } catch {
        return false;
      }
    },
    clear(): boolean {
      try {
        access().removeItem(STORAGE_KEY);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** The browser's store. The property access lives inside the guarded call. */
const browserTokenStore = createTokenStore(() => window.localStorage);

export function readHubToken(): string | null {
  return browserTokenStore.read();
}

export function writeHubToken(token: string): boolean {
  return browserTokenStore.write(token);
}

export function clearHubToken(): boolean {
  return browserTokenStore.clear();
}
