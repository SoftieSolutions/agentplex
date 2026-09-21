import { z } from 'zod';
import {
  assertNever,
  type Provider,
  type SessionId,
  type SessionStatus,
  type StoreId,
} from '@agentplex/protocol';
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
 * This file is storage, identity and the fan-out: the two durable facts a send
 * needs -- which hub is speaking, and to whom -- and the one loop that uses
 * them. What is still ahead of it is the frames, the service worker and the
 * control that turns it on.
 *
 * What is deliberately not here is *when*. That is `attention-edge.ts`, which
 * watches the fleet state and decides that a session has newly started wanting
 * a human. The split is the useful one: a rule about edges is testable against
 * a reducer with no database under it, and a rule about fan-out is testable
 * against a database with no reducer.
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
 * line and in no frame, and that is the reason the sending lives inside this
 * feature rather than beside it: a getter for it would be a getter somebody
 * uses, and a private key that has been read out is one that has to be rotated
 * -- which, as above, cannot be done without silencing every browser at once.
 * The injected sender is handed the pair as an argument at the moment it
 * signs, which is a narrower thing than a key anybody may ask for.
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

/**
 * One thing worth waking somebody up for.
 *
 * Four fields, and the absence of the rest is the design. A descriptor carries
 * a title, a working directory and a branch; a notification arrives on a lock
 * screen, in a hotel lobby, over somebody's shoulder. So what a session is
 * called, where it is and what it is on never reach this type, and cannot then
 * reach a payload by somebody adding a line to a template. The ids are here
 * because the service worker needs somewhere to send the tap, and they say
 * nothing to anybody who does not already have this hub's token.
 *
 * `status` rather than a rendered sentence, because the words belong beside
 * the vocabulary they come from, and because a status is what a client would
 * have to re-derive if this ever needed to say anything else about it.
 */
export interface PushEvent {
  readonly storeId: StoreId;
  readonly sessionId: SessionId;
  readonly provider: Provider;
  readonly status: SessionStatus;
}

/** The pair, as the one thing allowed to hold it briefly: a sender, mid-send. */
export interface VapidCredentials {
  readonly publicKey: string;
  readonly privateKey: string;
}

/** Everything one POST to one push service needs. */
export interface PushDelivery {
  readonly subscription: PushSubscription;
  /** The notification, already JSON and already bounded by what may be in it. */
  readonly payload: string;
  /**
   * Who the hub is signing as.
   *
   * Handed to the sender per send rather than read off this feature, which is
   * the distinction the whole no-getter rule turns on: the private half is on
   * no interface and in no log line, and the one function that has to sign
   * with it receives it as an argument at the moment it signs. A `privateKey()`
   * on `Push` would be a key somebody eventually reads for a second purpose.
   */
  readonly vapid: VapidCredentials;
}

/**
 * What became of one push.
 *
 * Three answers and not a thrown error, because two of the three are ordinary
 * and the caller acts differently on each. `gone` is the push service saying
 * this browser is never coming back -- a cleared site, an uninstalled app, an
 * expired registration -- and it is the only outcome that changes what the hub
 * stores. `failed` is everything else: a service being rate-limited, a network
 * that was not there, a payload refused. Those are somebody else's weather and
 * the subscription survives them.
 */
export type PushOutcome =
  | { readonly kind: 'delivered' }
  | { readonly kind: 'gone' }
  | { readonly kind: 'failed'; readonly problem: string };

/**
 * The one call out of this process to a push service.
 *
 * Injected for the reason the key generator is: it is a network call into
 * another program's protocol, and the rules this feature exists to keep --
 * one push per subscription, a dead subscription forgotten, a live one never
 * dropped for somebody else's failure -- are only testable if the send is a
 * seam. The real one wraps `web-push` and is wired in at the composition root.
 */
export type PushSender = (delivery: PushDelivery) => Promise<PushOutcome>;

