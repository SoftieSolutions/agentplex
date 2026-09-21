import { z } from 'zod';
import type { Clock, Logger } from '@agentplex/node-shared';
import type { Database } from '../../db/database.js';

/**
 * Web push: the hub's VAPID identity, and the browsers that asked to be told.
 *
 * ## What this feature is for
 *
 * Everything else the hub says reaches a person who is already looking at the
 * page. This is the one thing that reaches one who is not, which is why it is
 * its own feature and why the bar for what it may say is set where it is.
 *
 * This file is storage and identity only. Nothing here sends anything: the
 * trigger, the frames, the service worker and the control that turns it on are
 * the steps after this one. What it establishes first is the two durable facts
 * a send needs -- which hub is speaking, and to whom.
 *
 * ## Why the key pair lives here and not beside the hub
 *
 * A VAPID pair identifies this hub to a push service. The public half is baked
 * into every subscription a browser holds, so it is not rotatable in any useful
 * sense: a new pair silently stops every existing subscription working. It has
 * to be minted once and then survive every restart, and the hub has exactly one
 * place that survives a restart, which is its database. It writes no file at
 * runtime and has nowhere to decide a file should go -- see the migration for
 * the whole of that argument.
 *
 * The private half never leaves this closure. It is on no interface, in no log
 * line and in no frame, and that is the reason the sending in the next step
 * belongs inside this feature rather than beside it: a getter for it would be a
 * getter somebody uses, and a private key that has been read out is one that
 * has to be rotated -- which, as above, cannot be done without silencing every
 * browser at once.
 *
 * ## Why nothing here throws
 *
 * Push is the part of this product that is allowed not to work. A browser may
 * not support it, a user may refuse the permission, and a hub served over
 * plaintext cannot have it at all; the in-page attention floor works in every
 * one of those cases and is what people actually rely on. So a hub that cannot
 * mint a key pair says it has no key -- `null`, never an empty string -- and
 * carries on. The client reads that and stays on the floor instead of offering
 * a control that cannot work. Throwing here would mean a hub that will not
 * start because it cannot do the optional thing.
 *
 * That is also why an unreadable key row is left exactly where it is rather
 * than minted over. Push stops; the one copy of a pair that a half-fixed deploy
 * might still be able to use stays on disk for whoever comes to look.
 */

/**
 * The bounds a stored or wire-carried subscription is held to.
 *
 * A browser's own values sit far inside them -- an endpoint is a couple of
 * hundred characters, `p256dh` is an uncompressed P-256 point at 87 base64url
 * characters and `auth` is 16 bytes at 22. The caps are the sizes past which a
 * value is not a subscription anybody's browser produced, not the sizes today's
 * browsers happen to produce: pinning the exact lengths would refuse the first
 * push service that changes a token format, for the sake of rejecting inputs
 * the encryption already rejects.
 */
export const PUSH_ENDPOINT_MAX_CHARS = 2_048;
export const PUSH_KEY_MAX_CHARS = 256;

/**
 * One of the browser's keys: base64url, bounded, non-empty.
 *
 * These are not secrets of this hub's. They belong to that browser, they are
 * useless without the private half it kept, and their job is to encrypt a
 * payload that not even the push service relaying it can read.
 */
const pushKeySchema = z.base64url().min(1).max(PUSH_KEY_MAX_CHARS);

/**
 * `null` when the endpoint is a URL a push may be sent to; otherwise why not.
 *
 * One rule set rather than a regular expression, for the same reason a server
 * address has one: what makes an endpoint acceptable is a handful of statements
 * about a parsed URL, and each of them earns a sentence somebody can read when
 * it refuses.
 */
function endpointProblem(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'expected a URL such as https://push.example/send/abc';
  }

  // Plaintext is not a strictness we invented: the Push API is a secure-context
  // feature and no push service issues an http:// endpoint. One that arrives is
  // either a hand-edited row or somebody pointing this hub's POSTs somewhere.
  if (url.protocol !== 'https:') {
    return `expected an https:// endpoint, not the scheme ${JSON.stringify(url.protocol)}`;
  }
  if (url.hostname.length === 0) return 'expected a host';
  if (url.username.length > 0 || url.password.length > 0) {
    // A credential in the endpoint is a second secret kept where nothing
    // rotates it. The endpoint is already the capability: whoever holds it can
    // push, which is why it is treated as the identity of a subscription and
    // never as a label.
    return 'expected no credentials in the endpoint; the endpoint is itself the capability';
  }
  return null;
}

