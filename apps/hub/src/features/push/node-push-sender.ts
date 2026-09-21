import webPush from 'web-push';
import { z } from 'zod';
import type { PushOutcome, PushSender } from './push.js';

/**
 * The real push sender: a wrapper over `web-push`, and nothing else.
 *
 * Beside the feature rather than inside it, for the reason the key generator
 * is: the rules this feature keeps -- one push per subscription, a dead
 * subscription forgotten, a live one never dropped for somebody else's bad
 * minute -- are only testable if the network call is a seam, and the one place
 * this application POSTs to a push service should be a file small enough to
 * read in one go. The composition root injects it.
 *
 * `import webPush from 'web-push'` and not a named import: the package is
 * CommonJS, its exports are an object assignment, and Node refuses
 * `import { sendNotification }` from an ES module. The same note is on
 * `node-vapid-keys.ts`, which found it out.
 */

/**
 * Who a push service would contact about these pushes.
 *
 * VAPID requires a `sub`, and every agentplex hub is somebody's own machine:
 * there is no address, no operator inbox and nothing to ask the person setting
 * one up for. `.invalid` is reserved by RFC 2606 precisely so that a domain
 * can be written down and be guaranteed not to resolve, which says "there is
 * no contact here" rather than naming a mailbox that will never be read. A
 * real-looking address would be worse than this one: it would be a claim.
 */
const VAPID_SUBJECT = 'mailto:hub@agentplex.invalid';

/**
 * The one field this code reads off a rejection, treated as the claim it is.
 *
 * `web-push` rejects with a `WebPushError` carrying the status the service
 * answered with, but what actually arrives here is whatever that library threw
 * on the day -- including a plain socket error from under it. So the status is
 * parsed rather than reached for, and its absence is an ordinary answer.
 */
const statusCarrierSchema = z.object({ statusCode: z.int() });

/**
 * A rejected send, read as one of the three answers the feature acts on.
 *
 * 404 and 410 are the push service saying this subscription is dead: the site
 * was cleared, the app uninstalled, the registration expired. They are the
 * only two that change what the hub stores. Everything else -- a rate limit, a
 * service having a bad minute, a network that was not there -- leaves the
 * subscription exactly where it was.
 *
 * What it says never carries the endpoint. The endpoint is the capability to
 * push to that browser, which is why the feature treats it as an identity and
 * not a label, and a log line is the easiest place for a capability to end up
 * somewhere it is not protected.
 */
export function outcomeForSendFailure(error: unknown): PushOutcome {
  const carrier = statusCarrierSchema.safeParse(error);
  if (carrier.success) {
    const status = carrier.data.statusCode;
    if (status === 404 || status === 410) return { kind: 'gone' };
    return { kind: 'failed', problem: `the push service answered ${status}` };
  }
  return { kind: 'failed', problem: error instanceof Error ? error.message : String(error) };
}

export const nodePushSender: PushSender = async ({ subscription, payload, vapid }) => {
  try {
    await webPush.sendNotification({ ...subscription }, payload, {
      vapidDetails: {
        subject: VAPID_SUBJECT,
        publicKey: vapid.publicKey,
        privateKey: vapid.privateKey,
      },
    });
    return { kind: 'delivered' };
  } catch (error) {
    return outcomeForSendFailure(error);
  }
};
