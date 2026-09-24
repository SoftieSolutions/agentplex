// @vitest-environment jsdom
import {
  approvalIdSchema,
  parseClientFrame,
  parseHubFrame,
  parseTextFrame,
  type ClientFrame,
  type PendingApproval,
} from '@agentplex/protocol';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approvalsOldestFirst, type SessionApproval } from '../sessions/session-list-model.js';
import { createFakeSocketFactory, type FakeSocket } from '../store/fake-socket.js';
import { createFrameIdCounter } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { ApprovalsTab } from './approvals-tab.js';

/**
 * Every request one session is holding open, on the tab the card's one pair of
 * buttons could not hold.
 *
 * The requests are the captured one with a second and a third stated on a
 * parsed copy of the state that carried it -- the move the pane's own tests
 * make, and the move a fixture forbids the alternative of: a fixture is
 * captured output, so a second request is stated in a test rather than typed
 * into the capture.
 *
 * What is asserted is the half the card cannot be asked about. The list is in
 * one order and it is the one that puts the longest-waiting hook at the top.
 * Answering one request is answering that request: the others stay live, and
 * the frame that goes out names the id of the one that was pressed. And what
 * is not here at all is the policy the provider suggested: this surface asks
 * about one command, not about what to do next time.
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

/** The one request a real `PermissionRequest` hook made, off the captured state. */
const captured: PendingApproval = (() => {
  const parsed = parseTextFrame(parseHubFrame, hubFrames.machineStateApproval);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the approval fixture is not a machine-state frame');
  }
  const [first] = parsed.value.state.stores
    .flatMap((store) => store.sessions)
    .flatMap((row) => row.approvals);
  if (first === undefined) throw new Error('the captured state holds no open request');
  return first;
})();

/**
 * The captured request again under another id, waiting a stated number of
 * minutes less.
 *
 * The ids go through the wire's own parser rather than being asserted into the
 * brand, and everything else is the captured object: what a second open request
 * differs from the first in is its id, its clock and the command it names.
 */
function alsoAsking(id: string, proposal: string, minutesNewer: number): PendingApproval {
  return {
    ...captured,
    approvalId: approvalIdSchema.parse(id),
    proposal,
    requestedAt: captured.requestedAt + minutesNewer * 60_000,
  };
}

/** Three open requests, given to the tab in the order a row lists them. */
const THREE: readonly SessionApproval[] = approvalsOldestFirst([
  alsoAsking('approval-3', 'git push --force-with-lease', 2),
  captured,
  alsoAsking('approval-2', 'rm -rf ./node_modules', 1),
]);

describe('the Approvals tab', () => {
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
   * A connected store and a tab mounted on it.
   *
   * The subscription is taken before anything is mounted, the way the app has
   * it, which also fixes the numbering: `hello` is frame 1, so the first
   * decision this tab sends is frame 2.
   */
  async function mount(approvals: readonly SessionApproval[]): Promise<FakeSocket> {
    watching = store.subscribe(() => {});
    await act(settle);
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the store dialled nothing');
    await act(() => {
      socket.open();
      socket.deliver(hubFrames.welcome);
      socket.deliver(hubFrames.machineStateApproval);
    });
    await act(() => {
      root ??= createRoot(container);
      root.render(
        withProvider(
          <ApprovalsTab
            approvals={approvals}
            // The tab under test is the queue, not the policy: these cases are
            // about three requests being three independent answers, so the
            // session is drawn as one the tree cannot place and the tab offers
            // the pair and nothing else.
            project={{ kind: 'unplaced' }}
            store={store}
            scheme="dark"
          />,
        ),
      );
    });
    return socket;
  }

  /** One request as it is drawn, in the order the tab drew them. */
  function requests(): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>('li')];
  }

  function proposals(): (string | null)[] {
    return requests().map((request) => request.querySelector('pre')?.textContent ?? null);
  }

  function button(request: HTMLElement, word: 'allow' | 'deny'): HTMLButtonElement {
    const found = request.querySelector<HTMLButtonElement>(`button[aria-label^="${word} "]`);
    if (found === null) throw new Error(`no ${word} in that request`);
    return found;
  }

  function sentFrames(socket: FakeSocket): ClientFrame[] {
    return socket.sent.map((text) => {
      const parsed = parseTextFrame(parseClientFrame, text);
      if (!parsed.ok) throw new Error(`the tab sent something unreadable: ${parsed.reason}`);
      return parsed.value;
    });
  }

  async function click(target: Element): Promise<void> {
    await act(() => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  }

  it('lists every open request, oldest first', async () => {
    await mount(THREE);

    // Not the order the row happened to list them in: the one that has been
    // blocking longest is the one nearest its own timeout.
    expect(proposals()).toEqual([
      captured.proposal,
      'rm -rf ./node_modules',
      'git push --force-with-lease',
    ]);
  });

  it('says how many there are in a way a screen reader can count', async () => {
    await mount(THREE);

    const list = container.querySelector('ul');
    expect(list?.getAttribute('aria-label')).toBe('pending approvals');
    expect(requests()).toHaveLength(3);
  });

  it('draws nothing of the policy the provider suggested', async () => {
    await mount(THREE);

    // The captured request carries a suggested rule. It is policy -- what to
    // do about the next command like this one -- and this surface answers one
    // command, so the rule is not on it and cannot be agreed to by accident.
    const [suggestion] = captured.suggestions;
    const rule = suggestion?.rules[0]?.content;
    if (rule === undefined) throw new Error('the captured request suggests no rule');
    expect(container.textContent).not.toContain(rule);
  });

  it('names the request that was pressed, and nothing of the command', async () => {
    const socket = await mount(THREE);
    const second = requests()[1];
    if (second === undefined) throw new Error('the tab drew fewer than two requests');

    await click(button(second, 'allow'));

    expect(sentFrames(socket).filter((frame) => frame.type === 'approval-decide')).toEqual([
      {
        type: 'approval-decide',
        id: 2,
        subject: {
          kind: 'session',
          storeId: 'store-agentplex',
          sessionId: '10e6c58c-3fc6-4519-8bb4-1c3f7eef0bde',
        },
        approvalId: 'approval-2',
        decision: 'grant',
      },
    ]);
  });

  it('leaves the other requests answerable once one is answered', async () => {
    const socket = await mount(THREE);
    const [first, second, third] = requests();
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('the tab drew fewer than three requests');
    }

    await click(button(second, 'allow'));

    // The answer is a claim about one request, so it disables one pair. Two
    // agents are still blocked on this session and both are still answerable
    // -- state that remembered only "a decision was sent" would deaden the
    // whole tab on the first tap.
    expect(button(second, 'allow').disabled).toBe(true);
    expect(button(first, 'allow').disabled).toBe(false);
    expect(button(third, 'deny').disabled).toBe(false);

    await click(button(third, 'deny'));

    expect(sentFrames(socket).filter((frame) => frame.type === 'approval-decide')).toHaveLength(2);
    expect(
      sentFrames(socket)
        .filter((frame) => frame.type === 'approval-decide')
        .at(-1)?.approvalId,
    ).toBe('approval-3');
  });

  it('reports an ending against the request it ended, and no other', async () => {
    const socket = await mount(THREE);
    const [first, second] = requests();
    if (first === undefined || second === undefined) {
      throw new Error('the tab drew fewer than two requests');
    }

    await click(button(second, 'allow'));
    await act(() => {
      socket.deliver(hubFrames.approvalDecided);
    });

    expect(second.querySelector('[role="status"]')?.textContent).toBe('granted');
    expect(first.querySelector('[role="status"]')?.textContent).toBe('');
  });
});