/**
 * The URL a push is POSTed to, and the identity of a subscription.
 *
 * Branded, so that nothing can be stored or removed without having come through
 * here: an endpoint arrives from a browser, over a socket or off disk, and all
 * three are claims. A bare string in `unsubscribe` would be a string somebody
 * eventually builds by hand.
 */
export const pushEndpointSchema = z
  .string()
  .trim()
  .min(1)
  .max(PUSH_ENDPOINT_MAX_CHARS)
  .superRefine((text, context) => {
    const problem = endpointProblem(text);
    if (problem !== null) context.addIssue({ code: 'custom', message: problem });
  })
  .brand<'PushEndpoint'>();

export type PushEndpoint = z.infer<typeof pushEndpointSchema>;

/**
 * One browser's subscription, in the shape the browser produces it.
 *
 * `{ endpoint, keys: { p256dh, auth } }` is what `PushSubscription.toJSON()`
 * hands over and what a sender wants, so the shape crosses this feature without
 * being taken apart and put back together twice. The columns are flat because a
 * table is flat; that is the only place the two shapes differ.
 */
export const pushSubscriptionSchema = z.object({
  endpoint: pushEndpointSchema,
  keys: z.object({ p256dh: pushKeySchema, auth: pushKeySchema }),
});

export type PushSubscription = z.infer<typeof pushSubscriptionSchema>;

/**
 * A row as it comes back off disk: a claim, and not the shape we wrote.
 *
 * SQLite hands text back as text, and this says so out loud, so a column
 * somebody widened later fails at the read rather than as a push that is
 * quietly never delivered.
 */
const storedSubscriptionSchema = z.object({
  endpoint: z.string(),
  p256dh: z.string(),
  auth: z.string(),
});

const storedKeysSchema = z.object({
  public_key: pushKeySchema,
  private_key: pushKeySchema,
});

/** The pair as it is held in memory, private half included. */
interface VapidKeyPair {
  readonly publicKey: string;
  readonly privateKey: string;
}

/**
 * Mints a VAPID key pair.
 *
 * Injected rather than imported, because generating one is a call into another
 * program's cryptography: the real implementation is a wrapper over
 * `web-push`'s `generateVAPIDKeys` and lives beside this file, wired in at the
 * composition root. What comes back is two strings and therefore a claim, so
 * this returns plain strings and the parsing happens here -- a generator that
 * handed back rubbish would be caught at the same place a corrupt row is.
 */
export type VapidKeyGenerator = () => { readonly publicKey: string; readonly privateKey: string };

export interface PushDependencies {
  readonly database: Database;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly generateKeys: VapidKeyGenerator;
}

export interface Push {
  /**
   * Reads the key pair back, minting it on the first run. Called once, at boot.
   *
   * Never throws: a hub that cannot mint one has no push and says so through
   * `publicKey`, rather than refusing to start because the optional thing is
   * unavailable.
   */
  load(): Promise<void>;
  /**
   * The public half, or `null` when this hub has none -- which is the answer
   * before `load`, and after a `load` that could not produce one.
   *
   * `null` and never an empty string: the client has to be able to tell "this
   * hub cannot push" from "this hub pushes with the empty key", and the first
   * is a real state a plain reading of the field must not be able to miss.
   */
  publicKey(): string | null;
  /**
   * Records a browser's subscription. One row per endpoint, however many times
   * the same browser sends it.
   */
  subscribe(subscription: PushSubscription): Promise<void>;
  /** Forgets one endpoint. Silent when there was nothing to forget. */
  unsubscribe(endpoint: PushEndpoint): Promise<void>;
  /** Every subscription this hub holds, each row parsed off disk. */
  subscriptions(): Promise<readonly PushSubscription[]>;
}

