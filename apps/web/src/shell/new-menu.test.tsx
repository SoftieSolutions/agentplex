// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ONBOARDING_HASH } from '../onboarding/onboarding-route.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { NEW_NODE_KINDS, newMenu, type NewMenu, type NewNodeKind } from './new-menu-model.js';
import { NewMenuButton } from './new-menu.js';

/**
 * The New button and what it opens.
 *
 * Which kinds are offered at all is `new-menu-model.test.ts`; every menu drawn
 * here comes out of `newMenu`, so a kind that goes live changes the table and
 * this file keeps asking the same questions. What is pinned here is what a row
 * is -- a button that asks the shell to make something, or an address that goes
 * somewhere -- and that the chord beside it is drawn without being claimed.
 *
 * Where the button sits in the chrome is `app-shell.test.tsx`.
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

/**
 * The popover measures its target to place itself and jsdom has no layout. A
 * stub that reports nothing is enough -- nothing here asserts on a measurement.
 */
function installResizeObserver(): void {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

/** Lets a promise chain inside the floating placement settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * One animation frame. The dropdown places itself with a floating-ui
 * measurement and opens through a transition, so what a click asks for reaches
 * the document a frame later rather than in the same flush.
 */
function frame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/** The whole table, which is the menu the app draws today. */
const everything = newMenu();

/** One kind built, which is the shape the button had before the table existed. */
const onlySession = newMenu(NEW_NODE_KINDS.filter((row) => row.kind === 'session'));

describe('the New menu', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  /** What the shell was asked to make, in the order it was asked. */
  let picked: NewNodeKind[] = [];

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installResizeObserver();
    picked = [];
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
    // Enroll machine is a real anchor and jsdom follows it, so the address moved.
    window.location.hash = '';
  });

  function draw(menu: NewMenu): void {
    const element: JSX.Element = (
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="dark"
      >
        <NewMenuButton
          menu={menu}
          onPick={(kind) => {
            picked.push(kind);
          }}
          scheme="dark"
        />
      </MantineProvider>
    );
    act(() => {
      root ??= createRoot(container);
      root.render(element);
    });
  }

  function trigger(): HTMLButtonElement {
    const control = container.querySelector<HTMLButtonElement>('button[data-new-menu]');
    if (control === null) throw new Error('nothing drew a New button');
    return control;
  }

  /** Lets a dropdown that has just been asked for reach the document. */
  async function flush(): Promise<void> {
    await act(settle);
    await act(frame);
    await act(settle);
  }

  /** Presses the button the way a person does, and waits for what that opens. */
  async function press(): Promise<void> {
    await act(() => {
      trigger().click();
    });
    await flush();
  }

  /** The dropdown, which portals out of the shell, so the document is the haystack. */
  function dropdown(): HTMLElement | null {
    return document.body.querySelector<HTMLElement>('[data-new-menu-dropdown]');
  }

  function openedDropdown(): HTMLElement {
    const found = dropdown();
    if (found === null) throw new Error('nothing opened');
    return found;
  }

  function rows(): readonly HTMLElement[] {
    return [...openedDropdown().querySelectorAll<HTMLElement>('[data-new-menu-entry]')];
  }

  function row(kind: NewNodeKind): HTMLElement {
    const found = openedDropdown().querySelector<HTMLElement>(`[data-new-menu-entry="${kind}"]`);
    if (found === null) throw new Error(`the menu drew no ${kind} row`);
    return found;
  }

  /**
   * Waits for a dismissed dropdown to actually leave the document: it fades out
   * over a duration rather than unmounting in the flush that asked.
   */
  async function untilClosed(): Promise<void> {
    for (let attempt = 0; attempt < 40 && dropdown() !== null; attempt += 1) {
      await act(() => new Promise((resolve) => setTimeout(resolve, 25)));
    }
  }

  /**
   * Long enough that a dismissal asked for by the click just made would have
   * finished. Asserting a dropdown is still there right after the click proves
   * nothing: it fades out, so it is still in the document either way.
   */
  async function outlastAClose(): Promise<void> {
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
  }

  it('says whether it is open, and opens on the press', async () => {
    draw(everything);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(dropdown()).toBeNull();

    await press();

    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(dropdown()).not.toBeNull();
  });

  it('draws a row per live entry, in the table order, with the words the mockup gives it', async () => {
    draw(everything);
    await press();

    expect(rows().map((element) => element.getAttribute('data-new-menu-entry'))).toEqual(
      everything.entries.map((entry) => entry.kind),
    );
    for (const entry of everything.entries) {
      const text = row(entry.kind).textContent ?? '';
      expect(text).toContain(entry.label);
      expect(text).toContain(entry.description);
    }
  });

  it('draws the chord as text and claims nothing about it', async () => {
    draw(everything);
    await press();

    // The mockup's ⌘N, drawn because the row reads bare without it, and marked
    // so nothing reads it out as a working shortcut: AGX-260 binds the chords.
    const hint = row('session').querySelector('[data-shortcut-hint]');
    expect(hint?.textContent).toBe('⌘N');
    expect(hint?.getAttribute('aria-hidden')).toBe('true');
    expect(hint?.getAttribute('data-bound')).toBe('false');
    expect(openedDropdown().querySelector('[aria-keyshortcuts]')).toBeNull();

    // And nothing where the mockup draws none.
    expect(row('project').querySelector('[data-shortcut-hint]')).toBeNull();
  });

  it('rules off the entry that is an address rather than a thing to make', async () => {
    draw(everything);
    await press();

    const rules = openedDropdown().querySelectorAll('[data-new-menu-rule]');
    expect(rules).toHaveLength(1);
    expect(rules[0]?.nextElementSibling?.getAttribute('data-new-menu-entry')).toBe('machine');
  });

  it('asks the shell to make the things, and links to the one address', async () => {
    draw(everything);
    await press();

    expect(row('session').tagName).toBe('BUTTON');
    expect(row('project').tagName).toBe('BUTTON');
    expect(row('machine').tagName).toBe('A');
    expect(row('machine').getAttribute('href')).toBe(ONBOARDING_HASH);

    await act(() => {
      row('project').click();
    });

    expect(picked).toEqual(['project']);
  });

  it('closes on the entry that was chosen', async () => {
    draw(everything);
    await press();

    await act(() => {
      row('session').click();
    });
    await untilClosed();

    // The form this opens stands over the content; a dropdown left open would
    // stand over the form.
    expect(dropdown()).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on the address too, and treats it as no pick at all', async () => {
    draw(everything);
    await press();

    await act(() => {
      row('machine').click();
    });
    await untilClosed();

    expect(dropdown()).toBeNull();
    // The href is what navigates. Nothing was made, so nothing was picked.
    expect(picked).toEqual([]);
  });

  it('leaves a modified click on the address alone', async () => {
    draw(everything);
    await press();

    // Opening onboarding in a background tab leaves the page where it is, so
    // the menu stays with it -- and the browser, not this component, decides
    // what the click does.
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
    await act(() => {
      row('machine').dispatchEvent(event);
    });
    await outlastAClose();

    expect(event.defaultPrevented).toBe(false);
    expect(dropdown()).not.toBeNull();
  });

  it('is a plain button with no menu behind it when one kind is live', async () => {
    draw(onlySession);

    // What the button did before this table existed: one live option is not a
    // menu, so the press does the thing rather than offering it.
    expect(trigger().getAttribute('aria-haspopup')).toBeNull();
    expect(trigger().textContent).toBe('Session');

    await press();

    expect(dropdown()).toBeNull();
    expect(picked).toEqual(['session']);
  });

  it('draws no button at all when nothing can be made', () => {
    draw(newMenu([]));

    expect(container.querySelector('[data-new-menu]')).toBeNull();
  });
});
