// @vitest-environment jsdom
import {
  nodeIdSchema,
  parseClientFrame,
  parseHubFrame,
  parseTextFrame,
  type ApprovalPolicyRecord,
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
import type { SessionProject } from '../sessions/approval-policy-model.js';
import { ApprovalsBlock } from './approvals-block.js';

/**
 * The APPROVALS block of the context panel (mockups 7c and 7d): the standing
 * policy of the project this session is filed under, and what the absence of a
 * rule means.
 *
 * Driven against a real hub store, with the policy frame the capture took from
 * a hub that had really been asked to write a rule. What the assertions are
 * mostly about is the block not saying more than it knows: the rules are the
 * project's own, the text is the agent's and is drawn as characters, the will-
 * ask half is one sentence rather than an enumeration nobody could complete,
 * and a session with nowhere to keep a policy is told so rather than shown an
 * empty list.
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

/** The project the captured policy belongs to, as the capture names it. */
const PROJECT: SessionProject = {
  kind: 'project',
  id: nodeIdSchema.parse('hub-3'),
  label: 'agentplex',
};
const PROJECT_ID = nodeIdSchema.parse('hub-3');

function capturedRules(text: string): readonly ApprovalPolicyRecord[] {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'approval-policy') {
    throw new Error('the fixture is not a policy frame');
  }
  return parsed.value.rules;
}

const RULES = capturedRules(hubFrames.approvalPolicy);
const RULE = RULES[0];
if (RULE === undefined) throw new Error('the captured policy holds no rule');