export function createPush({
  database,
  clock,
  logger: parent,
  generateKeys,
}: PushDependencies): Push {
  const logger = parent.child({ part: 'push' });

  /**
   * The pair, held for the life of the process so that a send does not read the
   * private half off disk on every notification. `null` until `load` has both
   * found one and been able to read it.
   */
  let keys: VapidKeyPair | null = null;

  /**
   * The stored pair, or `null` when there is none or it cannot be read.
   *
   * The two are deliberately one answer here. What the caller does about either
   * is the same -- try the mint, which cannot overwrite a row that exists -- and
   * the difference is already said in the log line.
   */
  const readStoredKeys = async (): Promise<VapidKeyPair | null> => {
    const result = await database.query('SELECT public_key, private_key FROM push_vapid_keys');
    const row = result.rows[0];
    if (row === undefined) return null;

    const parsed = storedKeysSchema.safeParse(row);
    if (!parsed.success) {
      // The message deliberately carries no value from the row: half of what is
      // in it is the thing this feature exists not to print.
      logger.warn('the stored VAPID key pair could not be read; this hub will not push');
      return null;
    }
    return { publicKey: parsed.data.public_key, privateKey: parsed.data.private_key };
  };

  return {
    async load(): Promise<void> {
      const stored = await readStoredKeys();
      if (stored !== null) {
        keys = stored;
        logger.info('VAPID key pair read back', { publicKey: stored.publicKey });
        return;
      }

      let minted: VapidKeyPair;
      try {
        const generated = generateKeys();
        // Parsed and not trusted: this is another program's output, and a
        // generator that returned an empty string would otherwise become a hub
        // that advertises the empty key.
        minted = {
          publicKey: pushKeySchema.parse(generated.publicKey),
          privateKey: pushKeySchema.parse(generated.privateKey),
        };
      } catch (error) {
        logger.warn('no VAPID key pair could be minted; this hub will not push', {
          problem: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      // `ON CONFLICT DO NOTHING` against the single-row table is what makes the
      // mint idempotent without a read-then-write race, exactly as the hub's
      // identity is minted: two starts produce one pair and the loser reads the
      // winner's. It is also what keeps the unreadable row above safe -- the
      // insert cannot overwrite it, it simply does nothing.
      await database.query(
        `INSERT INTO push_vapid_keys (public_key, private_key, created_at)
         VALUES (?, ?, ?) ON CONFLICT (only_row) DO NOTHING`,
        [minted.publicKey, minted.privateKey, clock.now()],
      );

      // Read back rather than assumed, because what is on disk may be the other
      // starter's pair, or the unreadable row that made us try in the first
      // place. Whatever is there is what every browser will be subscribed to.
      const after = await readStoredKeys();
      if (after === null) {
        logger.warn(
          'a VAPID key pair was minted but could not be read back; this hub will not push',
        );
        return;
      }
      keys = after;
      logger.info('VAPID key pair minted', { publicKey: after.publicKey });
    },

    publicKey(): string | null {
      return keys?.publicKey ?? null;
    },

    async subscribe(subscription: PushSubscription): Promise<void> {
      // The keys are updated and `created_at` is not. A browser re-subscribing
      // on an endpoint it already holds is the same subscription, so the row
      // keeps the age it had; but its keys may have been re-issued, and keeping
      // the old ones would be a subscription that is never delivered to again
      // and never noticed, because a push encrypted to a stale key fails at the
      // browser rather than at the service.
      await database.query(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
        [subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, clock.now()],
      );
      logger.info('a browser subscribed to push');
    },

    async unsubscribe(endpoint: PushEndpoint): Promise<void> {
      await database.query('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
      logger.info('a push subscription was removed');
    },

    async subscriptions(): Promise<readonly PushSubscription[]> {
      const result = await database.query(
        'SELECT endpoint, p256dh, auth FROM push_subscriptions ORDER BY created_at, endpoint',
      );
      const held: PushSubscription[] = [];
      for (const row of result.rows) {
        const stored = storedSubscriptionSchema.safeParse(row);
        if (!stored.success) {
          logger.warn('a push subscription row could not be read', {
            problem: stored.error.message,
          });
          continue;
        }
        // An unreadable row costs itself and not the listing. One bad endpoint
        // must not leave a fan-out with nobody to send to, which would be this
        // feature failing in the one direction nobody would notice: silently.
        const parsed = pushSubscriptionSchema.safeParse({
          endpoint: stored.data.endpoint,
          keys: { p256dh: stored.data.p256dh, auth: stored.data.auth },
        });
        if (!parsed.success) {
          logger.warn('a push subscription row is not something this hub may push to', {
            problem: parsed.error.message,
          });
          continue;
        }
        held.push(parsed.data);
      }
      return held;
    },
  };
}
