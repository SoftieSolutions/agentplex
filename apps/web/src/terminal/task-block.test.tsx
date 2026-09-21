// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { TASK_PROSE_MAX_HEIGHT, TaskBlock } from './task-block.js';

/**
 * The body of the TASK block: a person's own prompt, drawn in a 300px column
 * beside a terminal.
 *
 * Two of these tests are about what the text is not allowed to do to the
 * screen around it. The prompt is user-typed and unbounded up to the wire's
 * 2000 characters, so it is the one string on this screen that can be an
 * essay, and the blocks under it -- approvals, cost, the machine -- are the
 * ones that would be pushed off the bottom of the panel by it. That it is text
 * and never markup is the other: nothing between the start form and here has
 * any business interpreting a `<` the user typed.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

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

async function mountTask(task: string): Promise<void> {
  const element: JSX.Element = <TaskBlock task={task} scheme="dark" />;
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

/** The prose element itself, which is the block's whole body. */
function prose(): HTMLElement {
  const found = container.querySelector<HTMLElement>('[data-task-prose]');
  if (found === null) throw new Error('the block drew no task');
  return found;
}

/** Everything drawn in monospace, which is how the mockup marks a branch. */
function monospaced(): string[] {
  return [...prose().querySelectorAll<HTMLElement>('span')]
    .filter((span) => span.style.fontFamily.includes('monospace'))
    .map((span) => span.textContent ?? '');
}

describe('the TASK block', () => {
  it('shows the prompt the session was started with', async () => {
    await mountTask('Fix the auth refresh race when two tabs refresh at once.');

    expect(prose().textContent).toBe('Fix the auth refresh race when two tabs refresh at once.');
  });

  it('marks the branch inside the prose the way the mockup does', async () => {
    await mountTask('Add a regression test and open a PR against main.');

    expect(monospaced()).toEqual(['main']);
    // And the sentence is still the sentence: the mark is a span inside it,
    // not a rewrite of it.
    expect(prose().textContent).toBe('Add a regression test and open a PR against main.');
  });

  it('draws a prompt with no branch-like token as plain prose', async () => {
    await mountTask('Work out why the nightly job takes eleven minutes.');

    expect(monospaced()).toEqual([]);
  });

  it('draws the prompt as text and never as markup', async () => {
    // The task is whatever somebody typed into the start form. React escapes
    // it because the block hands it over as a child and not as HTML, and this
    // is the test that says so out loud -- it is the one assertion here that
    // would go quiet if somebody reached for `dangerouslySetInnerHTML` to get
    // the branch marked with less code.
    await mountTask('Ship <b>the thing</b> & <img src=x onerror="alert(1)">');

    expect(prose().querySelector('b')).toBeNull();
    expect(prose().querySelector('img')).toBeNull();
    expect(prose().textContent).toBe('Ship <b>the thing</b> & <img src=x onerror="alert(1)">');
  });

  it('wraps inside the column rather than widening it', async () => {
    // A prompt can carry a URL or a path with no space in it for eighty
    // characters, and the column it is in is 300 fixed pixels that the
    // terminal beside it has already given up.
    await mountTask('See https://example.internal/builds/2026/09/21/auth-refresh-race-report');

    expect(prose().style.overflowWrap).toBe('anywhere');
  });

  it('is bounded in height and scrolls itself rather than pushing the panel', async () => {
    // The blocks under this one belong to other tickets and are the ones that
    // would go off the bottom of the panel. An essay costs its own block.
    await mountTask('A prompt long enough to matter. '.repeat(40));

    const style = prose().style;
    expect(style.maxHeight).toBe(`${TASK_PROSE_MAX_HEIGHT}px`);
    expect(style.overflowY).toBe('auto');
  });
});
