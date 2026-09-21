import { describe, expect, it } from 'vitest';
import {
  createBrowserPushOperations,
  type BrowserPushSubscription,
  type PushCapableGlobals,
} from './push-operations.js';

/**
 * The operations over a real browser, with the browser handed in.
 *
 * Every global this touches is one a test cannot supply -- a service worker
 * registration, a push manager, the notification permission -- so they arrive
 * as an argument and the composition root passes `globalThis`. What is
 * asserted here is the half that is easy to get wrong without noticing: which
 * absences mean "this browser cannot", what a subscription is turned into
 * before it is believed, and that a half-failure says which half failed.
 */

const SUBSCRIPTION_JSON = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bHxN0-example',
  keys: {
    p256dh:
      'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  },
};

interface Recorded {
  readonly subscribeOptions: unknown[];
  readonly unsubscribed: number;
}

function fakeSubscription(
  json: unknown,
  unsubscribe?: () => Promise<boolean>,
): BrowserPushSubscription {
  return {
    toJSON: () => json,
    unsubscribe: unsubscribe ?? (() => Promise.resolve(true)),
  };
}

interface BrowserOptions {
  readonly permission?: string;
  readonly existing?: BrowserPushSubscription | null;
  readonly subscribe?: (options: unknown) => Promise<BrowserPushSubscription>;
  readonly requestPermission?: () => Promise<string>;
}

function browser(options: BrowserOptions = {}): {
  globals: PushCapableGlobals;
  recorded: Recorded;
} {
  const recorded: Recorded = { subscribeOptions: [], unsubscribed: 0 };
  const globals: PushCapableGlobals = {
    PushManager: class {},
    Notification: {
      permission: options.permission ?? 'default',
      requestPermission: options.requestPermission ?? (() => Promise.resolve('granted')),
    },
    navigator: {
      serviceWorker: {
        ready: Promise.resolve({
          pushManager: {
            getSubscription: () => Promise.resolve(options.existing ?? null),
            subscribe: (subscribeOptions: unknown) => {
              recorded.subscribeOptions.push(subscribeOptions);
              return (
                options.subscribe?.(subscribeOptions) ??
                Promise.resolve(fakeSubscription(SUBSCRIPTION_JSON))
              );
            },
          },
        }),
      },
    },
  };
  return { globals, recorded };
}

describe('the push operations over a browser', () => {
  it('reports unsupported where there is no push manager', async () => {
    const { globals } = browser();
    const operations = createBrowserPushOperations({ ...globals, PushManager: undefined });

    expect(await operations.read()).toMatchObject({ supported: false });
  });

  it('reports unsupported where there are no notifications', async () => {
    const { globals } = browser();
    const operations = createBrowserPushOperations({ ...globals, Notification: undefined });

    expect(await operations.read()).toMatchObject({ supported: false });
  });

  it('reports unsupported where nothing registered a service worker', async () => {
    // The worker is what receives a push. A browser with the API and no
    // registration -- a dev build, a private window that refused -- has
    // nowhere for a notification to arrive, and saying so is not the same as
    // offering a button that mints a subscription nothing will ever handle.
    const { globals } = browser();
    const operations = createBrowserPushOperations({ ...globals, navigator: {} });

    expect(await operations.read()).toMatchObject({ supported: false });
  });

  it('reads the permission and the subscription this browser already holds', async () => {
    const { globals } = browser({
      permission: 'granted',
      existing: fakeSubscription(SUBSCRIPTION_JSON),
    });

    const state = await createBrowserPushOperations(globals).read();

    expect(state.supported).toBe(true);
    expect(state.permission).toBe('granted');
    expect(state.subscription?.endpoint).toBe(SUBSCRIPTION_JSON.endpoint);
    expect(state.problem).toBeNull();
  });

  it('reads a permission it does not recognise as the one that asks nothing', async () => {
    const { globals } = browser({ permission: 'wat' });

    expect((await createBrowserPushOperations(globals).read()).permission).toBe('default');
  });

  it('says a subscription it cannot parse is there, rather than reporting none', async () => {
    // Claiming "not subscribed" would be the over-claim: the browser holds
    // something, it may well be receiving pushes, and a control that offered
    // to turn push on would meet the browser's own refusal to re-subscribe
    // against a different key.
    const { globals } = browser({ existing: fakeSubscription({ endpoint: 'http://nope' }) });

    const state = await createBrowserPushOperations(globals).read();

    expect(state.subscription).toBeNull();
    expect(state.problem).not.toBeNull();
  });

  it('asks the browser for permission only when asked to', async () => {
    let asked = 0;
    const { globals } = browser({
      requestPermission: () => {
        asked += 1;
        return Promise.resolve('denied');
      },
    });
    const operations = createBrowserPushOperations(globals);

    await operations.read();
    expect(asked).toBe(0);

    expect(await operations.requestPermission()).toBe('denied');
    expect(asked).toBe(1);
  });

  it('subscribes visibly, against the key it was handed', async () => {
    const { globals, recorded } = browser({ permission: 'granted' });
    const key = new Uint8Array([4, 1, 2, 3]);

    const outcome = await createBrowserPushOperations(globals).subscribe(key);

    expect(outcome).toMatchObject({ ok: true });
    expect(recorded.subscribeOptions[0]).toMatchObject({
      // Every browser refuses a silent subscription; saying so is not
      // optional, and a push that shows nothing is not what was asked for.
      userVisibleOnly: true,
      applicationServerKey: key,
    });
  });

  it('turns a browser’s refusal to subscribe into words', async () => {
    const { globals } = browser({
      subscribe: () => Promise.reject(new Error('AbortError: registration failed')),
    });

    const outcome = await createBrowserPushOperations(globals).subscribe(new Uint8Array([4]));

    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.reason).toContain('registration failed');
  });

  it('refuses a subscription the browser minted that is not one', async () => {
    const { globals } = browser({ subscribe: () => Promise.resolve(fakeSubscription({})) });

    expect(await createBrowserPushOperations(globals).subscribe(new Uint8Array([4]))).toMatchObject(
      {
        ok: false,
      },
    );
  });

  it('drops the browser’s subscription and names the endpoint it dropped', async () => {
    let dropped = 0;
    const { globals } = browser({
      existing: fakeSubscription(SUBSCRIPTION_JSON, () => {
        dropped += 1;
        return Promise.resolve(true);
      }),
    });

    const outcome = await createBrowserPushOperations(globals).unsubscribe();

    expect(dropped).toBe(1);
    expect(outcome).toMatchObject({ ok: true, endpoint: SUBSCRIPTION_JSON.endpoint });
  });

  it('names the endpoint even when the browser refused to drop it', async () => {
    // The endpoint is what the hub stores, so it is still worth telling the
    // hub to stop sending there. Reporting the failure and the endpoint is
    // what lets the control do both halves honestly.
    const { globals } = browser({
      existing: fakeSubscription(SUBSCRIPTION_JSON, () => Promise.reject(new Error('gone wrong'))),
    });

    const outcome = await createBrowserPushOperations(globals).unsubscribe();

    expect(outcome.ok).toBe(false);
    expect(outcome.endpoint).toBe(SUBSCRIPTION_JSON.endpoint);
    expect(outcome.ok ? '' : outcome.reason).toContain('gone wrong');
  });

  it('says so when there was no subscription to drop', async () => {
    const outcome = await createBrowserPushOperations(browser().globals).unsubscribe();

    expect(outcome).toMatchObject({ ok: false, endpoint: null });
  });
});
