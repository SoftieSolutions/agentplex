// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HubStore } from '../store/hub-store.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { NodeView, type PaneViewDependencies } from './split-view.js';
import type { LayoutTree } from './tree.js';

/**
 * What a divider claims from the browser, which is every touch that lands on
 * it.
 *
 * A divider is dragged with pointer events, and a pointer event stream over a
 * finger only survives if the browser is not also trying to make the gesture
 * into a scroll: the moment it decides to pan, it takes the pointer away with
 * a `pointercancel` and the drag ends halfway. `touch-action: none` is what
 * says there is no pan to be had here, and it is the whole of why dragging a
 * split works on a phone.
 *
 * It is pinned because it now has a neighbour that says the same word for a
 * different reason -- the terminal box, which claims its touches so that its
 * own gesture handler can cancel them. The two are unrelated: `touch-action`
 * is not inherited, and a reader who assumed it was might well conclude one of
 * the two declarations was redundant. Neither is.
 *
 * Two empty panes, so nothing reaches the hub: `PaneViewDependencies.hub` is
 * read by `SessionPane` and by nothing else in this tree.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const NO_HUB = null as unknown as HubStore;

const SPLIT: LayoutTree = {
  kind: 'split',
  direction: 'row',
  ratio: 0.5,
  first: { kind: 'pane', content: { type: 'empty' } },
  second: { kind: 'pane', content: { type: 'empty' } },
};

let host: HTMLDivElement;
let root: Root;

/** Mantine asks for the colour scheme with one, and jsdom has no answer. */
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

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  installMatchMedia();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

describe('the divider between two panes', () => {
  it('claims every touch on it, so a drag is not taken away mid-gesture', () => {
    const view: PaneViewDependencies = {
      hub: NO_HUB,
      scheme: 'dark',
      focus: [],
      onCommitRatio: () => {},
      onFocusPane: () => {},
      registerPane: () => {},
    };

    act(() => {
      root.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="dark"
        >
          <NodeView node={SPLIT} path={[]} view={view} />
        </MantineProvider>,
      );
    });

    const divider = host.querySelector('[role="separator"]');
    if (!(divider instanceof HTMLElement)) throw new Error('the split drew no divider');
    expect(getComputedStyle(divider).touchAction).toBe('none');
  });
});
