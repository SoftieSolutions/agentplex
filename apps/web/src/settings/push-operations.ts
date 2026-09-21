import {
  pushSubscriptionSchema,
  type PushEndpoint,
  type PushSubscription,
} from '@agentplex/protocol';

/**
 * Notifications from this browser's side, behind an interface a test can hand
 * in.
 *
 * The settings screen already talks to the hub through `PairingOperations`
 * rather than to the store, for the reason a screen should never hold more
 * than it does; this is the same seam pointed the other way, at the browser.
 * Nothing in here can be faked with a jsdom global: `navigator.serviceWorker`
 * has no registration in jsdom, `PushManager` does not exist there at all, and
 * `Notification.requestPermission` is the one call in this app that puts a
 * dialog in front of a person. So the browser is injected, the composition
 * root passes `globalThis`, and a test passes an object.
 *
 * The registration is reached through `navigator.serviceWorker.ready` rather
 * than through `registerServiceWorker`, whose `register(url): Promise<unknown>`
 * keeps the registration deliberately opaque. Widening that seam was the
 * alternative and it is the worse one: registration happens once, in
 * `main.tsx`, in production builds only, and its promise is resolved and gone
 * long before anybody opens Settings -- so a control that waited on its return
 * value would be waiting on a value nobody kept, and the seam would have to
 * grow a stored registration for a screen that may never be opened. `ready` is
 * the browser's own answer to exactly this question ("the active registration
 * for this page"), it resolves whoever registered and whenever, and it leaves
 * `registerServiceWorker` a function that registers a worker and returns
 * nothing worth holding.
 */

/** The three answers `Notification.permission` gives. */
export type PushPermission = 'default' | 'granted' | 'denied';

/** What this browser says about itself, asked for nothing and prompting nobody. */
export interface PushBrowserState {
  /** False where the Push API, notifications or a worker registration is missing. */
  readonly supported: boolean;
  readonly permission: PushPermission;
  /** The subscription this browser holds, parsed, or `null` where it holds none. */
  readonly subscription: PushSubscription | null;
  /**
   * Why this browser's own answer could not be taken at face value, or `null`.
   *
   * A subscription that will not parse is the case this exists for: the
   * browser holds *something*, and reporting "not subscribed" would be the
   * over-claiming degrade -- it would offer to turn on what may already be on.
   */
  readonly problem: string | null;
}

export type PushSubscribeOutcome =
  | { readonly ok: true; readonly subscription: PushSubscription }
  | { readonly ok: false; readonly reason: string };

/**
 * Dropping a subscription, with the endpoint in both branches.
 *
 * The endpoint rides along even on a failure because the two halves of
 * turning push off are separate: the browser drops its subscription, and the
 * hub forgets the row. A browser that refused the first half has still named
 * the endpoint of the row, and the hub can still be told to stop sending to
 * it -- which is what the person pressing the button wanted. `null` is the
 * honest "there was nothing here to name".
 */
export type PushUnsubscribeOutcome =
  | { readonly ok: true; readonly endpoint: PushEndpoint }
  | { readonly ok: false; readonly reason: string; readonly endpoint: PushEndpoint | null };

export interface PushOperations {
  /** What this browser holds right now. Prompts nobody and asks for nothing. */
  read(): Promise<PushBrowserState>;
  /**
   * The permission prompt.
   *
   * Called from a click handler and from nowhere else, which is a rule about
   * people rather than about React: a prompt on page load is the one every
   * browser has taught its users to dismiss, and a dismissal is permanent.
   */
  requestPermission(): Promise<PushPermission>;
  /**
   * Mints a subscription against the hub's key, as bytes.
   *
   * `Uint8Array<ArrayBuffer>` and not a bare `Uint8Array`, which since
   * TypeScript 5.7 also covers a view onto a `SharedArrayBuffer` -- and the
   * DOM's `applicationServerKey` is a `BufferSource` over a plain
   * `ArrayBuffer`. The narrower type is what the browser takes.
   */
  subscribe(applicationServerKey: Uint8Array<ArrayBuffer>): Promise<PushSubscribeOutcome>;
  /** Drops whatever subscription this browser holds. */
  unsubscribe(): Promise<PushUnsubscribeOutcome>;
}

/** The slice of `PushSubscription` this app uses -- the DOM's is wider. */
export interface BrowserPushSubscription {
  toJSON(): unknown;
  unsubscribe(): Promise<boolean>;
}

/** The slice of `PushManager` this app uses. */
export interface BrowserPushManager {
  getSubscription(): Promise<BrowserPushSubscription | null>;
  subscribe(options: {
    readonly userVisibleOnly: boolean;
    readonly applicationServerKey: Uint8Array<ArrayBuffer>;
  }): Promise<BrowserPushSubscription>;
}

/** The slice of `ServiceWorkerRegistration` this app uses. */
export interface BrowserPushRegistration {
  readonly pushManager: BrowserPushManager;
}

