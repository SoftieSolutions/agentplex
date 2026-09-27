// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockTag } from './mock-tag.js';
import { colorForRole, type Scheme } from './tokens.js';

/**
 * The chip every element fed by sample data wears. What is pinned is that it
 * says so in words a screen reader hears too, and that its colours are the
 * mock tag's own roles rather than a status tone's.
 */

declare global {
  // React's own name for the act flag.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** jsdom normalises an inline colour to rgb(); tokens speak hex. */
function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${String((value >> 16) & 255)}, ${String((value >> 8) & 255)}, ${String(value & 255)})`;
}

describe('the mock tag', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  function draw(scheme: Scheme): HTMLElement {
    act(() => {
      root = createRoot(container);
      root.render(<MockTag scheme={scheme} />);
    });
    const tag = container.querySelector<HTMLElement>('[data-mock-tag]');
    if (tag === null) throw new Error('no mock tag drawn');
    return tag;
  }

  it('reads "Mock", and is a labelled note a screen reader announces', () => {
    const tag = draw('dark');
    expect(tag.textContent).toBe('Mock');
    expect(tag.hasAttribute('aria-hidden')).toBe(false);
    expect(tag.getAttribute('role')).toBe('note');
    expect(tag.getAttribute('aria-label')).toBe('mock data');
  });

  it.each(['dark', 'light'] as const)('paints the mock tag roles in the %s scheme', (scheme) => {
    const tag = draw(scheme);
    expect(tag.style.background).toBe(rgb(colorForRole('mockTag', scheme)));
    expect(tag.style.color).toBe(rgb(colorForRole('onMockTag', scheme)));
  });
});
