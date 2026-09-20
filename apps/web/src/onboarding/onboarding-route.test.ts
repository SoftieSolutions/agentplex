// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ONBOARDING_HASH, parseOnboardingHash, useOnboardingRoute } from './onboarding-route.js';

/**
 * jsdom for the hook and for nothing else: the parser is a string function,
 * but the subscription is the part worth pinning, so the file that mounts it
 * needs a document and a window to dispatch the event on.
 */

declare global {
  // React's own name for the act flag.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

describe('the onboarding address', () => {
  it('is the wizard at its own hash and nothing else', () => {
    expect(parseOnboardingHash(ONBOARDING_HASH)).toBe(true);
    expect(parseOnboardingHash('#/onboarding/x')).toBe(false);
    expect(parseOnboardingHash('#/session/a/b')).toBe(false);
    expect(parseOnboardingHash('')).toBe(false);
  });
});

describe('the onboarding route', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  function Probe(): string {
    return useOnboardingRoute() ? 'wizard' : 'elsewhere';
  }

  /** Sets the hash and delivers the event jsdom would deliver on its own. */
  function navigate(hash: string): void {
    act(() => {
      window.location.hash = hash;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
  }

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    window.location.hash = '';
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    window.location.hash = '';
  });

  it('follows the hash without an effect to mirror it', () => {
    act(() => {
      root = createRoot(container);
      root.render(createElement(Probe));
    });
    expect(container.textContent).toBe('elsewhere');

    navigate(ONBOARDING_HASH);
    expect(container.textContent).toBe('wizard');

    navigate('#/session/store-1/session-1');
    expect(container.textContent).toBe('elsewhere');
  });
});
