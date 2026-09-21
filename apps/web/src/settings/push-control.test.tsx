// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseClientFrame, parseTextFrame, type ClientFrame } from '@agentplex/protocol';
import { createFakeSocketFactory, type FakeSocket } from '../store/fake-socket.js';
import { createFrameIdCounter } from '../store/frame-ids.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { createHubStore, type HubStore } from '../store/hub-store.js';
import { createFakeTimers } from '../store/timers.js';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import {
  createFakePushOperations,
  FAKE_PUSH_SUBSCRIPTION,
  type FakePushOperations,
} from './fake-push-operations.js';
import { PushControl } from './push-control.js';

/**
 * The control, over a real store walked through captured frames and a fake
 * browser.
 *
 * The store is the real one on a fake socket, as everywhere else in this
 * suite: what the control does on a press is send a frame and wait for the
 * answer to that frame, and a hand-written store would be a claim about what
 * the hub says rather than the capture of one.
 *
 * The browser is a fake because none of what this control touches exists in
 * jsdom, and because the load-bearing assertions are about calls that must not
 * happen: mounting asks nobody for permission, and a blocked browser is not
 * asked a second time.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

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

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sentFrames(socket: FakeSocket): ClientFrame[] {
  return socket.sent.map((text) => {
    const parsed = parseTextFrame(parseClientFrame, text);
    if (!parsed.ok) throw new Error(`the store sent something unreadable: ${parsed.reason}`);
    return parsed.value;
  });
}

describe('the push control', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let store: HubStore;
  let sockets: ReturnType<typeof createFakeSocketFactory>;

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
    container.remove();
  });

  /** Mounts the control over a hub that said which welcome it was sent. */
  async function draw(push: FakePushOperations, welcome: string): Promise<FakeSocket> {
    await act(async () => {
      root = createRoot(container);
      root.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="dark"
        >
          <PushControl store={store} push={push} />
        </MantineProvider>,
      );
    });
    const socket = sockets.sockets[0];
    if (socket === undefined) throw new Error('the store dialled nothing');
    await act(async () => {
      socket.open();
      socket.deliver(welcome);
      await settle();
    });
    return socket;
  }

  /**
   * What the control says, with the provider's own stylesheet taken out.
   *
   * `MantineProvider` renders its CSS variables as a `<style>` inside the
   * tree, so a bare `textContent` is a few kilobytes of custom properties
   * with the sentences at the end -- and "this control says nothing at all"
   * is the one assertion that cannot be written against that.
   */
  function words(): string {
    const clone = container.cloneNode(true) as HTMLElement;
    for (const style of clone.querySelectorAll('style')) style.remove();
    return clone.textContent ?? '';
  }

  function button(label: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button')].find((candidate) =>
      (candidate.textContent ?? '').includes(label),
    );
    if (found === undefined) throw new Error(`no "${label}" button: ${words()}`);
    return found;
  }

  async function press(label: string): Promise<void> {
    const target = button(label);
    await act(async () => {
      target.click();
      await settle();
    });
  }

  it('says nothing at all where this browser has no push', async () => {
    const push = createFakePushOperations({ state: { supported: false } });

    await draw(push, hubFrames.welcomeWithPush);

    // Not a heading, not a disabled button, not an explanation. There is
    // nothing a person could do about it and no browser setting that turns
    // it on: the in-page attention line is the floor, and it is already there.
    expect(words()).toBe('');
  });

  it('says in words that this hub cannot push, and offers nothing', async () => {
    const push = createFakePushOperations();

    await draw(push, hubFrames.welcome);

    expect(words()).toContain('not available from this hub');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('asks nobody for anything by being mounted', async () => {
    const push = createFakePushOperations();

    await draw(push, hubFrames.welcomeWithPush);

    // The whole reason permission lives in the click handler. A prompt on
    // mount is the one browsers have taught people to dismiss, and a
    // dismissal is forever.
    expect(push.permissionRequests).toBe(0);
    expect(push.subscribes).toHaveLength(0);
    expect(button('Turn on')).toBeDefined();
  });

  it('mounts the status region before it has anything to say', async () => {
    const push = createFakePushOperations();

    await draw(push, hubFrames.welcomeWithPush);

    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.textContent).toBe('');
  });

  it('says who is told, because there is one hub token and no accounts', async () => {
    const push = createFakePushOperations();

    await draw(push, hubFrames.welcomeWithPush);

    expect(words()).toContain('one shared hub token');
    expect(words()).toContain('mute and acknowledge are shared');
  });

  it('asks, subscribes against the hub’s key, tells the hub, and says so', async () => {
    const push = createFakePushOperations({ permission: 'granted' });
    const socket = await draw(push, hubFrames.welcomeWithPush);

    await press('Turn on');

    expect(push.permissionRequests).toBe(1);
    // The bytes of the key the welcome carried, which is what the browser
    // takes -- Safari has never accepted the base64url text.
    expect(push.subscribes[0]?.[0]).toBe(4);
    expect(push.subscribes[0]?.length).toBe(65);
    const frame = sentFrames(socket).at(-1);
    expect(frame).toMatchObject({
      type: 'push-subscribe',
      subscription: { endpoint: FAKE_PUSH_SUBSCRIPTION.endpoint },
    });

    // Nothing claims a subscription until the hub says it recorded one.
    expect(words()).not.toContain('This browser is subscribed');

    await act(async () => {
      socket.deliver(hubFrames.pushSubscribed);
      await settle();
    });

    expect(words()).toContain('This browser is subscribed');
    expect(button('Turn off')).toBeDefined();

    // And off again, on the same connection, which is also the conversation
    // the fixture was captured from: the unsubscribe answers the second frame
    // this client sent, and correlating by id is what tells this control's
    // answer from another tab's.
    await press('Turn off');

    expect(push.unsubscribes).toBe(1);
    expect(sentFrames(socket).at(-1)).toMatchObject({
      type: 'push-unsubscribe',
      endpoint: FAKE_PUSH_SUBSCRIPTION.endpoint,
    });

    await act(async () => {
      socket.deliver(hubFrames.pushUnsubscribed);
      await settle();
    });

    expect(button('Turn on')).toBeDefined();
    expect(words()).toContain('The hub has forgotten this browser');
  });

  it('names the browser’s site settings when the person said no, and does not ask again', async () => {
    const push = createFakePushOperations({ permission: 'denied' });
    const socket = await draw(push, hubFrames.welcomeWithPush);

    await press('Turn on');

    expect(words()).toContain('site settings');
    expect(push.subscribes).toHaveLength(0);
    expect(sentFrames(socket).some((frame) => frame.type === 'push-subscribe')).toBe(false);
    // The button is gone, so nothing here can ask a second time by itself or
    // invite a press that the browser answers silently.
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(push.permissionRequests).toBe(1);
  });

  it('says what the hub refused, without pretending the subscription exists', async () => {
    const push = createFakePushOperations({ permission: 'granted' });
    const socket = await draw(push, hubFrames.welcomeWithPush);

    await press('Turn on');
    await act(async () => {
      socket.deliver(hubFrames.refusalNoPush);
      await settle();
    });

    expect(words()).toContain('no push key pair');
    expect(words()).not.toContain('This browser is subscribed');
  });

  it('says what the browser refused, and sends the hub nothing', async () => {
    const push = createFakePushOperations({
      permission: 'granted',
      subscribeAnswer: { ok: false, reason: 'This browser refused to subscribe: AbortError' },
    });
    const socket = await draw(push, hubFrames.welcomeWithPush);

    await press('Turn on');

    expect(words()).toContain('AbortError');
    expect(sentFrames(socket).some((frame) => frame.type === 'push-subscribe')).toBe(false);
  });

  it('opens on Turn off where this browser was already subscribed', async () => {
    // Read from the browser and not from the hub: what a browser is
    // subscribed to lives in the browser, and the store's own view is a
    // receipt for the last frame rather than the state of a subscription.
    const push = createFakePushOperations({
      state: { permission: 'granted', subscription: FAKE_PUSH_SUBSCRIPTION },
    });

    await draw(push, hubFrames.welcomeWithPush);

    expect(button('Turn off')).toBeDefined();
    expect(push.permissionRequests).toBe(0);
  });

  it('tells the hub to stop even when the browser would not drop its subscription', async () => {
    // Two halves, and the person pressed the button once. The hub forgetting
    // the row is the half that stops the notifications arriving, so it still
    // goes out -- and the half that failed is said in words rather than
    // swallowed.
    const push = createFakePushOperations({
      state: { permission: 'granted', subscription: FAKE_PUSH_SUBSCRIPTION },
      unsubscribeAnswer: {
        ok: false,
        reason: 'This browser would not drop its subscription: gone wrong',
        endpoint: FAKE_PUSH_SUBSCRIPTION.endpoint,
      },
    });
    const socket = await draw(push, hubFrames.welcomeWithPush);

    await press('Turn off');

    expect(words()).toContain('gone wrong');
    expect(sentFrames(socket).at(-1)).toMatchObject({ type: 'push-unsubscribe' });
  });
});
