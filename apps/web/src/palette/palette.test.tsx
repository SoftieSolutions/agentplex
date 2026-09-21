// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame, type MachineState } from '@agentplex/protocol';
import { listSessions } from '../sessions/session-list-model.js';
import type { ShellForm } from '../shell/shell-form.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { CommandPalette } from './palette.js';
import { PALETTE_RESULT_LIMIT } from './palette-model.js';

/**
 * The trigger and the dialog, over a fleet a real hub reported: six sessions,
 * two of which want a human.
 *
 * What is ranked, matched and bounded is `palette-model.test.ts`; nothing here
 * re-asserts an order the model already pins. What is pinned here is the
 * control -- that it is a real button whose chord is decoration, that the
 * dialog takes the keystrokes a palette takes, and that following a row is how
 * it ends.
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

/** The dialog's own box is observed by Mantine; jsdom has no observer. */
function installResizeObserver(): void {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

/**
 * React tracks an input's value itself, so assigning `input.value` and firing
 * an event is a change React has already decided did not happen. The setter
 * off the prototype is the one the tracker does not intercept.
 */
function typeInto(input: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter === undefined) throw new Error('no value setter on HTMLInputElement');
  setter.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Lets a promise chain inside the overlay's placement settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** One animation frame: the dialog opens through a transition. */
function frame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the fixture is not a machine-state frame');
  }
  return parsed.value.state;
}

const sessions = listSessions(stateFrom(hubFrames.machineStatePopulated));

