// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { TopBar } from './top-bar.js';

/**
 * The bar's own drawing: where the slots sit, and the brand mark. What the
 * slots hold is the shell's (`app-shell.test.tsx`).
 */

declare global {
  // React's own name for the act flag.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** Mantine consults the media query for its colour scheme; jsdom has none. */
function installMatchMedia(): void {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

/** A colour as jsdom writes it back, so a token and a style compare alike. */
function normal(property: 'background' | 'color', value: string): string {
  const probe = document.createElement('div');
  probe.style[property] = value;
  return probe.style[property];
}

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  installMatchMedia();
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

interface DrawOptions {
  readonly scheme?: Scheme;
  readonly search?: ReactNode;
}

function draw({
  scheme = 'dark',
  search = <button data-search>s</button>,
}: DrawOptions = {}): void {
  act(() => {
    root ??= createRoot(container);
    root.render(
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        forceColorScheme={scheme}
      >
        <TopBar
          scheme={scheme}
          search={search}
          status={<span data-status>long or short</span>}
          actions={<span data-actions>a</span>}
        />
      </MantineProvider>,
    );
  });
}

function bar(): HTMLElement {
  const header = container.querySelector<HTMLElement>('header');
  if (header === null) throw new Error('no header drawn');
  return header;
}

describe('the search slot', () => {
  function cell(index: number): HTMLElement {
    const child = bar().children[index];
    if (!(child instanceof HTMLElement)) throw new Error(`no cell ${String(index)} in the bar`);
    return child;
  }

  it('lays the bar out as a three-track grid rather than a flex row', () => {
    draw();
    expect(bar().style.display).toBe('grid');
    expect(bar().style.gridTemplateColumns).toBe(
      'minmax(220px, 1fr) minmax(0, auto) minmax(220px, 1fr)',
    );
    expect(bar().style.alignItems).toBe('center');
    expect(bar().style.columnGap).toBe('12px');
    expect(bar().children).toHaveLength(3);
  });

  it('centres the trigger in a middle cell that may shrink', () => {
    draw();
    const middle = cell(1);
    expect(middle.hasAttribute('data-search-slot')).toBe(true);
    expect(middle.querySelector('[data-search]')).not.toBeNull();
    expect(middle.style.display).toBe('flex');
    expect(middle.style.justifyContent).toBe('center');
    expect(middle.style.minWidth).toBe('0px');
  });

  it('keeps the mark in the first cell and status with actions end-aligned in the last', () => {
    draw();
    // The cell is the mark's own link rather than a wrapper around it.
    expect(cell(0).matches('a[aria-label="agentplex"]')).toBe(true);
    const right = cell(2);
    expect(right.querySelector('[data-status]')).not.toBeNull();
    expect(right.querySelector('[data-actions]')).not.toBeNull();
    expect(right.style.justifyContent).toBe('flex-end');
    expect(right.style.minWidth).toBe('0px');
  });

  it('gives both outer tracks one sizing, so the status words cannot move the trigger', () => {
    draw();
    // A grid track list splits on whitespace outside parentheses.
    const tracks = bar().style.gridTemplateColumns.match(/[^\s(]+(?:\([^)]*\))?/g) ?? [];
    expect(tracks).toHaveLength(3);
    expect(tracks[0]).toBe(tracks[2]);
  });

  it('still draws the middle cell with no search, so the right group stays at the end', () => {
    draw({ search: null });
    expect(bar().children).toHaveLength(3);
    expect(cell(1).hasAttribute('data-search-slot')).toBe(true);
    expect(cell(1).childElementCount).toBe(0);
    expect(cell(2).querySelector('[data-status]')).not.toBeNull();
  });

  it('reads mark, search, status, actions in document order', () => {
    draw();
    const order = [
      ...container.querySelectorAll(
        'a[aria-label="agentplex"], [data-search], [data-status], [data-actions]',
      ),
    ].map((element) =>
      element.matches('a[aria-label="agentplex"]')
        ? 'mark'
        : element.hasAttribute('data-search')
          ? 'search'
          : element.hasAttribute('data-status')
            ? 'status'
            : 'actions',
    );
    expect(order).toEqual(['mark', 'search', 'status', 'actions']);
  });
});

describe('the brand mark and the bar behind it', () => {
  function mark(scheme: Scheme): HTMLElement {
    draw({ scheme });
    const square = container.querySelector<HTMLElement>('[data-brand-mark]');
    if (square === null) throw new Error('no brand mark drawn');
    return square;
  }

  it('draws the mark in the brand roles: amber square with a char letter in dark (7a)', () => {
    const square = mark('dark');
    expect(square.style.background).toBe(normal('background', colorForRole('brand', 'dark')));
    expect(square.style.color).toBe(normal('color', colorForRole('onBrand', 'dark')));
  });

  it('draws an ink square with an amber letter in light, not the pale accent (7b)', () => {
    const square = mark('light');
    expect(square.style.background).toBe(normal('background', colorForRole('brand', 'light')));
    expect(square.style.color).toBe(normal('color', colorForRole('onBrand', 'light')));
  });

  it('sits on the page in dark and on paper in light (7a, 7b)', () => {
    for (const scheme of ['dark', 'light'] as const) {
      draw({ scheme });
      expect(bar().style.background, scheme).toBe(
        normal('background', colorForRole('chrome', scheme)),
      );
    }
  });
});
