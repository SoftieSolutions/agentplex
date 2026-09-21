// @vitest-environment jsdom
import {
  parseClientFrame,
  parseTextFrame,
  serverRegistrationIdSchema,
  type ClientFrame,
} from '@agentplex/protocol';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCatalogueStore } from '../catalogue/catalogue-store.js';
import type { ShellForm } from '../shell/shell-form.js';
import { createFakeSocketFactory, type FakeSocket } from '../store/fake-socket.js';
import { createFrameIdCounter } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { parseSessionHash } from '../terminal/session-route.js';
import { appSessionFiltersStore, type SessionListView } from './session-filters-store.js';
import type { SessionListFilters } from './session-list-model.js';
import { SessionListScreen } from './session-list-screen.js';

/**
 * The two affordances a card carries, on a list built from a real hub's state:
 * the card opens its session, and a session something is holding offers a
 * stop. Everything inbound here is captured output -- the fleet state, the
 * refusal a real hub answered a real stop with, the reply it sent when one
 * landed -- and everything outbound is read back through the hub's own parser.
 *
 * The screen is mounted beside the interest the chrome declares in the
 * catalogue rather than alone. Until AGX-122 this screen drew the tree itself
 * and so asked the catalogue question itself; the sidebar asks it now, before
 * anything on this screen is pressed, and the captured refusal answers the
 * frame a stop is under that numbering. Standing the interest up here keeps
 * this suite asserting about the cards rather than about how many frames the
 * chrome around them happens to send.
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

/**
 * Mantine's popover-backed controls observe their target's box; jsdom has no
 * layout and no observer. A stub that reports nothing is enough -- nothing
 * here asserts on a measurement.
 */
