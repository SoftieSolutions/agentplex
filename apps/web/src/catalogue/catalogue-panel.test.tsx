// @vitest-environment jsdom
import {
  nodeIdSchema,
  parseHubFrame,
  parseTextFrame,
  type Layout,
  type MachineState,
  type NodeId,
} from '@agentplex/protocol';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LayoutSnapshot, LayoutStore } from '../layout/layout-store.js';
import { DEFAULT_TREE } from '../layout/tree.js';
import { createFakeSocketFactory } from '../store/fake-socket.js';
import { createFrameIdCounter } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { DEFAULT_SHAPE, NO_PAGES, pageAdopted, type CataloguePages } from './catalogue-model.js';
import { CataloguePanel } from './catalogue-panel.js';
import type { CatalogueSnapshot, CatalogueStore } from './catalogue-store.js';

/**
 * The filter box over the tree, and the line under the tree that says what it
 * is not showing.
 *
 * That line is the whole reason AGX-135 exists: a tree that quietly drops
 * branches lets somebody conclude a thing is not there when it is only
 * hidden. The rules it draws by are pure functions with their own tests next
 * door; what this pins is that the sentence reaches the screen, over a page
 * the hub really answered with -- a folder holding a project holding a
 * document, and one session outside all of it.
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

/** Mantine's controls observe their box; jsdom has no layout and no observer. */
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

/** A page of the tree as a hub really answered one. */
function heldPages(text: string): CataloguePages {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'catalogue-page') {
    throw new Error('the captured frame is not a catalogue page');
  }
  const { items, nextCursor, total, version } = parsed.value;
  return pageAdopted(NO_PAGES, { items, nextCursor, total, version }, 'replace');
}

/** The fleet as the hub really reported one. */
function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the captured frame is not a machine state');
  }
  return parsed.value.state;
}

/** What the layout store was asked to write, for a test to read back. */
interface RecordingLayout extends LayoutStore {
  readonly toggled: readonly NodeId[];
}

/**
 * A layout store that records what it is asked to write and writes nothing.
 *
 * The seam the panel already offers, rather than the real store over a fake
 * socket: what matters here is whether the panel asks for an arrangement
 * change at all, and the real store answers that question with a debounce, a
 * hub round trip and a rule about not writing before the first answer has
 * arrived -- all of which have their own suite, and any of which could hide
 * an ask that this panel should never have made.
 */
function recordingLayout(collapsed: readonly NodeId[]): RecordingLayout {
  const toggled: NodeId[] = [];
  const snapshot: LayoutSnapshot = {
    loaded: true,
    tree: DEFAULT_TREE,
    focus: [],
    collapsed,
  };
  return {
    toggled,
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    split: () => {},
    close: () => {},
    commitRatio: () => {},
    showSession: () => {},
    showDoc: () => {},
    showPendingSession: () => {},
    focusMove: () => {},
    focusPane: () => {},
    toggleCollapsed: (nodeId: NodeId) => {
      toggled.push(nodeId);
    },
  };
}

/**
 * A catalogue store holding one answer and asking for nothing.
 *
 * Injected rather than faked at the socket: this suite is about what the panel
 * draws over a held answer, and a store that re-queried would put the paging
 * rules -- which have their own suite -- between the test and the sentence.
 */
function fixedCatalogue(pages: CataloguePages): CatalogueStore {
  const snapshot: CatalogueSnapshot = {
    shape: DEFAULT_SHAPE,
    pages,
    loading: false,
    notice: null,
    problem: null,
  };
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    reshape: () => {},
    loadMore: () => {},
  };
}

/** No fleet answered yet, which is not the same as an empty one. */
const NO_FLEET = { state: null, layout: null } as const;

