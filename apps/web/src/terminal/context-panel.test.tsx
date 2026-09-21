// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { CONTEXT_PANEL_WIDTH, ContextPanel, type ContextBlock } from './context-panel.js';

/**
 * The frame, drawn at every size it has to hold: none of its blocks, one of
 * them, several of them -- and on a phone, where it is not drawn at all.
 *
 * The blocks here are stand-ins on purpose. Nothing in this file knows what
 * TASK, APPROVALS or COST are, because the frame does not either: it takes a
 * list of `{ key, title, body }` and lays each one out the same way, which is
 * the whole reason three tickets in three epics can each append one without
 * editing this component. A test written against the real blocks would turn
 * that into a promise about their contents and break when one of them changed
 * a word.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const TASK: ContextBlock = {
  key: 'task',
  title: 'Task',
  body: <span>Fix the auth refresh race when two tabs refresh at once.</span>,
};

const COST: ContextBlock = {
  key: 'cost',
  title: 'Cost · this session',
  body: <span>$1.84</span>,
};

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

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  installMatchMedia();
  container = document.createElement('div');
  document.body.append(container);
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

async function mountPanel(
  blocks: readonly ContextBlock[],
  form: 'phone' | 'wide' = 'wide',
): Promise<void> {
  await mount(<ContextPanel blocks={blocks} form={form} scheme="dark" />);
}

function panel(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[aria-label="session context"]');
}

/** The heading of each block that was drawn, in document order. */
function headings(): string[] {
  return [...container.querySelectorAll('h2')].map((heading) => heading.textContent ?? '');
}

/**
 * Every block the panel put on the page, headed or not.
 *
 * Not `container.textContent`: Mantine's provider writes its stylesheet into
 * the tree, so a container holding nothing of this component's is still not
 * empty, and an assertion against the empty string would be pinning the
 * provider rather than the panel.
 */
function drawn(): Element[] {
  return [...container.querySelectorAll('section, aside')];
}

/** One block, found the way a screen reader finds it: by the name it carries. */
function block(title: string): HTMLElement {
  const section = container.querySelector<HTMLElement>(`section[aria-label="${title}"]`);
  if (section === null) throw new Error(`the panel drew no block titled ${title}`);
  return section;
}

describe('the session context panel', () => {
  it('draws the blocks it was given, in the order it was given them', async () => {
    await mountPanel([TASK, COST]);

    expect(headings()).toEqual(['Task', 'Cost · this session']);
  });

  it('gives each block a heading with its content under it', async () => {
    await mountPanel([TASK, COST]);

    const task = block('Task');
    expect(task.querySelector('h2')?.textContent).toBe('Task');
    expect(task.textContent).toContain('Fix the auth refresh race');
    // And the blocks are separate sections rather than one run of prose: the
    // body of one must never be readable as part of the block above it.
    expect(task.textContent).not.toContain('$1.84');
  });

  it('draws any subset, because no block is a block the frame knows about', async () => {
    // The state three tickets in three epics pass through: one of them has
    // landed and the others have not. A frame that assumed a fixed set would
    // have to draw an empty COST beside a real TASK.
    await mountPanel([COST]);

    expect(headings()).toEqual(['Cost · this session']);
    expect(panel()).not.toBeNull();
  });

  it('is not drawn at all when no block has anything to say', async () => {
    // Not an empty column with a border down its left edge: with nothing in
    // it there is nothing for a fixed 300px to be for, and the terminal beside
    // it is what the space belongs to.
    await mountPanel([]);

    expect(panel()).toBeNull();
    expect(drawn()).toEqual([]);
  });

  it('is not drawn in the phone form, whatever it has to say', async () => {
    // 7e does not draw a phone form for this panel, and a 300px column on a
    // 390px screen is not one. The form comes from the shell -- one breakpoint
    // for the whole app -- rather than from a media query written again here.
    await mountPanel([TASK, COST], 'phone');

    expect(panel()).toBeNull();
    // Not hidden with a style, which would leave the task text in the
    // accessibility tree and in a page search: there is no panel.
    expect(drawn()).toEqual([]);
  });

  it('is the fixed column the mockup draws, and never takes the terminal any', async () => {
    // The width is the mockup's third grid track. Fixed in both directions on
    // purpose: the terminal beside it is the flexible half, and a panel that
    // grew or shrank with the pane would move the terminal's grid every time
    // a divider did.
    await mountPanel([TASK]);

    const style = getComputedStyle(block('Task').parentElement ?? document.body);
    expect(style.width).toBe(`${CONTEXT_PANEL_WIDTH}px`);
    expect([style.flexGrow, style.flexShrink]).toEqual(['0', '0']);
  });
});