function installResizeObserver(): void {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

/** Lets the ticket promise inside `connect` settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * One animation frame. A dialog or a dropdown opens through a transition, so
 * what a click asks for reaches the document a frame later rather than in the
 * same flush.
 */
function frame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/** The moment every age on these renders is measured against. */
const NOW = 1_756_000_000_000;

describe('the session list', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let store: HubStore;
  let sockets: ReturnType<typeof createFakeSocketFactory>;
  /** The chrome's standing catalogue interest, taken away after each test. */
  let chrome: (() => void) | null = null;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    installResizeObserver();
    container = document.createElement('div');
    document.body.append(container);
    sockets = createFakeSocketFactory();
    store = createHubStore({
      fetchTicket: () => Promise.resolve('ticket-1'),
      createSocket: (ticket) => sockets.create(ticket),
      timers: createFakeTimers(),
      frameIds: createFrameIdCounter(),
    });
    chrome = createCatalogueStore({ hub: store }).subscribe(() => {});
    window.location.hash = '';
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    chrome?.();
    chrome = null;
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
   * Mounts the screen and walks its store's connection through to a state.
   *
   * The form is the shell's, and it is an argument because one control here
   * depends on it: the chrome's New menu is what makes things in the wide
   * form, so New project is this screen's own at phone width and nowhere else.
   */
  async function mountWith(
    state: string,
    machine?: string,
    form: ShellForm = 'wide',
  ): Promise<FakeSocket> {
    await act(async () => {
      root = createRoot(container);
      root.render(
        withProvider(
          <SessionListScreen
            store={store}
            machine={machine === undefined ? null : serverRegistrationIdSchema.parse(machine)}
            form={form}
            now={() => NOW}
          />,
        ),
      );
    });
    await act(settle);
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the screen dialled nothing');
    await act(() => {
      socket.open();
      socket.deliver(hubFrames.welcome);
      socket.deliver(state);
    });
    return socket;
  }

  /** What the store sent, read back through the hub's own parser. */
  function sentFrames(socket: FakeSocket): ClientFrame[] {
    return socket.sent.map((text) => {
      const parsed = parseTextFrame(parseClientFrame, text);
      if (!parsed.ok) throw new Error(`the store sent something unreadable: ${parsed.reason}`);
      return parsed.value;
    });
  }

  function cardLinks(): HTMLAnchorElement[] {
    return [...container.querySelectorAll<HTMLAnchorElement>('a[href^="#/session/"]')];
  }

  function stopButtons(): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>('button[aria-label^="stop "]')];
  }

  function theStopButton(): HTMLButtonElement {
    const buttons = stopButtons();
    const only = buttons[0];
    if (buttons.length !== 1 || only === undefined) {
      throw new Error(`expected one stop button, found ${String(buttons.length)}`);
    }
    return only;
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

  async function click(target: Element): Promise<void> {
    await act(() => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  }

  /** Every button on the screen and in whatever it opened, by what it says. */
  function buttonWords(): string[] {
    return [...document.body.querySelectorAll('button')].map((button) => button.textContent ?? '');
  }

  it('draws neither New button in the wide form, where the chrome offers both', async () => {
    await mountWith(hubFrames.machineStatePopulated);

    // The chrome's New menu makes both kinds at this width (AGX-124). Two
    // buttons here beside it would be a second way to do one thing, and the
    // one a person found first would decide whether their session opened a
    // pane -- which is what the shell owning the form fixed.
    const words = buttonWords();
    expect(words).not.toContain('New session');
    expect(words).not.toContain('New project');
  });

  it('keeps New project in the phone form, and opens the form it names', async () => {
    await mountWith(hubFrames.machineStatePopulated, undefined, 'phone');

    // No New menu at this width: the chrome's action button starts sessions
    // and nothing in it starts a project, so this screen is where one is
    // started from. A session is not, which is the half that has not changed.
    expect(buttonWords()).not.toContain('New session');
    const button = [...document.body.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'New project',
    );
    if (button === undefined) throw new Error('the phone form drew no New project');
    await click(button);
    // The dialog opens through a transition, so it reaches the document a
    // frame after the click rather than in the flush that asked for it.
    await act(settle);
    await act(frame);
    await act(settle);

    expect(buttonWords()).toContain('Create project');
  });

  it('makes every card a link to its own session', async () => {
    await mountWith(hubFrames.machineStatePopulated);

    // Six sessions across two stores in the captured fleet, six addresses.
    expect(cardLinks().map((link) => link.getAttribute('href'))).toEqual([
      '#/session/store-agentplex/session-migrate-db',
      '#/session/store-universe/session-docs-sweep',
      '#/session/store-agentplex/session-fix-auth',
      '#/session/store-universe/session-bench-tokenizer',
      '#/session/store-universe/session-train-lora',
      '#/session/store-agentplex/session-spike-wasm',
    ]);
  });

  it('names the session it opens, so the link is reachable by name', async () => {
    await mountWith(hubFrames.machineStatePopulated);

    const link = cardLinks().find((candidate) => candidate.getAttribute('aria-label') !== null);
    expect(link?.getAttribute('aria-label')).toBe('open migrate-db-v9');
  });

  it('writes an address the session route itself reads back', async () => {
    await mountWith(hubFrames.machineStatePopulated);
    const link = cardLinks()[0];
    if (link === undefined) throw new Error('the list drew no card link');

    // Through the route's own parser and not a string comparison: what makes
    // the card open a session is that the address it writes is one that
    // module says addresses that session. jsdom performs no navigation, so
    // this is the whole of the contract that can be checked here.
    expect(parseSessionHash(link.getAttribute('href') ?? '')).toEqual({
      storeId: 'store-agentplex',
      sessionId: 'session-migrate-db',
    });
  });

  it('offers a stop only where the hub published a stoppable holder', async () => {
    await mountWith(hubFrames.machineStatePopulated);

    // One of the six. The working session on the same machine is held too, and
    // its holder says mid-turn, so it gets nothing.
    expect(stopButtons().map((button) => button.getAttribute('aria-label'))).toEqual([
      'stop session-migrate-db',
    ]);
  });

  it('keeps the stop out of the link, so the button is operable on its own', async () => {
    await mountWith(hubFrames.machineStatePopulated);
    const button = theStopButton();

    // The card is a stretched link rather than a wrapper, which is the whole
    // reason: a button inside an anchor is neither valid nor reachable.
    expect(cardLinks().some((link) => link.contains(button))).toBe(false);
  });

  it('sends a stop that names the session and nothing else', async () => {
    const socket = await mountWith(hubFrames.machineStatePopulated);

    await click(theStopButton());

    expect(sentFrames(socket).filter((frame) => frame.type === 'session-stop')).toEqual([
      {
        type: 'session-stop',
        id: 4,
        storeId: 'store-agentplex',
        sessionId: 'session-migrate-db',
      },
    ]);
  });

  it('does not navigate when the stop inside the card is pressed', async () => {
    await mountWith(hubFrames.machineStatePopulated);

    await click(theStopButton());

    expect(window.location.hash).toBe('');
  });

  it('disables the button while the stop is in flight', async () => {
    await mountWith(hubFrames.machineStatePopulated);

    await click(theStopButton());

    expect(theStopButton().disabled).toBe(true);
    expect(theStopButton().textContent).toBe('Stopping');
  });

  it('says why beside the button when the hub refuses the stop', async () => {
    const socket = await mountWith(hubFrames.machineStatePopulated);
    await click(theStopButton());

    // The race the hub refuses on purpose: the holder went mid-turn between
    // the button being drawn and the button being pressed. Captured from a
    // real hub answering a real stop, and it answers frame 4 -- the stop this
    // card just sent, after the layout this screen asks for on connecting and
    // the catalogue page the chrome asks for beside it.
    await act(() => {
      socket.deliver(hubFrames.refusalHeldBusy);
    });

    expect(container.textContent).toContain(
      'that session is mid-turn; stopping it now could leave an edit half applied',
    );
    // Still offered: the session is still running, and this attempt is what
    // did not stop it.
    expect(theStopButton().disabled).toBe(false);
  });

  it('sends a first-run empty list to Settings, where pairing is', async () => {
    await mountWith(hubFrames.machineState);

    expect(container.textContent).toContain('No server is paired with this hub');
    const link = container.querySelector<HTMLAnchorElement>('a[href="#/settings"]');
    expect(link?.textContent).toBe('Pair one in Settings');
  });

  it('blames the connection, not the store, for a pairing the hub never reached', async () => {
    // The captured state has one pairing, phase `stale`, `lastConnectedAt`
    // null and "connection refused" in the hub's words: a machine that has
    // never said anything cannot have reported that it has no store.
    await mountWith(hubFrames.machineStateWithServer);

    expect(container.textContent).toContain('gpu-box-01 is paired but has never connected');
    const link = container.querySelector<HTMLAnchorElement>('a[href="#/settings"]');
    expect(link?.textContent).toBe('See why in Settings');
  });

  it('blames the narrowing, and nothing else, when the fleet has sessions', async () => {
    // Narrowed to a machine the fleet does not hold, which is a narrowing that
    // hides everything rather than a fleet with nothing in it.
    await mountWith(hubFrames.machineStatePopulated, 'registration-unpaired');

    expect(container.textContent).toContain('no session matches the current narrowing');
    expect(container.querySelector('a[href="#/settings"]')).toBeNull();
  });

  it('says what a landed stop landed on, whoever asked for it', async () => {
    const socket = await mountWith(hubFrames.machineStatePopulated);

    // Nothing on this screen asked: the reply answers frame 6, which this
    // store never sent. A stop from another tab is exactly this.
    await act(() => {
      socket.deliver(hubFrames.sessionStopped);
    });

    expect(container.textContent).toContain('stopped migrate-db-v9 on mbp-robert');
  });

  /**
   * The attention controls, on the same captured states.
   *
   * What a card says about attention it says out of the session row, so these
   * mount against `machineStatePopulated` (nobody has spoken) and
   * `machineStateAttended` (one prompt acknowledged, one muted) and read what
   * the screen drew.
   */
  function buttonsLabelled(prefix: string): HTMLButtonElement[] {
    return [...container.querySelectorAll<HTMLButtonElement>(`button[aria-label^="${prefix} "]`)];
  }

  /** The card an aria-labelled control sits inside. */
  function cardOf(control: Element): HTMLElement {
    const card = control.closest('article');
    if (card === null) throw new Error('the control is not inside a card');
    return card;
  }

  it('offers seen and mute only on the sessions asking for somebody', async () => {
    await mountWith(hubFrames.machineStatePopulated);

    // The two prompts in the captured fleet, and neither the working sessions
    // nor the idle one: a button on those would acknowledge nothing.
    expect(buttonsLabelled('acknowledge').map((b) => b.getAttribute('aria-label'))).toEqual([
      'acknowledge migrate-db-v9',
      'acknowledge docs-sweep',
    ]);
    expect(buttonsLabelled('mute').map((b) => b.getAttribute('aria-label'))).toEqual([
      'mute migrate-db-v9',
      'mute docs-sweep',
    ]);
  });

  it('sends an acknowledgement that names the session and carries no moment', async () => {
    const socket = await mountWith(hubFrames.machineStatePopulated);
    const seen = buttonsLabelled('acknowledge')[0];
    if (seen === undefined) throw new Error('the list offered no acknowledgement');

    await click(seen);

    expect(sentFrames(socket).filter((frame) => frame.type === 'session-acknowledge')).toEqual([
      {
        type: 'session-acknowledge',
        id: 4,
        storeId: 'store-agentplex',
        sessionId: 'session-migrate-db',
      },
    ]);
    // Not a navigation: the card around the button is a link, and a person
    // aiming at the button meant the button.
    expect(window.location.hash).toBe('');
  });

  it('asks for the state it wants when muting, and for the opposite when unmuting', async () => {
    const socket = await mountWith(hubFrames.machineStateAttended);

    const mute = buttonsLabelled('mute')[0];
    const unmute = buttonsLabelled('unmute')[0];
    if (mute === undefined || unmute === undefined) {
      throw new Error('the list did not offer both a mute and an unmute');
    }
    expect(unmute.getAttribute('aria-label')).toBe('unmute docs-sweep');

    await click(mute);
    await click(unmute);

    expect(sentFrames(socket).filter((frame) => frame.type === 'session-mute')).toEqual([
      {
        type: 'session-mute',
        id: 4,
        storeId: 'store-agentplex',
        sessionId: 'session-migrate-db',
        muted: true,
      },
      {
        type: 'session-mute',
        id: 5,
        storeId: 'store-universe',
        sessionId: 'session-docs-sweep',
        muted: false,
      },
    ]);
  });

  it('dims a muted card and leaves everything else on it saying what it said', async () => {
    await mountWith(hubFrames.machineStateAttended);

    const card = cardOf(buttonsLabelled('unmute')[0] ?? container);
    expect(Number(card.style.opacity)).toBeLessThan(1);
    // Mute silences the alert, never the fact. The row keeps its place in the
    // needs-you half and it is still counting how long it has been waiting;
    // what it gains is a word for why it is quiet.
    expect(card.textContent).toContain('waiting');
    expect(card.textContent).toContain('muted');
    expect(cardLinks()[1]?.getAttribute('href')).toBe(
      '#/session/store-universe/session-docs-sweep',
    );
  });

  it('draws an acknowledged prompt at full weight and says it has been seen', async () => {
    await mountWith(hubFrames.machineStateAttended);

    const card = cardOf(buttonsLabelled('mute')[0] ?? container);
    expect(card.textContent).toContain('seen');
    // No longer counting the wait: the clock is what the accent was for.
    expect(card.textContent).not.toContain('waiting');
    expect(Number(card.style.opacity)).toBe(1);
  });

  it('stops waiting when the hub answers, and says why when it refuses', async () => {
    const socket = await mountWith(hubFrames.machineStatePopulated);
    const seen = buttonsLabelled('acknowledge')[0];
    if (seen === undefined) throw new Error('the list offered no acknowledgement');

    await click(seen);
    expect(buttonsLabelled('acknowledge')[0]?.disabled).toBe(true);

    // Captured from a real hub refusing a real acknowledgement, and it answers
    // frame 4 -- the frame this card just sent, after the layout and the
    // catalogue page the screen asks for on connecting.
    await act(() => {
      socket.deliver(hubFrames.refusalAttention);
    });
    expect(buttonsLabelled('acknowledge')[0]?.disabled).toBe(false);
    expect(container.textContent).toContain('this hub knows no session by that id');
  });

  /**
   * The narrowings, now that they are the page's rather than this component's.
   *
   * The popover that offers most of them is drawn in the sidebar, which is this
   * screen's sibling, so what is asserted here is that the cards follow the
   * shared store: a write nobody on this screen made still narrows the list.
   * The rules themselves -- which option survives a vanished machine, what a
   * chip counts under -- are `session-list-model.test.ts`'s, and are asked here
   * only where a component could fail to route through them.
   */
  function hrefs(): (string | null)[] {
    return cardLinks().map((link) => link.getAttribute('href'));
  }

  function searchBox(): HTMLInputElement | null {
    return container.querySelector<HTMLInputElement>('input[aria-label="Filter sessions"]');
  }

  /** The popover's trigger, which comes with the row the phone form draws. */
  function filterTrigger(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>('button[aria-label="Filters"]');
  }

  /**
   * Opens the popover and picks an option out of one of its dropdowns, the way
   * somebody on a phone reaches a narrowing that has no other surface there.
   */
  async function narrowThroughPopover(section: string, option: string): Promise<void> {
    const opener = filterTrigger();
    if (opener === null) throw new Error('the screen drew no popover trigger');
    await click(opener);
    // Mantine places the dropdown with a floating-ui measurement and opens it
    // through a transition, so it reaches the document a frame after the click
    // rather than in the flush that asked for it.
    await act(settle);
    await act(frame);
    await act(settle);
    const input = document.body.querySelector<HTMLInputElement>(`input[aria-label="${section}"]`);
    if (input === null) throw new Error(`the popover drew no ${section} chooser`);
    await act(() => {
      input.click();
    });
    const found = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (candidate) => candidate.textContent === option,
    );
    if (found === undefined) throw new Error(`${section} offers no ${option}`);
    await act(() => {
      found.click();
    });
  }

  /** A status chip by the word it starts with; they are the pressable pair. */
  function chipButton(label: string): HTMLElement {
    const found = [...container.querySelectorAll<HTMLElement>('[aria-pressed]')].find((button) =>
      button.textContent?.startsWith(label),
    );
    if (found === undefined) throw new Error(`no chip reading ${label}`);
    return found;
  }

  async function narrowTo(changes: Partial<SessionListFilters>): Promise<void> {
    await act(() => {
      appSessionFiltersStore(store).set(changes);
    });
  }

  it('draws no store or provider select of its own', async () => {
    await mountWith(hubFrames.machineStatePopulated);

    // Both narrowings are sections of the filter row's popover now. A select
    // left here would be a second control writing what that one writes.
    expect(container.querySelector('[aria-label="Store"]')).toBeNull();
    expect(container.querySelector('[aria-label="Provider"]')).toBeNull();
  });

  it('narrows the cards by a machine nothing on this screen chose', async () => {
    await mountWith(hubFrames.machineStatePopulated);

    await narrowTo({ machine: 'registration-gpu-box-01' });

    expect(hrefs()).toEqual([
      '#/session/store-universe/session-docs-sweep',
      '#/session/store-universe/session-bench-tokenizer',
      '#/session/store-universe/session-train-lora',
    ]);
  });

  it('counts the chips under the narrowings the popover is holding', async () => {
    await mountWith(hubFrames.machineStatePopulated);
    expect(container.textContent).toContain('All · 6');

    await narrowTo({ machine: 'registration-gpu-box-01' });

    // Three sessions on that machine, in three states: the All chip is a
    // promise about the rows pressing it yields, not about the whole fleet.
    expect(container.textContent).toContain('All · 3');
  });

  it('lets a narrowing whose option has left the fleet narrow nothing', async () => {
    await mountWith(hubFrames.machineStatePopulated);

    await narrowTo({ storeId: 'store-nowhere' });

    // The rule is `effectiveFilters`'s now. The choice is kept in case the
    // store comes back; what it must not do is empty the list meanwhile.
    expect(hrefs()).toHaveLength(6);
  });

  it('reads the age window against the clock it was given', async () => {
    await mountWith(hubFrames.machineStatePopulated);

    await narrowTo({ updatedWithin: '1h' });

    // The captured fleet against the fixed moment: one session was written two
    // hours ago, and the one written exactly an hour ago is inside the window.
    expect(hrefs()).toEqual([
      '#/session/store-agentplex/session-migrate-db',
      '#/session/store-universe/session-docs-sweep',
      '#/session/store-agentplex/session-fix-auth',
      '#/session/store-universe/session-bench-tokenizer',
      '#/session/store-universe/session-train-lora',
    ]);
  });

  it('draws the filter row only in the phone form, where there is no sidebar', async () => {
    await mountWith(hubFrames.machineStatePopulated);

    // The chips are on the screen at both widths, as the mockup draws them;
    // the row at this width is the sidebar's, and a second one here would be
    // two boxes typing into one field and two badges counting one set.
    expect(container.textContent).toContain('Needs you · 2');
    expect(searchBox()).toBeNull();
    expect(filterTrigger()).toBeNull();
  });

  it('types the phone form’s letters into the narrowings both forms share', async () => {
    await mountWith(hubFrames.machineStatePopulated, undefined, 'phone');
    const box = searchBox();
    if (box === null) throw new Error('the phone form drew no filter box');

    await act(() => {
      typeInto(box, 'docs');
    });

    expect(appSessionFiltersStore(store).getSnapshot().search).toBe('docs');
    expect(hrefs()).toEqual(['#/session/store-universe/session-docs-sweep']);
  });

  it('reaches the store narrowing through the popover on a phone', async () => {
    // The phone has no sidebar, so this row is the only way to Store, Provider
    // and the three narrowings beside them. Before it was drawn here, moving
    // the two selects into the popover took them off the phone altogether.
    await mountWith(hubFrames.machineStatePopulated, undefined, 'phone');

    await narrowThroughPopover('Store', 'store-universe');

    expect(appSessionFiltersStore(store).getSnapshot().storeId).toBe('store-universe');
    expect(hrefs()).toEqual([
      '#/session/store-universe/session-docs-sweep',
      '#/session/store-universe/session-bench-tokenizer',
      '#/session/store-universe/session-train-lora',
    ]);
  });

  it('presses a chip into the shared narrowings rather than into its own state', async () => {
    await mountWith(hubFrames.machineStatePopulated);

    await click(chipButton('Needs you'));

    expect(appSessionFiltersStore(store).getSnapshot().chip).toBe('needs-you');
    expect(hrefs()).toEqual([
      '#/session/store-agentplex/session-migrate-db',
      '#/session/store-universe/session-docs-sweep',
    ]);
  });

  it('shows a chip pressed when the store says it is, whoever wrote it', async () => {
    await mountWith(hubFrames.machineStatePopulated);

    await narrowTo({ chip: 'idle' });

    expect(chipButton('Idle').getAttribute('aria-pressed')).toBe('true');
    expect(chipButton('All').getAttribute('aria-pressed')).toBe('false');
  });

  /**
   * The two forms, and the toggle that chooses between them.
   *
   * What is asserted here is the thing the ticket is actually about: the same
   * sessions, read two ways. So every test below goes through `hrefs()` -- the
   * addresses the list drew -- rather than through counting elements, because
   * "the list shows what the grid showed" is a claim about which sessions are
   * on the screen and in what order, and one `visible` array behind both forms
   * is what makes it true.
   */

  /**
   * Which component drew each article the list put out. The card stacks its
   * facts down a column and the row lines them up across one line: that is the
   * whole difference between the two forms, and the one part of it a DOM with
   * no layout engine can still be asked about.
   */
  function drawnForms(): string[] {
    return [...container.querySelectorAll<HTMLElement>('article')].map((article) =>
      article.style.flexDirection === 'column' ? 'card' : 'row',
    );
  }

  /** The toggle's options, which are words rather than icons on purpose. */
  function viewButtons(): string[] {
    return [...container.querySelectorAll<HTMLElement>('[aria-pressed]')]
      .map((button) => button.textContent ?? '')
      .filter((text) => text === 'Grid' || text === 'List');
  }

  function viewButton(label: string): HTMLElement {
    const found = [...container.querySelectorAll<HTMLElement>('[aria-pressed]')].find(
      (button) => button.textContent === label,
    );
    if (found === undefined) throw new Error(`no view button reading ${label}`);
    return found;
  }

  /** The node menus the screen built out of the tree, one per session it holds. */
  function menuLabels(): (string | null)[] {
    return [...container.querySelectorAll('button[aria-label^="Actions for "]')].map((button) =>
      button.getAttribute('aria-label'),
    );
  }

  /** A view written by nobody on this screen, the way the toggle writes it. */
  async function showAs(view: SessionListView): Promise<void> {
    await act(() => {
      appSessionFiltersStore(store).setView(view);
    });
  }

  it('names its two forms in words, so neither option is an icon alone', async () => {
    await mountWith(hubFrames.machineStatePopulated);

    expect(viewButtons()).toEqual(['Grid', 'List']);
    // The grid is the form every mockup that draws the toggle draws selected.
    expect(viewButton('Grid').getAttribute('aria-pressed')).toBe('true');
    expect(viewButton('List').getAttribute('aria-pressed')).toBe('false');
  });

  it('draws no toggle in the phone form, where the feed is the only form', async () => {
    await mountWith(hubFrames.machineStatePopulated, undefined, 'phone');

    // Gated on the form the screen was handed rather than on a media query,
    // for the reason the New session button beside it is: one rule in one
    // place, or two spellings of the breakpoint that disagree at any font size
    // but the default.
    expect(viewButtons()).toEqual([]);
  });

  it('presses the view into the shared store rather than into its own state', async () => {
    await mountWith(hubFrames.machineStatePopulated);

    await click(viewButton('List'));

    expect(appSessionFiltersStore(store).getView()).toBe('list');
  });

  it('shows the form the store says, whoever wrote it', async () => {
    await mountWith(hubFrames.machineStatePopulated);
    expect(drawnForms()).toEqual(['card', 'card', 'card', 'card', 'card', 'card']);

    await showAs('list');

    expect(viewButton('List').getAttribute('aria-pressed')).toBe('true');
    expect(drawnForms()).toEqual(['row', 'row', 'row', 'row', 'row', 'row']);
  });

  it('draws in the list exactly the sessions the grid drew, in the same order', async () => {
    await mountWith(hubFrames.machineStatePopulated);
    await narrowTo({ machine: 'registration-gpu-box-01' });
    const inTheGrid = hrefs();
    expect(inTheGrid).toHaveLength(3);

    await showAs('list');

    // One `visible` array behind both forms, which is what makes the same
    // narrowing incapable of yielding two counts.
    expect(hrefs()).toEqual(inTheGrid);
  });

  it('keeps the needs-you partition at the head of the list, as the grid does', async () => {
    await mountWith(hubFrames.machineStatePopulated);
    const inTheGrid = hrefs();

    await showAs('list');

    // The partition is an ordering and not a heading -- there is no heading to
    // draw in either form -- so what holds is that the two sessions asking for
    // somebody still lead the six, in the order the grid had them.
    expect(hrefs()).toEqual(inTheGrid);
    expect(hrefs().slice(0, 2)).toEqual([
      '#/session/store-agentplex/session-migrate-db',
      '#/session/store-universe/session-docs-sweep',
    ]);
    expect(buttonsLabelled('acknowledge').map((b) => b.getAttribute('aria-label'))).toEqual([
      'acknowledge migrate-db-v9',
      'acknowledge docs-sweep',
    ]);
  });

  it('hands a row the node menu the card was handed, off the same tree', async () => {
    const socket = await mountWith(hubFrames.machineStatePopulated);
    // Captured from a real hub: a tree holding two of the six sessions. The
    // other four get no menu in either form, which is the rule about a session
    // the tree has no node for and not a difference between the forms.
    await act(() => {
      socket.deliver(hubFrames.layoutWithProject);
    });
    const inTheGrid = menuLabels();
    expect(inTheGrid).toEqual(['Actions for fix-auth-refresh', 'Actions for spike-wasm']);

    await showAs('list');

    expect(menuLabels()).toEqual(inTheGrid);
  });

  it('keeps the row’s stop and attention, which are the card’s own', async () => {
    await mountWith(hubFrames.machineStatePopulated);

    await showAs('list');

    expect(stopButtons().map((button) => button.getAttribute('aria-label'))).toEqual([
      'stop session-migrate-db',
    ]);
    expect(buttonsLabelled('mute').map((b) => b.getAttribute('aria-label'))).toEqual([
      'mute migrate-db-v9',
      'mute docs-sweep',
    ]);
  });

  it('draws cards on a phone whatever the view was last left on', async () => {
    await mountWith(hubFrames.machineStatePopulated, undefined, 'phone');

    await showAs('list');

    // The phone feed is the grid at one column (mockup 7e) and there is no
    // toggle there to have chosen otherwise, so a list written at a wider
    // width must not follow the window down.
    expect(drawnForms()).toEqual(['card', 'card', 'card', 'card', 'card', 'card']);
  });
});