describe('the catalogue panel', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let store: HubStore;
  let arrangement: RecordingLayout;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installResizeObserver();
    container = document.createElement('div');
    document.body.append(container);
    const sockets = createFakeSocketFactory();
    store = createHubStore({
      fetchTicket: () => Promise.resolve('ticket-1'),
      createSocket: (ticket) => sockets.create(ticket),
      timers: createFakeTimers(),
      frameIds: createFrameIdCounter(),
    });
    arrangement = recordingLayout([]);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  function withProvider(element: JSX.Element): JSX.Element {
    return (
      <MantineProvider
        theme={theme}
        cssVariablesResolver={cssVariablesResolver}
        defaultColorScheme="dark"
      >
        {element}
      </MantineProvider>
    );
  }

  interface Fleet {
    readonly state: MachineState | null;
    readonly layout: Layout | null;
  }

  async function mount(pages: CataloguePages, fleet: Fleet = NO_FLEET): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(
        withProvider(
          <CataloguePanel
            store={store}
            state={fleet.state}
            layout={fleet.layout}
            scheme="dark"
            catalogue={fixedCatalogue(pages)}
            layoutStore={arrangement}
          />,
        ),
      );
    });
  }

  /**
   * The rows' chevrons, by the label the row gives them. Not by
   * `[aria-expanded]`, which the sort menu carries too.
   */
  function disclosures(): HTMLElement[] {
    return [
      ...container.querySelectorAll<HTMLElement>(
        '[aria-label^="Expand "], [aria-label^="Collapse "]',
      ),
    ];
  }

  async function click(target: Element): Promise<void> {
    await act(() => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  }

  function filterBox(): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Filter tree"]');
    if (input === null) throw new Error('the tree has no filter box');
    return input;
  }

  async function filterBy(text: string): Promise<void> {
    const input = filterBox();
    await act(() => {
      typeInto(input, text);
    });
  }

  function words(): string {
    return container.textContent ?? '';
  }

  it('says how many nodes the filter is hiding, under the tree it filtered', async () => {
    await mount(heldPages(hubFrames.catalogueTreePage));
    expect(words()).toContain('spike-wasm');

    await filterBy('plan');

    // The document matched; the project and folder over it are where it is;
    // the session outside them is the one node hidden, and it is counted.
    expect(words()).toContain('plan.md');
    expect(words()).toContain('agentplex (main checkout)');
    expect(words()).toContain('this week');
    expect(words()).not.toContain('spike-wasm');
    expect(words()).toContain('1 hidden by filter');
  });

  it('says the filter matched nothing rather than drawing an empty project list', async () => {
    await mount(heldPages(hubFrames.catalogueTreePage));

    await filterBy('nothing here is called this');

    expect(words()).toContain('nothing in the tree matches this filter');
    expect(words()).not.toContain('hidden by filter');
    expect(words()).not.toContain('nothing in the catalogue yet');
    expect(words()).not.toContain('plan.md');
  });

  it('says nothing at all while the box is empty', async () => {
    await mount(heldPages(hubFrames.catalogueTreePage));
    expect(words()).not.toContain('hidden by filter');

    await filterBy('plan');
    await filterBy('  ');

    expect(words()).not.toContain('hidden by filter');
    expect(words()).toContain('spike-wasm');
  });

  it('counts only what it holds while pages remain', async () => {
    // The tree page is half an answer, so neither sentence may speak for the
    // pages nobody has asked for yet.
    await mount(heldPages(hubFrames.catalogueTreePagePartial));

    await filterBy('later');

    expect(words()).toContain('1 hidden by filter, of what has loaded so far');
  });

  it('clears the filter from the button in the box', async () => {
    await mount(heldPages(hubFrames.catalogueTreePage));
    await filterBy('plan');
    expect(words()).toContain('1 hidden by filter');

    const clear = container.querySelector('[aria-label="Clear the tree filter"]');
    if (clear === null) throw new Error('a filled filter box offers no way to clear it');
    await click(clear);

    expect(filterBox().value).toBe('');
    expect(words()).not.toContain('hidden by filter');
    expect(words()).toContain('spike-wasm');
    expect(container.querySelector('[aria-label="Clear the tree filter"]')).toBeNull();
  });

  it('arranges nothing while a filter is on, and offers nothing that would', async () => {
    arrangement = recordingLayout([nodeIdSchema.parse('hub-5')]);
    await mount(heldPages(hubFrames.catalogueTreePage));

    // Unfiltered, the disclosures are real: the closed project hides its
    // document, and a click on one is a change to the arrangement that goes to
    // the hub and to every other client looking at this tree.
    expect(words()).not.toContain('plan.md');
    const chevron = disclosures()[0];
    if (chevron === undefined) throw new Error('the tree offers no disclosure');
    await click(chevron);
    expect(arrangement.toggled).toHaveLength(1);

    await filterBy('plan');

    // Filtered, there is nothing closed and nothing offering to close: a
    // chevron that looked inert and wrote anyway is how somebody reorders
    // their tree by clicking at a folder that is already open.
    expect(words()).toContain('plan.md');
    expect(disclosures()).toEqual([]);
    expect(arrangement.toggled).toHaveLength(1);
  });

  it('puts away the sessions that are not in the tree while the tree is filtered', async () => {
    // They are not tree nodes, so the filter neither narrows them nor counts
    // them, and a list left standing under "nothing matches" reads as the rows
    // that survived it.
    await mount(heldPages(hubFrames.catalogueTreePage), {
      state: stateFrom(hubFrames.machineStatePopulated),
      layout: [],
    });
    expect(words()).toContain('Not in your tree');

    await filterBy('nothing here is called this');

    expect(words()).toContain('nothing in the tree matches this filter');
    expect(words()).not.toContain('Not in your tree');
  });
});
