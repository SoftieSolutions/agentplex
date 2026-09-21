// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  nodeKindSchema,
  parseHubFrame,
  parseTextFrame,
  type MachineState,
} from '@agentplex/protocol';
import { listSessions } from '../sessions/session-list-model.js';
import type { ShellForm } from '../shell/shell-form.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { DOC_KIND, PROJECT_KIND, SESSION_KIND } from '../tree/node-kinds.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { CommandPalette } from './palette.js';
import { PALETTE_RESULT_LIMIT, type PaletteResult } from './palette-model.js';
import type { PaletteSearch, PaletteSearchSnapshot } from './palette-search.js';

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

/**
 * A document named after a session, which is the collision the grouping exists
 * for: `spike-wasm` is a session in the fixture fleet and this is a document
 * called the same thing. What the hub's own rows look like is
 * `palette-search.test.ts`, against captured pages; this file needs a hub half
 * it can hold still, so it is handed one.
 */
const NAMESAKE_DOC: PaletteResult = {
  id: 'doc:hub-6',
  kind: DOC_KIND,
  label: 'spike-wasm',
  detail: 'Document',
  href: '#/doc/hub-6',
};

/**
 * A project of that name as well, which is the collision AGX-261 adds: the hub
 * can now answer a flat search with a container, so one name can be a session,
 * a document and a project at once.
 */
const NAMESAKE_PROJECT: PaletteResult = {
  id: 'project:hub-5',
  kind: PROJECT_KIND,
  label: 'spike-wasm',
  detail: 'Project',
  href: '#/projects',
};

const QUIET: PaletteSearchSnapshot = {
  results: [],
  searching: false,
  more: false,
  problem: null,
};

interface SearchDouble {
  readonly search: PaletteSearch;
  /** Every text the dialog asked about, in order. */
  readonly typed: string[];
  /** How many times the dialog said it was done with the answer. */
  resets: number;
  /** The hub half moving, as a test drives it. Call inside `act`. */
  answer(changes: Partial<PaletteSearchSnapshot>): void;
}

/**
 * The hub half as an injected seam rather than a hub.
 *
 * `palette-search.ts` is the thing that talks to the store and it has its own
 * tests; what the dialog has to be pinned against is the snapshot -- rows,
 * searching, more, a refusal -- and a double is the only way to hold one of
 * those still while a keystroke lands.
 */
function searchDouble(): SearchDouble {
  const listeners = new Set<() => void>();
  let snapshot: PaletteSearchSnapshot = QUIET;
  const double: SearchDouble = {
    typed: [],
    resets: 0,
    answer(changes: Partial<PaletteSearchSnapshot>): void {
      snapshot = { ...snapshot, ...changes };
      for (const listener of [...listeners]) listener();
    },
    search: {
      subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      getSnapshot: (): PaletteSearchSnapshot => snapshot,
      search(text: string): void {
        double.typed.push(text);
      },
      reset(): void {
        double.resets += 1;
        snapshot = QUIET;
      },
    },
  };
  return double;
}

