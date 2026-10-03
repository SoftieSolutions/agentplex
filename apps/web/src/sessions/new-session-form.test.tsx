// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HOME_PROJECT_ID,
  nodeIdSchema,
  parseClientFrame,
  parseHubFrame,
  parseTextFrame,
  type CatalogueQuery,
  type ClientFrame,
  type HubFrame,
} from '@agentplex/protocol';
import { createFakeSocketFactory, type FakeSocket } from '../store/fake-socket.js';
import { createFrameIds } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { NewSessionForm } from './new-session-form.js';

/**
 * What the form does with a refusal that names a holder, and which project a
 * start goes to.
 *
 * The refusals delivered here are captured: a real hub answered a real start
 * and a real stop with each of them, holder and all. What is asserted is that
 * the machine on the holder reaches the screen -- "it is running over here" is
 * a different answer from "no", and a client that drops the field leaves the
 * user with the second one.
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

/** The dialog observes its own box to trap focus; jsdom has no layout. */
function installResizeObserver(): void {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

/** A chooser opened on a value scrolls that option into view; jsdom has no scrolling. */
function installScrollIntoView(): void {
  Element.prototype.scrollIntoView = () => {};
}

/** The autosizing prompt waits on the font set; jsdom ships none. */
function installFontFaceSet(): void {
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { addEventListener: () => {}, removeEventListener: () => {} },
  });
}

function capturedLayout(): Extract<HubFrame, { type: 'layout' }> {
  const parsed = parseTextFrame(parseHubFrame, hubFrames.layoutWithProject);
  if (!parsed.ok || parsed.value.type !== 'layout') {
    throw new Error('the fixture is not a layout frame');
  }
  return parsed.value;
}

/**
 * The captured tree with a second project beside the one the capture made: a
 * copy of the captured project node under its own id and name, so every field
 * but those is what the hub sent.
 */
function layoutWithTwoProjects(): string {
  const frame = capturedLayout();
  const captured = frame.nodes.find((node) => node.id === 'hub-5');
  if (captured === undefined) throw new Error('the capture made no project');
  const second = { ...captured, id: nodeIdSchema.parse('hub-90'), position: 2, name: 'scratch' };
  return JSON.stringify({ ...frame, nodes: [...frame.nodes, second] });
}

/**
 * The captured tree with HOME and nothing else: every node outside HOME taken
 * away, the rest exactly as the hub sent them, which is what a hub with no
 * project of its own sends.
 */
function layoutWithOnlyHome(): string {
  const frame = capturedLayout();
  const nodes = frame.nodes.filter(
    (node) => node.id === HOME_PROJECT_ID || node.parentId === HOME_PROJECT_ID,
  );
  return JSON.stringify({ ...frame, nodes });
}

