// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { TabStrip } from './tab-strip.js';
import type { SessionTab } from './tab-strip-model.js';

/**
 * The strip drawn at the two sizes it has to hold: the one tab that exists
 * today, and the four the mockup shows once the other three epics land. The
 * count is a prop and never an assumption, so both are the same component with
 * the same assertions asked of it.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** The panel each tab shows, as the pane that mounted the strip named it. */
function tab(id: string, label: string, badge: string | null = null): SessionTab {
  return { id, label, badge, panelId: `pane-${id}` };
}

const ONE: readonly SessionTab[] = [tab('terminal', 'Terminal')];
const FOUR: readonly SessionTab[] = [
  tab('terminal', 'Terminal'),
  tab('transcript', 'Transcript'),
  tab('diff', 'Diff', '+142 -38'),
  tab('approvals', 'Approvals', '3'),
];

/** Mantine reads the colour-scheme media query on mount; jsdom has none. */
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

let container: HTMLDivElement;
let root: Root | null = null;
let asked: string[] = [];

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  installMatchMedia();
  container = document.createElement('div');
  document.body.append(container);
  asked = [];
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container.remove();
});

async function mount(element: JSX.Element): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="dark"
      >
        {element}
      </MantineProvider>,
    );
  });
}

async function mountStrip(tabs: readonly SessionTab[], activeId: string | null): Promise<void> {
  await mount(
    <TabStrip
      tabs={tabs}
      activeId={activeId}
      onSelect={(id) => asked.push(id)}
      scheme="dark"
      label="session views"
    />,
  );
}

function tabs(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
}

function labels(): string[] {
  return tabs().map((tab) => tab.textContent ?? '');
}

function selected(): string | null {
  return tabs().find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent ?? null;
}

async function press(key: string): Promise<void> {
  const strip = container.querySelector('[role="tablist"]');
  if (strip === null) throw new Error('nothing drew a tablist');
  await act(() => {
    strip.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

describe('a strip with one tab', () => {
  it('draws it, selected, rather than assuming a strip needs a choice', async () => {
    await mountStrip(ONE, 'terminal');

    expect(labels()).toEqual(['Terminal']);
    expect(selected()).toBe('Terminal');
  });

  it('goes nowhere on the arrows, because there is nowhere to go', async () => {
    await mountStrip(ONE, 'terminal');

    await press('ArrowRight');
    await press('ArrowLeft');

    // Asked for, twice, and the same tab both times: the strip answers rather
    // than swallowing the key, and the answer is where it already is.
    expect(asked).toEqual(['terminal', 'terminal']);
  });
});

describe('a strip with every tab the mockup draws', () => {
  it('draws each label with the count beside it, and selects exactly one', async () => {
    await mountStrip(FOUR, 'diff');

    expect(labels()).toEqual(['Terminal', 'Transcript', 'Diff+142 -38', 'Approvals3']);
    expect(selected()).toBe('Diff+142 -38');
    expect(tabs().filter((tab) => tab.getAttribute('aria-selected') === 'true')).toHaveLength(1);
  });

  it('asks for the tab that was clicked', async () => {
    await mountStrip(FOUR, 'terminal');

    await act(() => {
      tabs()[2]?.click();
    });

    expect(asked).toEqual(['diff']);
  });

  it('walks with the arrows and wraps at the ends', async () => {
    await mountStrip(FOUR, 'terminal');

    await press('ArrowRight');
    await press('ArrowLeft');
    await press('Home');
    await press('End');

    expect(asked).toEqual(['transcript', 'approvals', 'terminal', 'approvals']);
  });

  it('puts one tab in the tab order and takes the focus to the rest', async () => {
    // The roving tabindex a tablist owes a keyboard: Tab reaches the strip
    // once and the arrows move inside it, rather than four stops on the way
    // to the terminal.
    await mountStrip(FOUR, 'diff');

    expect(tabs().map((tab) => tab.getAttribute('tabindex'))).toEqual(['-1', '-1', '0', '-1']);

    await press('ArrowRight');

    expect(document.activeElement?.textContent).toBe('Approvals3');
  });
});

describe('a strip with nothing in it', () => {
  it('is not drawn at all', async () => {
    await mountStrip([], null);

    expect(container.querySelector('[role="tablist"]')).toBeNull();
  });
});
