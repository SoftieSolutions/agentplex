// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseHubFrame,
  parseTextFrame,
  type MachineState,
  type SessionRef,
} from '@agentplex/protocol';
import { NO_FILTERS, visibleSessions } from '../sessions/session-list-model.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import type { HubSnapshot, HubStore } from '../store/hub-store.js';
import { destinationHash } from '../shell/destinations.js';
import { sessionHash } from '../terminal/session-route.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { NodeView, type PaneViewDependencies } from './split-view.js';
import type { LayoutTree, PanePath } from './tree.js';

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
 * Two empty panes, so no socket is opened: an empty pane reads the fleet out
 * of the snapshot (AGX-119) and nothing here starts a terminal, so the hub is
 * a stub that answers one question.
 *
 * The second suite is the picker that fills an empty pane. What it pins is
 * that a pane offers what the fleet holds and hands back the pane it belongs
 * to -- the second half being the one that has a silent failure mode, since a
 * picker that named no pane would open its session wherever focus happened to
 * be.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the fixture is not a machine-state frame');
  }
  return parsed.value.state;
}

/**
 * A hub that answers with one captured fleet and never changes.
 *
 * The empty pane reads the snapshot through `useHubSnapshot`, which is
 * `useSyncExternalStore`: a subscribe that never fires and a snapshot that is
 * the same object every call is everything it needs, and it is the whole of
 * what this suite lets the panes see.
 */
function hubWith(state: MachineState | null): HubStore {
  const snapshot = { machineState: state } as unknown as HubSnapshot;
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  } as unknown as HubStore;
}

const NO_HUB = hubWith(null);

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
      onShowSession: () => {},
      sessionsOnScreen: new Set(),
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

describe('the picker in an empty pane', () => {
  const populated = stateFrom(hubFrames.machineStatePopulated);
  const storeId = visibleSessions(populated, NO_FILTERS)[0]?.ref.storeId;
  if (storeId === undefined) throw new Error('the captured fleet holds no session');

  function drawEmptyPane(
    hub: HubStore,
    path: PanePath = [],
    sessionsOnScreen: ReadonlySet<string> = new Set(),
  ): (PanePath | SessionRef)[][] {
    const picked: (PanePath | SessionRef)[][] = [];
    const view: PaneViewDependencies = {
      hub,
      scheme: 'dark',
      focus: [],
      onCommitRatio: () => {},
      onFocusPane: () => {},
      onShowSession: (paneAt, session) => picked.push([paneAt, session]),
      sessionsOnScreen,
      registerPane: () => {},
    };
    act(() => {
      root.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="dark"
        >
          <NodeView node={{ kind: 'pane', content: { type: 'empty' } }} path={path} view={view} />
        </MantineProvider>,
      );
    });
    return picked;
  }

  it('offers every session the fleet holds, needs-you first', () => {
    drawEmptyPane(hubWith(populated));

    const rows = [...host.querySelectorAll('button')].map((button) => button.textContent ?? '');
    expect(rows).toHaveLength(6);
    // The list model's own partition, not an order of this file's: the
    // session waiting on a human leads, so the pane and the session list
    // agree about what matters.
    expect(rows[0]).toContain('migrate-db-v9');
  });

  it('hands back the pane it belongs to, not the one that happens to be focused', () => {
    const picked = drawEmptyPane(hubWith(populated), ['second']);

    act(() => {
      host.querySelector('button')?.click();
    });

    expect(picked).toHaveLength(1);
    expect(picked[0]?.[0]).toEqual(['second']);
  });

  it('leaves out a session another pane is already showing', () => {
    // `showSession` moves the focus for a session already on screen rather
    // than putting a second copy of it anywhere, so a row for one would jump
    // the focus away and leave this pane exactly as empty. The arrangement is
    // the ordinary one: open a session, split, look at the new pane.
    drawEmptyPane(
      hubWith(populated),
      ['second'],
      new Set([sessionHash({ storeId, sessionId: 'session-migrate-db' } as SessionRef)]),
    );

    const rows = [...host.querySelectorAll('button')].map((button) => button.textContent ?? '');
    expect(rows).toHaveLength(5);
    expect(rows.join(' ')).not.toContain('migrate-db-v9');
  });

  it('offers nothing, and says why, when every session is already in a pane', () => {
    const everySession = new Set(
      visibleSessions(populated, NO_FILTERS).map((item) => sessionHash(item.ref)),
    );

    drawEmptyPane(hubWith(populated), [], everySession);

    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(host.textContent).toContain('Every session is already open in a pane');
    // Starting another is the way out that is not closing the pane, so both
    // are offered.
    expect(host.querySelector('a')?.getAttribute('href')).toBe(destinationHash('sessions'));
    expect(host.textContent).toContain('Ctrl+Shift+X');
  });

  it('keeps the way out of a pane it cannot fill', () => {
    drawEmptyPane(NO_HUB);

    expect(host.textContent).toContain('Ctrl+Shift+X');
  });

  it('says the hub has not answered rather than showing an empty picker', () => {
    drawEmptyPane(NO_HUB);

    expect(host.textContent).toContain('No session here yet');
    expect(host.textContent).toContain('has not answered');
    expect(host.querySelectorAll('button')).toHaveLength(0);
  });

  it('points at the session list when the fleet holds no session at all', () => {
    drawEmptyPane(hubWith(stateFrom(hubFrames.machineState)));

    const link = host.querySelector('a');
    expect(link?.getAttribute('href')).toBe(destinationHash('sessions'));
  });
});
