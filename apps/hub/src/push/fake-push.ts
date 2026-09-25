import type { PushEndpoint, PushSubscription } from '@agentplex/protocol';

/**
 * The subscription table, in memory, driven by hand.
 *
 * A real implementation of the narrow seam a client socket takes rather than a
 * mock, for the reason the fake attention is one: what a connection has to get
 * right is what it does with a yes and a throw, and both are values this hands
 * back. It keeps one row per endpoint exactly as the real one does, so a test
 * that would catch the feature storing a browser twice catches this too.
 *
 * What it does not do is a database, a key pair or a send. Those are exercised
 * where they live -- against a migrated schema, and against the real library --
 * and this is for the tests whose subject is the socket.
 *
 * It deliberately implements only the three functions `ClientPush` names. A
 * fake with a `notify` on it would be a fake a test could make buzz every
 * browser from a client connection, which is the one thing the seam exists to
 * make unreachable.
 */
export interface FakePush {
  publicKey(): string | null;
  subscribe(subscription: PushSubscription): Promise<void>;
  unsubscribe(endpoint: PushEndpoint): Promise<void>;
  /** Every subscription this fake holds, by endpoint, in the order they arrived. */
  readonly stored: readonly PushSubscription[];
  /** Makes every later write throw, for the path where the database is unhappy. */
  failWith(error: Error): void;
}

export interface FakePushOptions {
  /**
   * The public half this fake advertises, or `null` for a hub with no pair.
   *
   * A key by default, because the interesting case for most callers is a hub
   * that can push: one that cannot is asserted deliberately, by passing `null`.
   */
  readonly publicKey?: string | null;
}

/** A well-formed VAPID public half: base64url, the length a real one is. */
export const FAKE_PUSH_PUBLIC_KEY =
  'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';

export function createFakePush(options: FakePushOptions = {}): FakePush {
  const publicKey = options.publicKey === undefined ? FAKE_PUSH_PUBLIC_KEY : options.publicKey;
  const rows = new Map<string, PushSubscription>();
  let failure: Error | null = null;

  return {
    publicKey(): string | null {
      return publicKey;
    },

    async subscribe(subscription: PushSubscription): Promise<void> {
      if (failure !== null) throw failure;
      rows.set(subscription.endpoint, subscription);
    },

    async unsubscribe(endpoint: PushEndpoint): Promise<void> {
      if (failure !== null) throw failure;
      rows.delete(endpoint);
    },

    failWith(error: Error): void {
      failure = error;
    },

    get stored(): readonly PushSubscription[] {
      return [...rows.values()];
    },
  };
}
