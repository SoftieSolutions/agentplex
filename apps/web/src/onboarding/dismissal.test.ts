import { describe, expect, it } from 'vitest';
import { fakeStorage } from '../auth/fake-storage.js';
import { browserOnboardingDismissal, createOnboardingDismissal } from './dismissal.js';

const KEY = 'agentplex.onboardingDismissed';

describe('the onboarding dismissal', () => {
  it('reads nothing stored as not dismissed, and remembers a dismissal', () => {
    const storage = fakeStorage();
    const dismissal = createOnboardingDismissal(() => storage);
    expect(dismissal.read()).toBe(false);
    expect(dismissal.dismiss()).toBe(true);
    expect(dismissal.read()).toBe(true);
    expect(storage.getItem(KEY)).toBe('true');
  });

  it('notifies its listeners on a dismissal, and stops when one leaves', () => {
    const dismissal = createOnboardingDismissal(() => fakeStorage());
    let staying = 0;
    let leaving = 0;
    dismissal.subscribe(() => {
      staying += 1;
    });
    const unsubscribe = dismissal.subscribe(() => {
      leaving += 1;
    });
    dismissal.dismiss();
    expect([staying, leaving]).toEqual([1, 1]);
    unsubscribe();
    dismissal.forget();
    expect([staying, leaving]).toEqual([2, 1]);
  });

  it('forgets a dismissal, so the wizard is offered again', () => {
    const storage = fakeStorage();
    const dismissal = createOnboardingDismissal(() => storage);
    dismissal.dismiss();
    expect(dismissal.forget()).toBe(true);
    expect(dismissal.read()).toBe(false);
    expect(storage.getItem(KEY)).toBeNull();
  });

  it('reads a word it did not write as not dismissed', () => {
    // What is on disk is a claim, not a boolean: only the word this file
    // writes means dismissed, and anything else means the wizard is offered.
    // Erring towards showing it is the direction that does not over-claim --
    // a wizard nobody wanted is closed in one click, a wizard wrongly
    // suppressed leaves a first-run operator with no way in.
    expect(createOnboardingDismissal(() => fakeStorage({ [KEY]: 'maybe' })).read()).toBe(false);
    expect(createOnboardingDismissal(() => fakeStorage({ [KEY]: '' })).read()).toBe(false);
    expect(createOnboardingDismissal(() => fakeStorage({ [KEY]: 'true' })).read()).toBe(true);
  });

  it('dismisses for this page only when the storage access itself throws', () => {
    // The privacy-mode shape: `window.localStorage` throws on access, before
    // any setItem could run. Closing the wizard must still close it -- the
    // click is not refused because the browser refuses to remember it -- and
    // `dismiss` reports the false so a caller can say the dismissal will not
    // outlive this page rather than promise it was kept.
    const dismissal = createOnboardingDismissal(() => {
      throw new Error('SecurityError: the document is sandboxed');
    });
    let notified = 0;
    dismissal.subscribe(() => {
      notified += 1;
    });
    expect(dismissal.read()).toBe(false);
    expect(dismissal.dismiss()).toBe(false);
    expect(dismissal.read()).toBe(true);
    expect(notified).toBe(1);
    expect(dismissal.forget()).toBe(false);
    expect(dismissal.read()).toBe(false);
    expect(notified).toBe(2);
  });

  it('degrades the same way when the storage exists but its methods throw', () => {
    // The quota-exceeded shape: the object is reachable, the write is refused.
    const refusing: Storage = {
      ...fakeStorage(),
      getItem: () => {
        throw new Error('refused');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('refused');
      },
    };
    const dismissal = createOnboardingDismissal(() => refusing);
    expect(dismissal.read()).toBe(false);
    expect(dismissal.dismiss()).toBe(false);
    expect(dismissal.read()).toBe(true);
    expect(dismissal.forget()).toBe(false);
    expect(dismissal.read()).toBe(false);
  });

  it('the browser-bound dismissal survives an environment with no window at all', () => {
    // This test process has no `window`; the module-level dismissal must treat
    // that the way it treats a browser that refuses storage.
    expect(browserOnboardingDismissal.read()).toBe(false);
    expect(browserOnboardingDismissal.dismiss()).toBe(false);
    expect(browserOnboardingDismissal.forget()).toBe(false);
  });
});