describe('the command palette', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  /** Every address the dialog asked the browser for, in order. */
  let went: string[] = [];
  let hub: SearchDouble;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installResizeObserver();
    went = [];
    hub = searchDouble();
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
          search={hub.search}
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

  /** The headings over the rows, in drawn order. */
  function headings(): readonly string[] {
    return [...openedDialog().querySelectorAll('[data-palette-heading]')].map(
      (heading) => heading.textContent ?? '',
    );
  }

  /** The dialog and its rows in drawn order: a heading, then the rows under it. */
  function outline(): readonly string[] {
    return [...openedDialog().querySelectorAll('[data-palette-heading], [data-palette-label]')].map(
      (node) =>
        node.hasAttribute('data-palette-heading')
          ? `# ${node.textContent ?? ''}`
          : (node.textContent ?? ''),
    );
  }

  /** What the off-screen region is saying, which is what is announced. */
  function announced(): string {
    return container.querySelector('[data-palette-announcement]')?.textContent ?? '';
  }

  function words(mark: string): string {
    return openedDialog().querySelector(`[${mark}]`)?.textContent ?? '';
  }

  /** The hub half moving under a drawn dialog. */
  async function answer(changes: Partial<PaletteSearchSnapshot>): Promise<void> {
    await act(() => {
      hub.answer(changes);
    });
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

  /** The same press, mid-composition: what an IME sends before a candidate is picked. */
  async function compose(key: string): Promise<void> {
    const input = field();
    await act(() => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key,
          isComposing: true,
          keyCode: 229,
          bubbles: true,
          cancelable: true,
        }),
      );
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

  it('names the three kinds it can answer with, and claims no graphs', async () => {
    draw();

    // The mockup's field says "sessions, projects, graphs". Projects are real
    // now (AGX-261); the graph kind is unseeded until AGX-144, and a control
    // that offered it would be a promise the hub cannot keep.
    expect(trigger().textContent).toContain('Search sessions, documents and projects');
    expect(trigger().textContent).not.toContain('graph');

    await open();
    expect(field().getAttribute('aria-label')).toContain('projects');
    expect(openedDialog().textContent).not.toContain('graph');
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

  it('asks the hub what was typed, and forgets the question when it closes', async () => {
    draw();
    await open();
    await type('spike');

    expect(hub.typed).toEqual(['spike']);
    const before = hub.resets;
    await press('Escape');
    await untilClosed();
    expect(hub.resets).toBeGreaterThan(before);
  });

  it('draws the two halves under a heading each, the client-held row winning', async () => {
    draw();
    await open();
    await type('spike');
    // The hub returns the session the client already holds, as it does for a
    // real query, plus a document named after it.
    await answer({
      results: [
        {
          id: 'session:["store-agentplex","session-spike-wasm"]',
          kind: SESSION_KIND,
          label: 'spike-wasm',
          detail: 'store-agentplex · idle',
          href: '#/session/store-agentplex/session-spike-wasm',
        },
        NAMESAKE_DOC,
      ],
    });

    expect(outline()).toEqual(['# Sessions', 'spike-wasm', '# Documents', 'spike-wasm']);
    // One session row, not two, and the one that names the machine.
    expect(rows()).toHaveLength(2);
    expect(rows()[0]?.textContent).toContain('mbp-robert');
  });

  it('tells a session and a document of one name apart by where each one goes', async () => {
    draw();
    await open();
    await type('spike');
    await answer({ results: [NAMESAKE_DOC] });

    expect(labels()).toEqual(['spike-wasm', 'spike-wasm']);
    expect(rows().map((row) => row.getAttribute('href'))).toEqual([
      '#/session/store-agentplex/session-spike-wasm',
      '#/doc/hub-6',
    ]);
  });

  it('heads a project row Projects, and tells it from the namesakes of other kinds', async () => {
    draw();
    await open();
    await type('spike');
    await answer({ results: [NAMESAKE_DOC, NAMESAKE_PROJECT] });

    expect(outline()).toEqual([
      '# Sessions',
      'spike-wasm',
      '# Documents',
      'spike-wasm',
      '# Projects',
      'spike-wasm',
    ]);
    // Three rows of one name, told apart by the heading over each, by the
    // second line on each and by where each one goes.
    expect(rows().map((row) => row.getAttribute('href'))).toEqual([
      '#/session/store-agentplex/session-spike-wasm',
      '#/doc/hub-6',
      '#/projects',
    ]);
    expect(rows()[2]?.textContent).toContain('Project');
  });

  it('follows a project row to the tree, the address the app already has for one', async () => {
    draw();
    await open();
    await type('spike');
    await answer({ results: [NAMESAKE_PROJECT] });
    await press('ArrowDown');
    await press('Enter');
    await untilClosed();

    expect(went).toEqual(['#/projects']);
  });

  it('labels a kind it has never heard of with the kind itself', async () => {
    draw();
    await open();
    await type('spike');
    await answer({
      results: [{ ...NAMESAKE_DOC, id: 'graph:1', kind: nodeKindSchema.parse('graph') }],
    });

    // A kind is a row in the hub's table, so one arrives without a release
    // here. It is drawn under its own name rather than dropped.
    expect(headings()).toEqual(['Sessions', 'graph']);
  });

  it('moves the arrows across the groups in drawn order, over the headings', async () => {
    draw();
    await open();
    await type('spike');
    await answer({ results: [NAMESAKE_DOC] });

    expect(active()).toBe('spike-wasm');
    expect(rows()[0]?.getAttribute('href')).toBe('#/session/store-agentplex/session-spike-wasm');
    await press('ArrowDown');

    // The second row is under the next heading, and the heading itself was
    // never a place the selection could land: it is not an option.
    const selected = rows().filter((row) => row.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]?.getAttribute('href')).toBe('#/doc/hub-6');
    expect(openedDialog().querySelectorAll('[data-palette-heading][role="option"]')).toHaveLength(
      0,
    );
  });

  it('follows a document row through the address a document already has', async () => {
    draw();
    await open();
    await type('spike');
    await answer({ results: [NAMESAKE_DOC] });
    await press('ArrowDown');
    await press('Enter');
    await untilClosed();

    expect(went).toEqual(['#/doc/hub-6']);
  });

  it('says the hub is still answering without taking away the rows it has', async () => {
    draw();
    await open();
    await type('spike');
    await answer({ searching: true });

    expect(words('data-palette-searching')).not.toBe('');
    // The client-held half is computed here and owes the hub nothing: a dialog
    // that blanked while the hub thought would flicker through a typed word.
    expect(labels()).toEqual(['spike-wasm']);
    // And it does not claim a miss while an answer is on its way.
    expect(openedDialog().querySelector('[data-palette-empty]')).toBeNull();
  });

  it('says a refusal in words, and it costs the hub-answered half only', async () => {
    draw();
    await open();
    await type('spike');
    await answer({ results: [NAMESAKE_DOC] });
    expect(rows()).toHaveLength(2);

    await answer({
      results: [],
      searching: false,
      problem: 'the connection is down: a catalogue page is a read of now',
    });

    expect(words('data-palette-problem')).toContain('the connection is down');
    expect(labels()).toEqual(['spike-wasm']);
    expect(headings()).toEqual(['Sessions']);
  });

  it('says a miss it could not check as one, rather than as a miss', async () => {
    draw();
    await open();
    await type('nothing-matches-this');
    await answer({
      results: [],
      searching: false,
      problem: 'the connection is down: a catalogue page is a read of now',
    });

    // Nothing is drawn and half the question was never asked: "Nothing matches
    // that" over that is a claim this does not have, and it is the claim a
    // person acts on by retyping a word that was never looked up.
    const empty = words('data-palette-empty');
    expect(empty).not.toContain('Nothing matches that');
    expect(empty).toContain('the hub could not be asked');
    expect(empty).toContain('the connection is down');
    // Said once: with no rows over it the refusal line would be the same
    // sentence a second time, and its own wording is about rows that are still
    // listed, of which there are none.
    expect(openedDialog().querySelector('[data-palette-problem]')).toBeNull();
    // What is seen and what is announced are the one answer.
    expect(announced()).toBe(empty);
  });

  it('says the hub had more matches than the rows account for', async () => {
    draw();
    await open();
    await type('spike');
    await answer({ results: [NAMESAKE_DOC], more: true });

    expect(words('data-palette-more')).toContain('more');
  });

  it('announces the count, and the miss, in a region that was already mounted', async () => {
    draw();
    // Mounted before it has words: a live region that arrives with its text
    // is a region a screen reader has nothing to compare against.
    expect(container.querySelector('[data-palette-announcement]')).not.toBeNull();
    expect(announced()).toBe('');

    await open();
    expect(announced()).toContain('6');

    await type('spike');
    expect(announced()).toContain('1 match');

    await type('nothing-matches-this');
    expect(announced()).toContain('Nothing matches');
  });

  it('announces that the hub could not be asked rather than claiming a miss', async () => {
    draw();
    await open();
    // Nothing this browser holds matches, so the only half that could have
    // answered is the one that just refused.
    await type('nothing-matches-this');
    await answer({
      results: [],
      searching: false,
      problem: 'the connection is down: a catalogue page is a read of now',
    });

    // "Nothing matches that" is a claim about a question the hub never
    // answered, and the refusal line under the rows is not in a live region:
    // what is announced has to carry it.
    expect(announced()).toContain('could not be asked');
    expect(announced()).toContain('the connection is down');
    expect(announced()).not.toContain('Nothing matches that.');
  });

  it('announces the refusal beside the count when the client-held rows stand', async () => {
    draw();
    await open();
    await type('spike');
    await answer({
      results: [],
      searching: false,
      problem: 'the connection is down: a catalogue page is a read of now',
    });

    // One row is drawn and it is this browser's own: a count announced alone
    // would present half an answer as the whole of one.
    expect(labels()).toEqual(['spike-wasm']);
    expect(announced()).toContain('1 match');
    expect(announced()).toContain('the connection is down');
  });

  it('ignores the keyboard while a candidate is being composed', async () => {
    draw();
    await open();
    await type('spike');

    // Committing an IME candidate is an Enter the field has already spent. A
    // palette that followed it would navigate away mid-word, and the arrows
    // would walk the results instead of the candidate list.
    await compose('Enter');
    expect(went).toEqual([]);
    expect(dialog()).not.toBeNull();

    await compose('ArrowDown');
    expect(active()).toBe('spike-wasm');
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