describe('the standing policy beside a session', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let store: HubStore;
  let sockets: ReturnType<typeof createFakeSocketFactory>;
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
   * The connection, established before anything mounts.
   *
   * Taken here rather than by the block, so the numbering is the app's: `hello`
   * is frame 1, so the read this block sends on opening is frame 2 and the
   * first edit it sends is frame 3.
   */
  async function connect(): Promise<FakeSocket> {
    watching = store.subscribe(() => {});
    await act(settle);
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the store dialled nothing');
    await act(() => {
      socket.open();
      socket.deliver(hubFrames.welcome);
    });
    return socket;
  }

  async function mount(project: SessionProject): Promise<void> {
    await act(() => {
      root ??= createRoot(container);
      root.render(withProvider(<ApprovalsBlock project={project} store={store} scheme="dark" />));
    });
  }

  async function deliver(socket: FakeSocket, frame: string): Promise<void> {
    await act(() => {
      socket.deliver(frame);
    });
  }

  function rules(): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('li')];
  }

  function words(): string {
    return container.textContent ?? '';
  }

  function statusWords(): string {
    const region = container.querySelector('[role="status"]');
    if (region === null) throw new Error('no status region is mounted');
    return region.textContent ?? '';
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

  /** The captured refusal, answering the frame this block sent. */
  function refusalOf(replyTo: number): string {
    return JSON.stringify({
      ...(JSON.parse(hubFrames.refusal) as Record<string, unknown>),
      replyTo,
    });
  }

  function remove(tool: string): HTMLButtonElement {
    const found = container.querySelector<HTMLButtonElement>(
      `button[aria-label="forget the rule for ${tool}"]`,
    );
    if (found === null) throw new Error(`no remove control for ${tool}`);
    return found;
  }

  it("asks the hub for this project's policy when it opens, and asks once", async () => {
    const socket = await connect();

    await mount(PROJECT);

    expect(sentFrames(socket).filter((frame) => frame.type.startsWith('approval-policy'))).toEqual([
      { type: 'approval-policy-list', id: 2, projectId: PROJECT_ID },
    ]);
  });

  it('draws one row per rule, each the tool and the exact text of the request', async () => {
    const socket = await connect();
    await mount(PROJECT);

    await deliver(socket, hubFrames.approvalPolicy);

    const rows = rules();
    expect(rows).toHaveLength(RULES.length);
    const row = rows[0];
    if (row === undefined) throw new Error('the block drew no rule');
    expect(row.textContent).toContain(RULE.rule.tool);
    // The whole proposal, byte for byte: what the hub compares a request
    // against is this text, so a row that trimmed or shortened it would be
    // showing a rule the hub does not hold.
    const proposal = row.querySelector<HTMLElement>('pre');
    expect(proposal?.textContent).toBe(RULE.rule.proposal);
    expect(proposal?.style.fontFamily).toContain('monospace');
  });

  it('keeps a rule inside the 300px column and reads it left to right', async () => {
    const socket = await connect();
    await mount(PROJECT);
    await deliver(socket, hubFrames.approvalPolicy);

    const proposal = rules()[0]?.querySelector<HTMLElement>('pre');
    if (proposal === undefined || proposal === null) throw new Error('the block drew no rule');

    // jsdom lays nothing out, so the rules themselves are what can be pinned.
    // The column is fixed and cannot grow, so a long unbroken argument breaks
    // rather than pushing the panel over the terminal, the newlines the
    // provider wrote are kept, and a tall rule scrolls in its own box.
    expect(proposal.style.whiteSpace).toBe('pre-wrap');
    expect(proposal.style.overflowWrap).toBe('anywhere');
    expect(proposal.style.overflowY).toBe('auto');
    // The agent's words, so the base direction is the screen's and not theirs.
    expect(proposal.getAttribute('dir')).toBe('ltr');
  });

  it('renders a rule that looks like markup as the characters it is', async () => {
    const socket = await connect();
    await mount(PROJECT);
    const markup = '<b>rm -rf /</b><img src=x onerror="alert(1)">';

    // The captured frame with one field changed: a rule is made from whatever
    // the agent proposed, and the captured request happens to be a shell
    // command where a WebFetch on an HTML page would not be.
    await deliver(
      socket,
      JSON.stringify({
        ...(JSON.parse(hubFrames.approvalPolicy) as Record<string, unknown>),
        rules: [{ ...RULE, rule: { ...RULE.rule, proposal: markup } }],
      }),
    );

    expect(rules()[0]?.querySelector('pre')?.textContent).toBe(markup);
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('says the will-ask half once, in words, rather than enumerating it', async () => {
    const socket = await connect();
    await mount(PROJECT);

    await deliver(socket, hubFrames.approvalPolicy);

    // An unmatched request always asks, so there is no list of will-ask things
    // to draw: a row per one would be a list nobody could finish, and three
    // grants with nothing after them read as a list of everything that happens.
    expect(rules()).toHaveLength(RULES.length);
    expect(words()).toContain('Everything else asks you first.');
  });

  it('says plainly what an exact match is', async () => {
    const socket = await connect();
    await mount(PROJECT);

    await deliver(socket, hubFrames.approvalPolicy);

    expect(words()).toContain(
      'A rule matches the whole text, exactly: a request that differs by one character asks you.',
    );
  });

  it('says the policy has not arrived rather than drawing an empty block', async () => {
    await connect();

    await mount(PROJECT);

    // The heading is drawn by the panel around this, so an empty body would be
    // a heading promising a fact that never appears.
    expect(rules()).toHaveLength(0);
    expect(words()).toContain("This project's policy has not arrived yet.");
  });

  it('does not call a session unfiled while the tree has not said where it is', async () => {
    const socket = await connect();

    await mount({ kind: 'unplaced' });

    // The dangerous sentence is "there is no policy": somebody who reads it
    // stops looking for one. Before the tree arrives this client does not know
    // where this session is filed, and it says that instead.
    expect(words()).toContain('Where this session is filed has not arrived yet.');
    expect(words()).not.toContain('this session is in no project');
    expect(sentFrames(socket).filter((frame) => frame.type.startsWith('approval-policy'))).toEqual(
      [],
    );
  });

  it('tells a session in no project why it has no policy, and offers it nothing', async () => {
    const socket = await connect();

    await mount({ kind: 'unfiled' });

    expect(words()).toContain(
      'No policy: this session is in no project, so every request reaches you.',
    );
    expect(container.querySelectorAll('button')).toHaveLength(0);
    // Nothing is asked for either: there is no project to name in the question.
    expect(sentFrames(socket).filter((frame) => frame.type.startsWith('approval-policy'))).toEqual(
      [],
    );
  });

  it('takes a rule out by the id the hub minted, naming the project and nothing else', async () => {
    const socket = await connect();
    await mount(PROJECT);
    await deliver(socket, hubFrames.approvalPolicy);

    await click(remove(RULE.rule.tool));

    expect(sentFrames(socket).filter((frame) => frame.type === 'approval-policy-remove')).toEqual([
      { type: 'approval-policy-remove', id: 3, projectId: PROJECT_ID, ruleId: RULE.ruleId },
    ]);
  });

  it('waits for the hub rather than offering a second removal of one rule', async () => {
    const socket = await connect();
    await mount(PROJECT);
    await deliver(socket, hubFrames.approvalPolicy);
    expect(remove(RULE.rule.tool).disabled).toBe(false);

    await click(remove(RULE.rule.tool));

    expect(remove(RULE.rule.tool).disabled).toBe(true);
  });

  it("says a refused removal in the hub's own words, and keeps the rule", async () => {
    const socket = await connect();
    await mount(PROJECT);
    await deliver(socket, hubFrames.approvalPolicy);
    await click(remove(RULE.rule.tool));

    // A captured refusal, re-pointed at the frame this client actually sent:
    // the words are the hub's, the id is this block's.
    await deliver(socket, refusalOf(3));

    expect(statusWords()).toBe('no server the hub is paired with has that store mounted');
    // The rule is still the policy's, so it is still drawn and still removable.
    expect(rules()).toHaveLength(RULES.length);
    expect(remove(RULE.rule.tool).disabled).toBe(false);
  });

  it('mounts the status region before it has anything to say', async () => {
    const socket = await connect();
    await mount(PROJECT);

    await deliver(socket, hubFrames.approvalPolicy);

    expect(statusWords()).toBe('');
  });
});