export interface PushDependencies {
  readonly database: Database;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly generateKeys: VapidKeyGenerator;
  readonly send: PushSender;
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
  /**
   * Tells every subscribed browser about one thing wanting a human.
   *
   * Never throws and never rejects, for the reason nothing else here does:
   * this is called from a listener on the fleet state, and a rejection on that
   * path would be push taking the state pipeline down with it.
   *
   * Deciding *when* is `attention-edge.ts`. This is only the fan-out, and it
   * is in this file rather than beside it because a send needs the private
   * half of the key pair and a delete needs the subscription table -- the two
   * things this feature exists to be the only holder of.
   */
  notify(event: PushEvent): Promise<void>;
}

/**
 * A status in the words a notification says it in.
 *
 * The original is `apps/web/src/sessions/session-list-model.ts`, which draws
 * the same words on a card. They are restated rather than imported because a
 * hub may not import an app, and they are deliberately the same words: a
 * notification that said one thing and the row behind it another would be two
 * readings of one session.
 *
 * Every status has words even though only two of them can reach a
 * notification, because an exhaustive switch is what makes a status added to
 * the protocol fail here rather than arrive on somebody's phone as `undefined`.
 */
function statusWords(status: SessionStatus): string {
  switch (status) {
    case 'working':
      return 'working';
    case 'awaiting-permission':
      return 'awaiting permission';
    case 'awaiting-input':
      return 'awaiting input';
    case 'idle':
      return 'idle';
    case 'unknown':
      return 'status unknown';
    default:
      return assertNever(status, 'session status');
  }
}

export function createPush({
  database,
  clock,
  logger: parent,
  generateKeys,
  send,
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

  /**
   * Every subscription on disk, each row parsed.
   *
   * A local rather than a call through the returned object, because the
   * fan-out reads it too and a feature reaching back through its own interface
   * is a feature that can be given a different one.
   */
  const readSubscriptions = async (): Promise<readonly PushSubscription[]> => {
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
  };

  const forget = async (endpoint: PushEndpoint): Promise<void> => {
    await database.query('DELETE FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
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
      await forget(endpoint);
      logger.info('a push subscription was removed');
    },

    subscriptions: readSubscriptions,

    async notify(event: PushEvent): Promise<void> {
      // Held in a local first: this is the one place the private half is read,
      // and reading it once means the checks below and the sends after them
      // are about one pair rather than about whatever `load` has since done.
      const vapid = keys;
      // Both of these are ordinary states rather than problems, and neither
      // logs. A hub with no key pair said so once at load; a hub nobody has
      // subscribed to is every hub before the first browser asks. A line per
      // change on either would be a log that scrolls a busy fleet's real
      // events off the screen, for a fact that never varies between restarts.
      if (vapid === null) return;
      const held = await readSubscriptions();
      if (held.length === 0) return;

      // Built once for the fan-out, because it is the same notification to
      // everybody: there is one client token and no user identity, so every
      // browser that subscribed gets every edge.
      const payload = JSON.stringify({
        title: event.provider,
        body: statusWords(event.status),
        // The ids and nothing else, so the service worker has somewhere to
        // send the tap. They name a session to whoever already holds this
        // hub's token and nothing to anybody else.
        data: { storeId: event.storeId, sessionId: event.sessionId },
      });

      for (const subscription of held) {
        let outcome: PushOutcome;
        try {
          outcome = await send({ subscription, payload, vapid });
        } catch (error) {
          // A sender is somebody else's network. It is contracted to answer
          // rather than throw, and this is here because a contract is not a
          // guarantee: one that throws costs its own subscription and the rest
          // of the fan-out carries on.
          logger.warn('a push sender threw instead of answering', {
            problem: error instanceof Error ? error.message : String(error),
          });
          continue;
        }

        switch (outcome.kind) {
          case 'delivered':
            break;
          case 'gone':
            // The push service says this browser is never coming back. Keeping
            // the row would be a hub that pushes to nothing for ever and a
            // subscription list nobody can read as a count of who is listening.
            await forget(subscription.endpoint);
            logger.info('a push subscription has gone and was forgotten');
            break;
          case 'failed':
            // Everything else is weather: a rate limit, a service that was
            // down, a request refused. The subscription survives it, because
            // dropping a live browser over somebody else's bad minute is the
            // failure that cannot be noticed from here.
            logger.warn('a push could not be delivered', { problem: outcome.problem });
            break;
          default:
            assertNever(outcome, 'push outcome');
        }
      }
    },
  };
}