describe('the command palette', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  /** Every address the dialog asked the browser for, in order. */
  let went: string[] = [];

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installResizeObserver();
    went = [];
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

  interface Options {
    readonly form?: ShellForm;
    /** The bound, pinned the way the model's own tests pin it: see `paletteListing`. */
    readonly limit?: number;
  }

  function draw({ form = 'wide', limit = PALETTE_RESULT_LIMIT }: Options = {}): void {
    const element: JSX.Element = (
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="dark"
      >
        <CommandPalette
          items={sessions}
          form={form}
          limit={limit}
          scheme="dark"
          navigate={(hash) => {
            went.push(hash);
          }}
        />
      </MantineProvider>
    );
    act(() => {
      root ??= createRoot(container);
      root.render(element);
    });
  }

  function trigger(): HTMLButtonElement {
    const control = container.querySelector<HTMLButtonElement>('button[data-palette-trigger]');
    if (control === null) throw new Error('nothing drew a palette trigger');
    return control;
  }

  /** Lets a dialog that has just been asked for reach the document. */
  async function flush(): Promise<void> {
    await act(settle);
    await act(frame);
    await act(settle);
  }

  /** The dialog, which portals out of the chrome, so the document is the haystack. */
  function dialog(): HTMLElement | null {
    return document.body.querySelector<HTMLElement>('[data-palette-dialog]');
  }

  function openedDialog(): HTMLElement {
    const found = dialog();
    if (found === null) throw new Error('nothing opened');
    return found;
  }

  function field(): HTMLInputElement {
    const input = openedDialog().querySelector<HTMLInputElement>('input');
    if (input === null) throw new Error('the dialog drew no field');
    return input;
  }

  function rows(): readonly HTMLAnchorElement[] {
    return [...openedDialog().querySelectorAll<HTMLAnchorElement>('a[data-palette-result]')];
  }

  function labels(): readonly string[] {
    return rows().map((row) => row.querySelector('[data-palette-label]')?.textContent ?? '');
  }

  /** The row the keyboard is on, by the mark the dialog puts on it. */
  function active(): string {
    const row = rows().find((candidate) => candidate.getAttribute('aria-selected') === 'true');
    return row?.querySelector('[data-palette-label]')?.textContent ?? '';
  }

  async function open(): Promise<void> {
    await act(() => {
      trigger().click();
    });
    await flush();
  }

  async function type(text: string): Promise<void> {
    const input = field();
    await act(() => {
      typeInto(input, text);
    });
  }

  async function press(key: string): Promise<void> {
    const input = field();
    await act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
  }

  /** Waits for a dismissed dialog to leave the document: it fades rather than unmounting. */
  async function untilClosed(): Promise<void> {
    for (let attempt = 0; attempt < 40 && dialog() !== null; attempt += 1) {
      await act(() => new Promise((resolve) => setTimeout(resolve, 25)));
    }
  }

  it('is a real button in both forms, saying what it searches', () => {
    draw({ form: 'wide' });
    expect(trigger().tagName).toBe('BUTTON');
    expect(trigger().textContent).toContain('Search sessions');

    draw({ form: 'phone' });
    expect(trigger().tagName).toBe('BUTTON');
    expect(trigger().textContent).toContain('Search sessions');
  });

  it('draws the chord as text and claims nothing about it', () => {
    draw({ form: 'wide' });

    // The mockup's ⌘K, drawn because the control reads bare without it, and
    // marked so nothing offers it as a way to work the app: no app-level
    // registry exists to bind it, and AGX-260 is where the chords are decided.
    const hint = trigger().querySelector('[data-shortcut-hint]');
    expect(hint?.textContent).toBe('⌘K');
    expect(hint?.getAttribute('aria-hidden')).toBe('true');
    expect(hint?.getAttribute('data-bound')).toBe('false');
    expect(container.querySelector('[aria-keyshortcuts]')).toBeNull();
  });

  it('draws no chord on a phone, which has no keyboard to press it with', () => {
    draw({ form: 'phone' });

    expect(trigger().querySelector('[data-shortcut-hint]')).toBeNull();
  });

  it('opens on the press, with the caret already in the field', async () => {
    draw();
    expect(dialog()).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');

    await open();

    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(field());
  });

  it('rests on the whole fleet, needs-you first, and selects the top row', async () => {
    draw();
    await open();

    expect(labels()).toEqual([
      'migrate-db-v9',
      'docs-sweep',
      'fix-auth-refresh',
      'bench-tokenizer',
      'session-train-lora',
      'spike-wasm',
    ]);
    expect(active()).toBe('migrate-db-v9');
  });

  it('narrows as the query is typed, and keeps a selection on the rows it drew', async () => {
    draw();
    await open();
    await type('universe');

    // A store nothing is named after: the shared matcher is what finds them.
    expect(labels()).toEqual(['docs-sweep', 'bench-tokenizer', 'session-train-lora']);
    expect(active()).toBe('docs-sweep');
  });

  it('moves through the rows with the arrows, and wraps at both ends', async () => {
    draw();
    await open();

    await press('ArrowDown');
    expect(active()).toBe('docs-sweep');
    await press('ArrowUp');
    expect(active()).toBe('migrate-db-v9');
    await press('ArrowUp');
    expect(active()).toBe('spike-wasm');
  });

  it('jumps to the ends with Home and End', async () => {
    draw();
    await open();

    await press('End');
    expect(active()).toBe('spike-wasm');
    await press('Home');
    expect(active()).toBe('migrate-db-v9');
  });

  it('follows the active row on Enter, and closes behind itself', async () => {
    draw();
    await open();
    await press('ArrowDown');
    await press('Enter');
    await untilClosed();

    expect(went).toEqual(['#/session/store-universe/session-docs-sweep']);
    expect(dialog()).toBeNull();
  });

  it('goes nowhere on Enter when nothing matched', async () => {
    draw();
    await open();
    await type('nothing-matches-this');
    await press('Enter');

    expect(went).toEqual([]);
    expect(rows()).toHaveLength(0);
  });

  it('follows a row that is clicked, because a row is a real address', async () => {
    draw();
    await open();

    const row = rows()[0];
    expect(row?.getAttribute('href')).toBe('#/session/store-agentplex/session-migrate-db');
    await act(() => {
      row?.click();
    });
    await untilClosed();

    expect(dialog()).toBeNull();
  });

  it('closes on Escape, having gone nowhere', async () => {
    draw();
    await open();
    await press('Escape');
    await untilClosed();

    expect(dialog()).toBeNull();
    expect(went).toEqual([]);
  });

  it('returns the focus to the trigger it was opened from', async () => {
    draw();
    await open();
    await press('Escape');
    await untilClosed();

    expect(document.activeElement).toBe(trigger());
  });

  it('says how many matched when it drew fewer than that', async () => {
    draw({ limit: 2 });
    await open();

    expect(rows()).toHaveLength(2);
    const words = openedDialog().querySelector('[data-palette-more]')?.textContent ?? '';
    // A silently shortened list claims it found two things when it found six.
    expect(words).toContain('2');
    expect(words).toContain('6');
  });

  it('says nothing about a remainder when it drew everything that matched', async () => {
    draw();
    await open();

    expect(sessions.length).toBeLessThanOrEqual(PALETTE_RESULT_LIMIT);
    expect(openedDialog().querySelector('[data-palette-more]')).toBeNull();
  });

  it('says what to try when nothing matched at all', async () => {
    draw();
    await open();
    await type('nothing-matches-this');

    const words = openedDialog().querySelector('[data-palette-empty]')?.textContent ?? '';
    expect(words).toContain('Nothing matches');
    expect(words).toContain('store');
  });

  it('forgets the query between openings, so it opens on the resting list', async () => {
    draw();
    await open();
    await type('spike');
    expect(labels()).toEqual(['spike-wasm']);

    await press('Escape');
    await untilClosed();
    await open();

    expect(field().value).toBe('');
    expect(labels()).toHaveLength(6);
  });
});
