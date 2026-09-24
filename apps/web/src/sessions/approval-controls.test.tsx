// @vitest-environment jsdom
import {
  approvalIdSchema,
  nodeIdSchema,
  parseClientFrame,
  parseTextFrame,
  type ApprovalOutcome,
  type ClientFrame,
} from '@agentplex/protocol';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeSocketFactory, type FakeSocket } from '../store/fake-socket.js';
import { createFrameIdCounter } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { ApprovalControls } from './approval-controls.js';
import { TOO_LONG_TO_REMEMBER_WORDS, type SessionProject } from './approval-policy-model.js';
import { listSessions, type SessionListItem } from './session-list-model.js';

/**
 * The two buttons a blocked agent is waiting on, driven against a real hub
 * store: the state carrying the request is captured output, the decision is
 * read back through the hub's own parser, and the hub's answers -- the
 * outcome and a refusal -- are captured frames too.
 *
 * What is asserted is mostly about restraint. The proposal is the agent's
 * claim about what it wants to run: it is drawn as text, it is not editable,
 * and it is never markup. The decision names the request by id and carries
 * nothing of the command back. And a request nobody is holding open draws
 * nothing at all, which is every codex session as well as every quiet claude
 * one.
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

/** Lets the ticket promise inside `connect` settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('the Allow and Deny a blocked agent is waiting on', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let store: HubStore;
  let sockets: ReturnType<typeof createFakeSocketFactory>;
  /** The list around the card, as far as the store is concerned. */
  let watching: (() => void) | null = null;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    container = document.createElement('div');
    document.body.append(container);
    sockets = createFakeSocketFactory();
    store = createHubStore({
      fetchTicket: () => Promise.resolve('ticket-1'),
      createSocket: (ticket) => sockets.create(ticket),
      timers: createFakeTimers(),
      frameIds: createFrameIdCounter(),
    });
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    watching?.();
    watching = null;
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
   * Walks the store's connection through to a captured state.
   *
   * The subscription is taken here rather than by the component, so that the
   * items exist before anything is mounted -- the same order the app has,
   * where the list holds the state and hands one row to each card. It also
   * fixes the numbering: `hello` is frame 1, so the first decision is frame 2,
   * which is the reply the captured answers below carry.
   */
  async function fleet(state: string): Promise<FakeSocket> {
    watching = store.subscribe(() => {});
    await act(settle);
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the store dialled nothing');
    await act(() => {
      socket.open();
      socket.deliver(hubFrames.welcome);
      socket.deliver(state);
    });
    return socket;
  }

  function items(): readonly SessionListItem[] {
    const state = store.getSnapshot().machineState;
    if (state === null) throw new Error('no machine state arrived');
    return listSessions(state);
  }

  /** The one session in the captured approval state that is asking. */
  function asking(): SessionListItem {
    const item = items().find((candidate) => candidate.approval !== null);
    if (item === undefined) throw new Error('the captured state holds no open request');
    return item;
  }

  /**
   * Renders into the one root, and re-renders into it on a second call.
   *
   * Deliberately not a fresh root: a card that keeps its place in the list
   * keeps this component mounted across a new request arriving, and a test that
   * remounted would be testing the one case where the bug cannot happen.
   */
  async function mount(item: SessionListItem, project?: SessionProject): Promise<void> {
    await act(() => {
      root ??= createRoot(container);
      root.render(
        withProvider(
          // As the card hands it over: the session, the one request it is
          // holding, and the session's name on the buttons. The project is the
          // tab's to supply, and a surface that cannot name one -- the card in
          // a list -- passes nothing and gets the pair it always had.
          <ApprovalControls
            approval={item.approval}
            name={item.name}
            store={store}
            scheme="dark"
            project={project ?? { kind: 'unplaced' }}
          />,
        ),
      );
    });
  }

  /**
   * The same session asking again: the next request the hub reports on this
   * row, once the one before it has ended.
   *
   * One captured request with a second id rather than a second capture, the
   * move the provider tests make: a state holding request two is state the hub
   * really sends, and every field but the id and the clock is as it was
   * captured.
   */
  function nextRequest(item: SessionListItem): SessionListItem {
    const { approval } = item;
    if (approval === null) throw new Error('the captured state holds no open request');
    return {
      ...item,
      approval: {
        ...approval,
        approvalId: approvalIdSchema.parse('approval-2'),
        requestedAt: approval.requestedAt + 60_000,
      },
    };
  }

  /** The captured reply with one field changed: the ending it reports. */
  function decidedWith(outcome: ApprovalOutcome): string {
    return JSON.stringify({
      ...(JSON.parse(hubFrames.approvalDecided) as Record<string, unknown>),
      outcome,
    });
  }

  function button(label: string): HTMLButtonElement {
    const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (found === null) throw new Error(`no button labelled ${label}`);
    return found;
  }

  function statusWords(): string {
    const region = container.querySelector('[role="status"]');
    if (region === null) throw new Error('no status region is mounted');
    return region.textContent ?? '';
  }

  /** What the store sent, read back through the hub's own parser. */
  function sentFrames(socket: FakeSocket): ClientFrame[] {
    return socket.sent.map((text) => {
      const parsed = parseTextFrame(parseClientFrame, text);
      if (!parsed.ok) throw new Error(`the store sent something unreadable: ${parsed.reason}`);
      return parsed.value;
    });
  }

  async function click(target: Element): Promise<void> {
    await act(() => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  }

  it('draws nothing for a session that is asking for nothing', async () => {
    await fleet(hubFrames.machineStatePopulated);
    const quiet = items().find((candidate) => candidate.approval === null);
    if (quiet === undefined) throw new Error('every captured session is asking');

    await mount(quiet);

    // Every codex session is this case too: no hook, so no request, so no
    // buttons -- and not a disabled pair that implies one could arrive. Not a
    // text comparison on the container: Mantine's provider writes its
    // stylesheet into it, and that is not this component's doing.
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelector('pre')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('shows the proposal in the monospace face, as text nothing can edit', async () => {
    await fleet(hubFrames.machineStateApproval);
    const item = asking();

    await mount(item);
    const proposal = container.querySelector<HTMLElement>('pre');

    if (proposal === null) throw new Error('the controls drew no proposal');
    expect(proposal.textContent).toBe(item.approval?.proposal);
    expect(proposal.style.fontFamily).toContain('monospace');
    // Read-only in the strongest sense available: there is nothing to type
    // into. A field holding the command would be a client one edit away from
    // deciding what the agent runs.
    expect(container.querySelectorAll('input, textarea, [contenteditable]')).toHaveLength(0);
  });

  it('keeps a long proposal inside the card rather than widening it', async () => {
    await fleet(hubFrames.machineStateApproval);

    await mount(asking());
    const proposal = container.querySelector<HTMLElement>('pre');

    if (proposal === null) throw new Error('the controls drew no proposal');
    // jsdom lays nothing out, so the rules themselves are what can be pinned:
    // newlines are kept, a long word breaks rather than pushing the card wide,
    // and a tall proposal scrolls in its own box.
    expect(proposal.style.whiteSpace).toBe('pre-wrap');
    expect(proposal.style.overflowWrap).toBe('anywhere');
    expect(proposal.style.overflowY).toBe('auto');
  });

  it('renders a proposal that looks like markup as the characters it is', async () => {
    await fleet(hubFrames.machineStateApproval);
    const item = asking();
    const approval = item.approval;
    if (approval === null) throw new Error('the captured state holds no open request');
    // Not the captured proposal, deliberately: what a provider hands the hook
    // is whatever the model asked for, and the wire schema bounds its length
    // and nothing else. The captured request happens to be a shell command; a
    // WebFetch on an HTML page would not be.
    const markup = '<b>rm -rf /</b><img src=x onerror="alert(1)">';

    await mount({ ...item, approval: { ...approval, proposal: markup } });

    const proposal = container.querySelector<HTMLElement>('pre');
    expect(proposal?.textContent).toBe(markup);
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('sends a grant that names the session and the request and nothing else', async () => {
    const socket = await fleet(hubFrames.machineStateApproval);
    const item = asking();
    await mount(item);

    await click(button(`allow ${item.name}`));

    expect(sentFrames(socket).filter((frame) => frame.type === 'approval-decide')).toEqual([
      {
        type: 'approval-decide',
        id: 2,
        subject: {
          kind: 'session',
          storeId: 'store-agentplex',
          sessionId: '10e6c58c-3fc6-4519-8bb4-1c3f7eef0bde',
        },
        approvalId: 'approval-1',
        decision: 'grant',
      },
    ]);
  });

  it('sends a denial the same way, with no words of its own', async () => {
    const socket = await fleet(hubFrames.machineStateApproval);
    const item = asking();
    await mount(item);

    await click(button(`deny ${item.name}`));

    expect(sentFrames(socket).filter((frame) => frame.type === 'approval-decide')).toEqual([
      {
        type: 'approval-decide',
        id: 2,
        subject: {
          kind: 'session',
          storeId: 'store-agentplex',
          sessionId: '10e6c58c-3fc6-4519-8bb4-1c3f7eef0bde',
        },
        approvalId: 'approval-1',
        decision: 'deny',
      },
    ]);
  });

  it('disables both while the hub has not answered', async () => {
    await fleet(hubFrames.machineStateApproval);
    const item = asking();
    await mount(item);
    expect(button(`allow ${item.name}`).disabled).toBe(false);

    await click(button(`allow ${item.name}`));

    // Not an invitation to answer twice while the first answer is in flight.
    expect(button(`allow ${item.name}`).disabled).toBe(true);
    expect(button(`deny ${item.name}`).disabled).toBe(true);
  });

  it('mounts the status region before it has anything to say', async () => {
    await fleet(hubFrames.machineStateApproval);

    await mount(asking());

    // Present and empty, so the outcome is an update to a region a screen
    // reader is already on rather than a node appearing beside one.
    expect(statusWords()).toBe('');
  });

  it('says in words what became of the request', async () => {
    const socket = await fleet(hubFrames.machineStateApproval);
    const item = asking();
    await mount(item);

    await click(button(`allow ${item.name}`));
    await act(() => {
      socket.deliver(hubFrames.approvalDecided);
    });

    expect(statusWords()).toBe('granted');
  });

  it("says the hub's refusal in the hub's own words", async () => {
    const socket = await fleet(hubFrames.machineStateApproval);
    const item = asking();
    await mount(item);

    await click(button(`deny ${item.name}`));
    await act(() => {
      socket.deliver(hubFrames.refusalTerminal);
    });

    // Captured: a real hub answered frame 2 with this sentence. Nothing was
    // decided, so the buttons come back rather than staying dead.
    expect(statusWords()).toBe('the hub cannot reach mbp-robert right now');
    expect(button(`deny ${item.name}`).disabled).toBe(false);
  });

  it.each<[ApprovalOutcome, string]>([
    ['denied', 'denied'],
    ['withdrawn', 'withdrawn: the agent is no longer asking'],
    ['expired', 'expired: the agent stopped waiting before this answer reached it'],
  ])('reports %s in words that do not claim more than happened', async (outcome, words) => {
    const socket = await fleet(hubFrames.machineStateApproval);
    const item = asking();
    await mount(item);

    await click(button(`allow ${item.name}`));
    await act(() => {
      socket.deliver(decidedWith(outcome));
    });

    // The two endings that are not a decision are why these sentences are
    // pinned: reporting either as a denial would tell a person they refused
    // something they did not.
    expect(statusWords()).toBe(words);
  });

  it('answers the next request on the same card rather than the last one', async () => {
    const socket = await fleet(hubFrames.machineStateApproval);
    const item = asking();
    await mount(item);
    await click(button(`allow ${item.name}`));
    await act(() => {
      socket.deliver(hubFrames.approvalDecided);
    });
    expect(statusWords()).toBe('granted');

    await mount(nextRequest(item));

    // A settled request is settled; this is a different one. Both buttons live
    // and nothing under them, or the card would offer the last question's
    // ending as this question's answer and never come back.
    expect(button(`allow ${item.name}`).disabled).toBe(false);
    expect(button(`deny ${item.name}`).disabled).toBe(false);
    expect(statusWords()).toBe('');
  });

  it('carries no refusal over to the next request either', async () => {
    const socket = await fleet(hubFrames.machineStateApproval);
    const item = asking();
    await mount(item);
    await click(button(`deny ${item.name}`));
    await act(() => {
      socket.deliver(hubFrames.refusalTerminal);
    });
    expect(statusWords()).toBe('the hub cannot reach mbp-robert right now');

    await mount(nextRequest(item));

    // The refusal is still the last thing the hub said to this client, and it
    // was about a frame this request has nothing to do with.
    expect(statusWords()).toBe('');
  });

  it('names the new request when it is answered, and not the one before it', async () => {
    const socket = await fleet(hubFrames.machineStateApproval);
    const item = asking();
    await mount(item);
    await click(button(`allow ${item.name}`));
    await act(() => {
      socket.deliver(hubFrames.approvalDecided);
    });

    await mount(nextRequest(item));
    await click(button(`deny ${item.name}`));

    expect(sentFrames(socket).filter((frame) => frame.type === 'approval-decide')).toEqual([
      {
        type: 'approval-decide',
        id: 2,
        subject: {
          kind: 'session',
          storeId: 'store-agentplex',
          sessionId: '10e6c58c-3fc6-4519-8bb4-1c3f7eef0bde',
        },
        approvalId: 'approval-1',
        decision: 'grant',
      },
      {
        type: 'approval-decide',
        id: 3,
        subject: {
          kind: 'session',
          storeId: 'store-agentplex',
          sessionId: '10e6c58c-3fc6-4519-8bb4-1c3f7eef0bde',
        },
        approvalId: 'approval-2',
        decision: 'deny',
      },
    ]);
  });

  it('draws the proposal left to right whatever the characters in it say', async () => {
    await fleet(hubFrames.machineStateApproval);

    await mount(asking());
    const proposal = container.querySelector<HTMLElement>('pre');

    // The provider strips the direction controls; this is the second half of
    // the same answer, and the half that survives a proposal reaching the
    // screen from anywhere else. A command runs left to right, so it is read
    // left to right.
    expect(proposal?.getAttribute('dir')).toBe('ltr');
  });

  it('keeps a long tool name inside the card rather than letting it widen', async () => {
    await fleet(hubFrames.machineStateApproval);
    const item = asking();
    const { approval } = item;
    if (approval === null) throw new Error('the captured state holds no open request');
    // An MCP tool name, which is where the length is: server and tool joined
    // with underscores, bounded by the wire at 200 characters and unbroken by
    // anything a layout can wrap at.
    const tool = 'mcp__internal_platform_services__provision_ephemeral_preview_environment';

    await mount({ ...item, approval: { ...approval, tool } });

    const label = [...container.querySelectorAll<HTMLElement>('p')].find(
      (node) => node.textContent === tool,
    );
    if (label === undefined) throw new Error('the controls drew no tool name');
    // The name is not truncated: an MCP name differs from its neighbours at the
    // end, which is the half an ellipsis would take.
    expect(label.style.overflowWrap).toBe('anywhere');
    expect(label.getAttribute('dir')).toBe('ltr');
  });
});

/**
 * "Always allow this exact request in <project>", beside Allow and Deny.
 *
 * Two sends behind one tap, and the test worth having is about what each half
 * is allowed to claim when the other one does not happen. The request is
 * answered first and the rule written second, so a refused rule leaves a
 * person with the thing they were waiting for, and neither half's sentence
 * mentions the other.
 */
describe('always allowing the request in front of you', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let store: HubStore;
  let sockets: ReturnType<typeof createFakeSocketFactory>;
  let watching: (() => void) | null = null;

  const PROJECT: SessionProject = {
    kind: 'project',
    id: nodeIdSchema.parse('hub-3'),
    label: 'agentplex',
  };

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    container = document.createElement('div');
    document.body.append(container);
    sockets = createFakeSocketFactory();
    store = createHubStore({
      fetchTicket: () => Promise.resolve('ticket-1'),
      createSocket: (ticket) => sockets.create(ticket),
      timers: createFakeTimers(),
      frameIds: createFrameIdCounter(),
    });
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    watching?.();
    watching = null;
    container.remove();
  });

  async function fleet(): Promise<FakeSocket> {
    watching = store.subscribe(() => {});
    await act(settle);
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the store dialled nothing');
    await act(() => {
      socket.open();
      socket.deliver(hubFrames.welcome);
      socket.deliver(hubFrames.machineStateApproval);
    });
    return socket;
  }

  function asking(): SessionListItem {
    const state = store.getSnapshot().machineState;
    if (state === null) throw new Error('no machine state arrived');
    const item = listSessions(state).find((candidate) => candidate.approval !== null);
    if (item === undefined) throw new Error('the captured state holds no open request');
    return item;
  }

  async function mount(item: SessionListItem, project: SessionProject): Promise<void> {
    await act(() => {
      root ??= createRoot(container);
      root.render(
        withProvider(
          <ApprovalControls
            approval={item.approval}
            name={item.name}
            store={store}
            scheme="dark"
            project={project}
          />,
        ),
      );
    });
  }

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

  function always(): HTMLButtonElement {
    const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      (button.getAttribute('aria-label') ?? '').startsWith('always allow'),
    );
    if (found === undefined) throw new Error('no always-allow control');
    return found;
  }

  function regions(): string[] {
    return [...container.querySelectorAll('[role="status"]')].map((node) => node.textContent ?? '');
  }

  /**
   * Every sentence this component drew, status or not.
   *
   * Paragraphs rather than the container's own text, for the reason the first
   * suite avoids a text comparison on it: Mantine writes its stylesheet in
   * there, and that is not this component's doing.
   */
  function sentences(): string {
    return [...container.querySelectorAll('p')].map((node) => node.textContent ?? '').join(' ');
  }

  function sentFrames(socket: FakeSocket): ClientFrame[] {
    return socket.sent.map((text) => {
      const parsed = parseTextFrame(parseClientFrame, text);
      if (!parsed.ok) throw new Error(`the store sent something unreadable: ${parsed.reason}`);
      return parsed.value;
    });
  }

  async function click(target: Element): Promise<void> {
    await act(() => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  }

  /** A captured frame, answering the frame this client actually sent. */
  function answering(fixture: string, replyTo: number): string {
    return JSON.stringify({
      ...(JSON.parse(fixture) as Record<string, unknown>),
      replyTo,
    });
  }

  it('says exact, and names the project the rule would live in', async () => {
    await fleet();

    await mount(asking(), PROJECT);

    // Both words are load-bearing. A rule is written into one project's policy
    // and applies to every session filed under it, so the project is named; and
    // it grants this text and no continuation of it, so the offer says exact
    // rather than leaving a reader to assume a pattern.
    const label = always().getAttribute('aria-label') ?? '';
    expect(label).toContain('exact');
    expect(label).toContain('agentplex');
  });

  it('offers nothing for a request too long to have been shown whole', async () => {
    await fleet();
    const item = asking();
    const { approval } = item;
    if (approval === null) throw new Error('the captured state holds no open request');

    await mount({ ...item, approval: { ...approval, truncated: true } }, PROJECT);

    // Allow and Deny, and no third control. The proposal was cut to fit, so it
    // is the text of every request that starts the same way -- a rule made of
    // it would answer commands nobody read, and the hub refuses to write one.
    // A button that could only be refused is worse than a sentence.
    expect(container.querySelectorAll('button')).toHaveLength(2);
    expect(sentences()).toContain(TOO_LONG_TO_REMEMBER_WORDS);
  });

  it('says nothing about remembering a request it can show whole', async () => {
    await fleet();

    await mount(asking(), PROJECT);

    expect(sentences()).not.toContain(TOO_LONG_TO_REMEMBER_WORDS);
  });

  it('offers nothing to a session with nowhere to keep a rule', async () => {
    await fleet();

    await mount(asking(), { kind: 'unfiled' });

    // Allow and Deny, and no third control: there is no project to name in the
    // question, and a button that could only fail is worse than no button.
    expect(container.querySelectorAll('button')).toHaveLength(2);
  });

  it('offers nothing while the tree has not said where the session is', async () => {
    await fleet();

    await mount(asking(), { kind: 'unplaced' });

    expect(container.querySelectorAll('button')).toHaveLength(2);
  });

  it('answers the request first, then writes the rule it is', async () => {
    const socket = await fleet();
    const item = asking();
    await mount(item, PROJECT);

    await click(always());

    // The order is the decision. The grant is what the blocked agent is
    // waiting for and the rule cannot answer it -- the hub matches at the
    // moment a request arrives, so a rule written first would still leave this
    // request to be answered. Answering first means a refused rule costs the
    // rule and not the unblocking.
    expect(sentFrames(socket).slice(1)).toEqual([
      {
        type: 'approval-decide',
        id: 2,
        subject: {
          kind: 'session',
          storeId: 'store-agentplex',
          sessionId: '10e6c58c-3fc6-4519-8bb4-1c3f7eef0bde',
        },
        approvalId: 'approval-1',
        decision: 'grant',
      },
      {
        type: 'approval-policy-add',
        id: 3,
        projectId: 'hub-3',
        // Exactly the request: the tool as the provider spells it and the
        // proposal byte for byte, with nothing for this client to trim or
        // widen on the way.
        rule: { tool: item.approval?.tool, proposal: item.approval?.proposal },
      },
    ]);
  });

  it('offers no second tap on either half while the hub has not answered', async () => {
    const socket = await fleet();
    const item = asking();
    await mount(item, PROJECT);

    await click(always());

    expect(always().disabled).toBe(true);
    expect(sentFrames(socket).filter((frame) => frame.type === 'approval-policy-add')).toHaveLength(
      1,
    );
  });

  it('says a refused rule without pretending the request went unanswered', async () => {
    const socket = await fleet();
    await mount(asking(), PROJECT);
    await click(always());

    await act(() => {
      socket.deliver(hubFrames.approvalDecided);
      socket.deliver(answering(hubFrames.refusal, 3));
    });

    // Two regions, two facts: the request really was granted, and the rule
    // really was not written. Either sentence alone would be a lie about the
    // other half.
    expect(regions()).toEqual([
      'granted',
      'the rule was not added: no server the hub is paired with has that store mounted',
    ]);
  });

  it('says a refused grant without claiming a rule was added', async () => {
    const socket = await fleet();
    await mount(asking(), PROJECT);
    await click(always());

    await act(() => {
      socket.deliver(hubFrames.refusalTerminal);
    });

    expect(regions()[0]).toBe('the hub cannot reach mbp-robert right now');
    expect(regions()[1]).toBe('');
  });

  it('says the rule is saved, naming the project it is saved in', async () => {
    const socket = await fleet();
    await mount(asking(), PROJECT);
    await click(always());

    await act(() => {
      socket.deliver(hubFrames.approvalDecided);
      socket.deliver(answering(hubFrames.approvalPolicy, 3));
    });

    expect(regions()[1]).toBe('saved in agentplex: this exact request will not be asked again');
  });

  it('credits a standing rule for a grant rather than the tap', async () => {
    const socket = await fleet();
    await mount(asking(), PROJECT);
    await click(always());

    // The hub's receipt: this one was already covered, so the answer that took
    // effect was the project's policy and not this person's tap. It is the one
    // place a client reliably learns an auto-grant happened -- the row marker
    // usually never reaches anybody, because the far machine settles inside one
    // broadcast flush.
    await act(() => {
      socket.deliver(
        JSON.stringify({
          type: 'approval-decided',
          replyTo: 2,
          outcome: 'granted',
          answeredBy: {
            project: 'hub-3',
            ruleId: 'hub-4',
            rule: { tool: 'Bash', proposal: 'command: pnpm test' },
          },
        }),
      );
    });

    expect(regions()[0]).toBe("granted by this project's standing policy, not by this tap");
  });
});
