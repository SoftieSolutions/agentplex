/**
 * Whether this device has closed the first-run wizard, kept in this browser
 * only.
 *
 * Per device rather than per hub, on the token store's precedent
 * (src/auth/token.ts): the wizard walks the person in front of this screen
 * through getting connected, so "I have seen this, stop offering it" is a fact
 * about the device that saw it, not about the fleet. A dismissal synced to the
 * hub would hide the walkthrough on a phone that has never been set up because
 * a laptop had been.
 *
 * Every access is guarded, not just the reads: touching `window.localStorage`
 * itself can throw in a privacy mode, an embedded webview, or a browser
 * configured to refuse site data. Such a browser degrades to a dismissal that
 * holds for this page and is honestly reported as not kept -- `dismiss` closes
 * the wizard and returns false. Refusing the click because the browser refuses
 * to remember it would trap the reader on a screen they asked to leave, and
 * claiming the dismissal was stored would promise a quiet reload that this
 * browser cannot give.
 *
 * Read through `useSyncExternalStore(dismissal.subscribe, dismissal.read)`:
 * `read` returns a boolean, so React's own comparison settles the re-render
 * and no effect is needed to mirror the flag into state.
 */

const STORAGE_KEY = 'agentplex.onboardingDismissed';

/** The one word that means dismissed. Anything else is a word we did not write. */
const DISMISSED = 'true';

export interface OnboardingDismissal {
  /**
   * True when this device has closed the wizard. A browser that refuses
   * storage reads false until something on this page dismisses it.
   */
  read(): boolean;
  /**
   * Closes the wizard on this device. True when that is now stored; false when
   * this browser refused, in which case it holds for this page only.
   */
  dismiss(): boolean;
  /**
   * Offers the wizard again. True when nothing is stored any more.
   *
   * Nothing in the app calls this yet: it is here for the re-offer path -- a
   * Settings control, or the last server being unpaired -- and until that
   * lands it is exercised only by this file's tests. Read it as the seam the
   * re-offer will use, not as behaviour the wizard has today.
   */
  forget(): boolean;
  /** For `useSyncExternalStore`; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/**
 * The storage access is injected because a test cannot supply a browser whose
 * `localStorage` property throws -- but it can supply a function that does,
 * which is exactly how such a browser behaves at this seam.
 */
export function createOnboardingDismissal(access: () => Storage): OnboardingDismissal {
  const listeners = new Set<() => void>();
  /**
   * What this page knows on its own, whatever disk says. It outranks the
   * stored word because it is the newer answer: it is set by a click that
   * happened here, and it is how a browser that refuses storage still gets to
   * close the wizard.
   */
  let here = false;

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  return {
    read(): boolean {
      if (here) return true;
      try {
        return access().getItem(STORAGE_KEY) === DISMISSED;
      } catch {
        return false;
      }
    },
    dismiss(): boolean {
      here = true;
      notify();
      try {
        access().setItem(STORAGE_KEY, DISMISSED);
        return true;
      } catch {
        return false;
      }
    },
    forget(): boolean {
      here = false;
      notify();
      try {
        access().removeItem(STORAGE_KEY);
        return true;
      } catch {
        return false;
      }
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The browser's dismissal, and the one the page hands around: the wizard's
 * close button writes through it and the gate reads through it, so there is
 * exactly one key a dismissal can be under. The property access lives inside
 * the guarded call.
 */
export const browserOnboardingDismissal: OnboardingDismissal = createOnboardingDismissal(
  () => window.localStorage,
);