/** Lets the ticket promise inside `connect` settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('the new-session form', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let store: HubStore;
  let sockets: ReturnType<typeof createFakeSocketFactory>;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installResizeObserver();
    installFontFaceSet();
    installScrollIntoView();
    container = document.createElement('div');
    document.body.append(container);
    sockets = createFakeSocketFactory();
    store = createHubStore({
      fetchTicket: () => Promise.resolve('ticket-1'),
      createSocket: (ticket) => sockets.create(ticket),
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

  /**
   * The page's standing catalogue question, which the session list behind this
   * modal is already holding open on the same store.
   *
   * It is here because the frame numbering is: this form is opened from the
   * session list, so in the app its first command is numbered after the list's
   * layout request and catalogue query. The captured refusals below answer
   * those numbers, and a mount that skipped what the app always sends would be
   * asserting against a conversation no browser has.
   */
  const LIST_QUERY: CatalogueQuery = {
    view: 'list',
    groupBy: 'none',
    sort: { key: 'updatedAt', direction: 'desc' },
    filter: {},
    cursor: null,
    limit: 50,
    openProjects: null,
  };

  /**
   * The form open on a store whose connection has reached a captured state
   * with exactly one store in it -- one store is not a choice, so the only
   * thing left to pick is the provider, which `chooseProvider` below does.
   */
  /** Every start handle the form opened a pane on, in the order it did. */
  let opened: number[] = [];

  async function mountForm(): Promise<FakeSocket> {
    opened = [];
    await act(async () => {
      root = createRoot(container);
      root.render(
        withProvider(
          <NewSessionForm
            store={store}
            opened
            onClose={() => {}}
            scheme="dark"
            navigate={() => {}}
            onPending={(startId) => opened.push(startId)}
          />,
        ),
      );
    });
    await act(settle);
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the form dialled nothing');
    await act(() => {
      socket.open();
      socket.deliver(hubFrames.welcome);
      socket.deliver(hubFrames.machineStateSingle);
    });
    // Never answered, and it does not need to be: what it is here for is the
    // frame it occupies. It is abandoned when the store stops listening, which
    // is a rejection nothing is waiting on.
    await act(() => {
      void store.queryCatalogue(LIST_QUERY).catch(() => undefined);
    });
    return socket;
  }

  /** What the form put on the wire, read back through the hub's own parser. */
  function sentFrames(socket: FakeSocket): ClientFrame[] {
    return socket.sent.map((text) => {
      const parsed = parseTextFrame(parseClientFrame, text);
      if (!parsed.ok) throw new Error(`the form sent something unreadable: ${parsed.reason}`);
      return parsed.value;
    });
  }

  /** The dialog renders into a portal, so the whole document is the haystack. */
  function shown(): string {
    return document.body.textContent ?? '';
  }

  function button(label: string): HTMLButtonElement {
    const found = [...document.body.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === label,
    );
    if (found === undefined) throw new Error(`no button labelled ${label}`);
    return found;
  }

  async function submit(): Promise<void> {
    await act(() => {
      button('Start session').click();
    });
  }

  /**
   * Picks a provider, which the form insists on whenever a machine reported
   * more than one. The captured single-machine state reports two, so a start
   * from this form is blocked until somebody says which.
   */
  async function chooseProvider(provider: string): Promise<void> {
    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Provider"]');
    if (input === null) throw new Error('the form drew no provider chooser');
    await act(() => {
      input.click();
    });
    const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (candidate) => candidate.textContent === provider,
    );
    if (option === undefined) throw new Error(`the chooser offered no ${provider}`);
    await act(() => {
      option.click();
    });
  }

  it('opens a pane on the start itself, by the id of the frame that carried it', async () => {
    const socket = await mountForm();
    await chooseProvider('claude');

    await submit();

    // The start this form sent is frame 4 -- the list behind it asks for the
    // tree and a catalogue page first -- and that number is the whole of what
    // a pending pane is opened on. In the click that sent it, before the hub
    // has answered anything: a spawn prints from the fork onwards, and the
    // frame id is the only name it has until the provider writes one.
    expect(opened).toEqual([4]);
    const sent = sentFrames(socket).at(-1);
    expect(sent?.type === 'session-start' ? sent.id : null).toBe(4);
  });

  it('opens no pane for a start the queue would not take', async () => {
    await mountForm();
    await chooseProvider('claude');
    // The connection goes, so the command is neither sent nor queued for a
    // start, which is intent about now. Nothing was asked, so there is nothing
    // for a pane to wait on.
    await act(() => {
      sockets.sockets[0]?.drop();
    });

    expect(button('Start session').disabled).toBe(true);
    expect(opened).toEqual([]);
  });

  it('names the machine already running the session it was refused for', async () => {
    const socket = await mountForm();
    await chooseProvider('claude');

    // The start this form sent is frame 4 -- the list behind it asks for the
    // tree and a catalogue page first -- which is the frame this captured
    // refusal answers.
    await submit();
    await act(() => {
      socket.deliver(hubFrames.refusalHeldBusy);
    });

    expect(shown()).toContain(
      'that session is mid-turn; stopping it now could leave an edit half applied',
    );
    expect(shown()).toContain('held by mbp-robert');
  });

  it('offers no stop for a holder the server will not interrupt', async () => {
    const socket = await mountForm();
    await chooseProvider('claude');
    await submit();

    await act(() => {
      socket.deliver(hubFrames.refusalHeldBusy);
    });

    expect(document.body.querySelector('button[aria-label^="stop "]')).toBeNull();
  });

  it('offers none either when the start named no session to aim one at', async () => {
    const socket = await mountForm();
    await chooseProvider('claude');
    // The second start is frame 5, which the stoppable-holder refusal answers.
    await submit();
    await act(() => {
      socket.deliver(hubFrames.refusalHeldBusy);
    });
    await submit();

    await act(() => {
      socket.deliver(hubFrames.refusalHeldStoppable);
    });

    // The holder can be stopped, and there is still nothing to aim at: this
    // flow starts new sessions, and a new session has no id until the provider
    // writes one. The machine is named anyway, which is the half that is true.
    expect(shown()).toContain('that session is already running on mbp-robert');
    expect(shown()).toContain('held by mbp-robert');
    expect(document.body.querySelector('button[aria-label^="stop "]')).toBeNull();
  });

  /** The tree delivered to the form, as the hub answers its layout request. */
  async function deliverTree(socket: FakeSocket, layout: string): Promise<void> {
    await act(() => {
      socket.deliver(layout);
    });
  }

  function projectInput(): HTMLInputElement {
    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Project"]');
    if (input === null) throw new Error('the form drew no project chooser');
    return input;
  }

  /** The project chooser's own options, opened: every chooser keeps its list in the page. */
  async function openProjects(): Promise<HTMLElement[]> {
    await act(() => {
      projectInput().click();
    });
    const list = document.getElementById(projectInput().getAttribute('aria-controls') ?? '');
    if (list === null) throw new Error('the project chooser has no list');
    return [...list.querySelectorAll<HTMLElement>('[role="option"]')];
  }

  async function chooseProject(label: string): Promise<void> {
    const option = (await openProjects()).find((candidate) => candidate.textContent === label);
    if (option === undefined) throw new Error(`the chooser offered no ${label}`);
    await act(() => {
      option.click();
    });
  }

  function lastStart(socket: FakeSocket): Extract<ClientFrame, { type: 'session-start' }> {
    const start = sentFrames(socket).findLast((frame) => frame.type === 'session-start');
    if (start === undefined || start.type !== 'session-start') throw new Error('no start was sent');
    return start;
  }

  describe('the project a start goes to', () => {
    it('lists HOME first and opens on it, with no empty choice and nothing to clear', async () => {
      const socket = await mountForm();
      await deliverTree(socket, layoutWithTwoProjects());

      // HOME is what a start in no project would have been, so it is the
      // default rather than a second name for "No project" beside it.
      expect(projectInput().value).toBe('HOME');
      expect(projectInput().placeholder).toBe('');
      const wrapper = projectInput().closest('.mantine-Select-root');
      if (wrapper === null) throw new Error('the chooser has no root');
      expect(wrapper.querySelectorAll('button')).toHaveLength(0);
      const options = await openProjects();
      expect(options.map((option) => option.textContent)).toEqual([
        'HOME',
        'agentplex (main checkout)',
        'scratch',
      ]);
      expect(shown()).not.toContain('No project');
    });

    it('starts in HOME when the chooser is left alone', async () => {
      const socket = await mountForm();
      await deliverTree(socket, layoutWithTwoProjects());
      await chooseProvider('claude');

      await submit();

      expect(lastStart(socket).project).toBe(HOME_PROJECT_ID);
    });

    it('starts in the project picked, by its node id', async () => {
      const socket = await mountForm();
      await deliverTree(socket, layoutWithTwoProjects());
      await chooseProvider('claude');
      await chooseProject('agentplex (main checkout)');

      await submit();

      expect(lastStart(socket).project).toBe('hub-5');
    });

    it('names HOME in words when it is the only project, and starts there', async () => {
      const socket = await mountForm();
      await deliverTree(socket, layoutWithOnlyHome());
      await chooseProvider('claude');

      // One project is not a choice, the rule the store and the provider follow.
      expect(document.body.querySelector('input[aria-label="Project"]')).toBeNull();
      expect(shown()).toContain('project: HOME');
      await submit();

      expect(lastStart(socket).project).toBe(HOME_PROJECT_ID);
    });

    it('starts in HOME before the tree has arrived, never in no project', async () => {
      const socket = await mountForm();
      await chooseProvider('claude');

      await submit();

      // HOME is a well-known id, not a node the form has to have read, and a
      // start that said `null` would be HOME under a spelling the form no
      // longer uses.
      expect(lastStart(socket).project).toBe(HOME_PROJECT_ID);
    });
  });
});
