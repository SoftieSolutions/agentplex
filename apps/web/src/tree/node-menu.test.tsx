// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HOME_PROJECT_ID,
  HOME_PROJECT_NAME,
  nodeIdSchema,
  parseHubFrame,
  parseTextFrame,
  type Layout,
  type NodeId,
} from '@agentplex/protocol';
import { createFakeSocketFactory } from '../store/fake-socket.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createFrameIds } from '../store/frame-ids.js';
import { mintClientInstance } from '../store/client-instance.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { colorForRole } from '../ui/tokens.js';
import { NodeMenu } from './node-menu.js';

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

const NODE = nodeIdSchema.parse('node-observatory-notes');

function layoutFrom(text: string): Layout {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'layout') throw new Error('not a layout frame');
  return parsed.value.nodes;
}

/** A tree a real hub sent: HOME first, a folder and sessions in it, a second project. */
const ARRANGED = layoutFrom(hubFrames.layoutArranged);

function nodeOfKind(kind: string): { readonly id: NodeId; readonly name: string } {
  const found = ARRANGED.find(
    (candidate) => candidate.kind === kind && candidate.id !== HOME_PROJECT_ID,
  );
  if (found === undefined) throw new Error(`the captured tree holds no ${kind} but HOME`);
  return { id: found.id, name: found.name ?? found.id };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * One animation frame. Mantine's dropdown places itself with a floating-ui
 * measurement and opens through a transition, so it reaches the document a
 * frame after the click that asked for it.
 */
function frame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

describe('the node menu', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let store: HubStore;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    container = document.createElement('div');
    document.body.append(container);
    const sockets = createFakeSocketFactory();
    store = createHubStore({
      fetchTicket: () => Promise.resolve('ticket-1'),
      createSocket: (ticket) => sockets.create(ticket),
      instance: mintClientInstance(),
      timers: createFakeTimers(),
      frameIds: createFrameIds(),
    });
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  function renderMenu(nodeId: NodeId, name: string, layout: Layout | null): void {
    act(() => {
      root = createRoot(container);
      root.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="dark"
        >
          <NodeMenu
            store={store}
            nodeId={nodeId}
            name={name}
            layout={layout}
            anchor={null}
            scheme="dark"
          />
        </MantineProvider>,
      );
    });
  }

  /** Opens the menu and returns what its dropdown says, label by label. */
  async function openMenu(name: string): Promise<{ items: string[]; labels: string[] }> {
    const trigger = container.querySelector<HTMLButtonElement>(
      `button[aria-label="Actions for ${name}"]`,
    );
    if (trigger === null) throw new Error(`no menu for ${name}`);
    await act(() => {
      trigger.click();
    });
    await act(settle);
    await act(frame);
    await act(settle);
    const texts = (selector: string): string[] =>
      [...document.querySelectorAll<HTMLElement>(selector)].map(
        (element) => element.textContent ?? '',
      );
    return {
      items: texts('[role="menuitem"]'),
      labels: texts('.mantine-Menu-label'),
    };
  }

  it('offers a project a rename and a removal, and no move', async () => {
    const project = nodeOfKind('project');
    renderMenu(project.id, project.name, ARRANGED);

    const { items, labels } = await openMenu(project.name);

    expect(items).toEqual(['Rename', 'Remove from tree']);
    expect(labels).not.toContain('Move to');
  });

  it('draws no menu for HOME, which the hub lets nobody edit', () => {
    renderMenu(HOME_PROJECT_ID, HOME_PROJECT_NAME, ARRANGED);

    expect(
      container.querySelector(`button[aria-label="Actions for ${HOME_PROJECT_NAME}"]`),
    ).toBeNull();
  });

  it('offers a session every project and folder, and not the top level', async () => {
    const session = nodeOfKind('session');
    renderMenu(session.id, session.name, ARRANGED);

    const { items, labels } = await openMenu(session.name);

    // The session sits in a folder and holds nothing, so every container the
    // captured tree has is somewhere it may go, HOME among them.
    const containers = ARRANGED.filter(
      (candidate) => candidate.kind === 'project' || candidate.kind === 'folder',
    ).map((candidate) => candidate.name ?? candidate.id);
    expect(labels).toEqual(['Move to']);
    expect(items).toEqual(['Rename', ...containers, 'Remove from tree']);
    expect(items).toContain(HOME_PROJECT_NAME);
    expect(items).not.toContain('Top level');
  });

  /**
   * Stone is the same hue in both schemes, so this proves the trigger is
   * wired to the muted-text role rather than to Mantine's stock gray; it does
   * not prove the trigger follows the scheme.
   */
  it('paints its trigger in the muted-text role', () => {
    act(() => {
      root = createRoot(container);
      root.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="dark"
        >
          <NodeMenu
            store={store}
            nodeId={NODE}
            name="x"
            layout={null}
            anchor={null}
            scheme="dark"
          />
        </MantineProvider>,
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Actions for x"]',
    );
    expect(trigger).not.toBeNull();
    expect(trigger?.style.getPropertyValue('--button-color')).toBe(
      colorForRole('textMuted', 'dark'),
    );
  });
});
