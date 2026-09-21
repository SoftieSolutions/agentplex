import { pushSubscriptionSchema, type PushSubscription } from '@agentplex/protocol';
import type {
  PushBrowserState,
  PushOperations,
  PushPermission,
  PushSubscribeOutcome,
  PushUnsubscribeOutcome,
} from './push-operations.js';

/**
 * A `PushOperations` that answers what a test set up and keeps count of what
 * it was asked.
 *
 * It lives beside the interface rather than inside one test file because the
 * counts are the point of the seam: "mounting the control asked nobody for
 * permission" is an assertion about a call that did not happen, and a fake
 * copied into a second test file would be free to drift into answering the
 * same question differently.
 *
 * It moves like a browser does: a granted permission and a successful
 * subscribe change what `read` says afterwards. A fake that answered the same
 * thing forever would let a control pass this suite while never noticing that
 * it is now subscribed, which is the one state change the button's label
 * hangs on.
 */
export interface FakePushOperations extends PushOperations {
  /** How many times a prompt was put in front of somebody. */
  readonly permissionRequests: number;
  /** The key each subscribe was made against, in order. */
  readonly subscribes: readonly Uint8Array<ArrayBuffer>[];
  /** How many times this browser was asked to drop its subscription. */
  readonly unsubscribes: number;
}

/** A subscription in the shape a browser hands over, through the parser. */
export const FAKE_PUSH_SUBSCRIPTION: PushSubscription = pushSubscriptionSchema.parse({
  endpoint: 'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bHxN0-example',
  keys: {
    p256dh:
      'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  },
});

export interface FakePushOperationsOptions {
  /** Where this browser starts. Supported, unasked and unsubscribed by default. */
  readonly state?: Partial<PushBrowserState>;
  /** What the prompt answers. */
  readonly permission?: PushPermission;
  /** What `subscribe` answers, for a test about a browser that refuses. */
  readonly subscribeAnswer?: PushSubscribeOutcome;
  /** What `unsubscribe` answers, for a test about a half that failed. */
  readonly unsubscribeAnswer?: PushUnsubscribeOutcome;
}

export function createFakePushOperations(
  options: FakePushOperationsOptions = {},
): FakePushOperations {
  let state: PushBrowserState = {
    supported: true,
    permission: 'default',
    subscription: null,
    problem: null,
    ...options.state,
  };
  const subscribes: Uint8Array<ArrayBuffer>[] = [];
  let permissionRequests = 0;
  let unsubscribes = 0;

  return {
    read(): Promise<PushBrowserState> {
      return Promise.resolve(state);
    },

    requestPermission(): Promise<PushPermission> {
      permissionRequests += 1;
      const answer = options.permission ?? 'granted';
      state = { ...state, permission: answer };
      return Promise.resolve(answer);
    },

    subscribe(applicationServerKey: Uint8Array<ArrayBuffer>): Promise<PushSubscribeOutcome> {
      subscribes.push(applicationServerKey);
      const answer: PushSubscribeOutcome = options.subscribeAnswer ?? {
        ok: true,
        subscription: FAKE_PUSH_SUBSCRIPTION,
      };
      if (answer.ok) state = { ...state, subscription: answer.subscription };
      return Promise.resolve(answer);
    },

    unsubscribe(): Promise<PushUnsubscribeOutcome> {
      unsubscribes += 1;
      const endpoint = state.subscription?.endpoint ?? null;
      const answer: PushUnsubscribeOutcome =
        options.unsubscribeAnswer ??
        (endpoint === null
          ? { ok: false, reason: 'This browser holds no subscription to drop.', endpoint: null }
          : { ok: true, endpoint });
      if (answer.ok) state = { ...state, subscription: null };
      return Promise.resolve(answer);
    },

    get permissionRequests(): number {
      return permissionRequests;
    },
    get subscribes(): readonly Uint8Array<ArrayBuffer>[] {
      return [...subscribes];
    },
    get unsubscribes(): number {
      return unsubscribes;
    },
  };
}