/**
 * The globals these operations read, in the shape `globalThis` already has.
 *
 * Every field is optional because every one of them is absent somewhere:
 * `PushManager` on a browser without the Push API, `Notification` on iOS
 * outside an installed app, `navigator.serviceWorker` in an insecure context
 * or a private window. The real `globalThis` declares them non-optional, which
 * assigns to this happily and is exactly the lie this shape corrects.
 */
export interface PushCapableGlobals {
  readonly PushManager?: unknown;
  readonly Notification?:
    { readonly permission: string; requestPermission(): Promise<string> } | undefined;
  readonly navigator?:
    | { readonly serviceWorker?: { readonly ready: Promise<BrowserPushRegistration> } | undefined }
    | undefined;
}

const UNSUPPORTED: PushBrowserState = {
  supported: false,
  permission: 'default',
  subscription: null,
  problem: null,
};

/** A permission is a word off a browser: parsed, and unknown means unasked. */
function readPermission(text: string): PushPermission {
  return text === 'granted' || text === 'denied' ? text : 'default';
}

/** Whatever was thrown, in words a person can read beside a button. */
function words(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

export function createBrowserPushOperations(globals: PushCapableGlobals): PushOperations {
  const notifications = globals.Notification;
  const ready = globals.navigator?.serviceWorker?.ready;
  const supported = globals.PushManager !== undefined && notifications !== undefined;

  /** The push manager of the active registration, or `null` where there is none. */
  async function manager(): Promise<BrowserPushManager | null> {
    if (!supported || ready === undefined) return null;
    try {
      return (await ready).pushManager;
    } catch {
      // A registration that never becomes active is a browser with no worker,
      // as far as anything here is concerned.
      return null;
    }
  }

  async function held(): Promise<BrowserPushSubscription | null> {
    const pushManager = await manager();
    if (pushManager === null) return null;
    try {
      return await pushManager.getSubscription();
    } catch {
      return null;
    }
  }

  return {
    async read(): Promise<PushBrowserState> {
      const pushManager = await manager();
      if (pushManager === null || notifications === undefined) return UNSUPPORTED;
      const permission = readPermission(notifications.permission);
      let existing: BrowserPushSubscription | null;
      try {
        existing = await pushManager.getSubscription();
      } catch (thrown) {
        return {
          supported: true,
          permission,
          subscription: null,
          problem: `This browser would not say whether it is subscribed: ${words(thrown)}`,
        };
      }
      if (existing === null) {
        return { supported: true, permission, subscription: null, problem: null };
      }
      const parsed = pushSubscriptionSchema.safeParse(existing.toJSON());
      if (!parsed.success) {
        return {
          supported: true,
          permission,
          subscription: null,
          problem:
            'This browser holds a subscription this page cannot read, so it may still be ' +
            'receiving notifications. Clearing this site’s data in the browser removes it.',
        };
      }
      return { supported: true, permission, subscription: parsed.data, problem: null };
    },

    async requestPermission(): Promise<PushPermission> {
      if (notifications === undefined) return 'default';
      try {
        return readPermission(await notifications.requestPermission());
      } catch {
        // A browser that throws rather than answering has not granted
        // anything, and `default` is the answer that neither claims a grant
        // nor tells somebody to go and unblock a site they never blocked.
        return 'default';
      }
    },

    async subscribe(applicationServerKey: Uint8Array<ArrayBuffer>): Promise<PushSubscribeOutcome> {
      const pushManager = await manager();
      if (pushManager === null) {
        return { ok: false, reason: 'This browser has no service worker to receive a push.' };
      }
      let minted: BrowserPushSubscription;
      try {
        minted = await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      } catch (thrown) {
        return {
          ok: false,
          reason: `This browser refused to subscribe: ${words(thrown)}`,
        };
      }
      const parsed = pushSubscriptionSchema.safeParse(minted.toJSON());
      if (!parsed.success) {
        // Nothing is sent to the hub: a row it could never push to is worse
        // than no row, and the browser is the one thing that can be believed
        // about what it minted.
        return {
          ok: false,
          reason: 'This browser produced a subscription that is not one, and nothing was sent.',
        };
      }
      return { ok: true, subscription: parsed.data };
    },

    async unsubscribe(): Promise<PushUnsubscribeOutcome> {
      const existing = await held();
      if (existing === null) {
        return {
          ok: false,
          reason: 'This browser holds no subscription to drop.',
          endpoint: null,
        };
      }
      const parsed = pushSubscriptionSchema.safeParse(existing.toJSON());
      const endpoint = parsed.success ? parsed.data.endpoint : null;
      try {
        const dropped = await existing.unsubscribe();
        if (!dropped) {
          return {
            ok: false,
            reason: 'This browser said its subscription was already gone.',
            endpoint,
          };
        }
      } catch (thrown) {
        return {
          ok: false,
          reason: `This browser would not drop its subscription: ${words(thrown)}`,
          endpoint,
        };
      }
      if (endpoint === null) {
        return {
          ok: false,
          reason:
            'The subscription was dropped here, but its endpoint could not be read, so the hub ' +
            'was not told to stop sending to it.',
          endpoint: null,
        };
      }
      return { ok: true, endpoint };
    },
  };
}
