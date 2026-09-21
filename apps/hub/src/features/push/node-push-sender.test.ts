import { describe, expect, it } from 'vitest';
import {
  PUSH_SEND_TIMEOUT_MS,
  outcomeForSendFailure,
  pushRequestOptions,
} from './node-push-sender.js';

/**
 * What a rejection from `web-push` is read as.
 *
 * The send itself is a POST to somebody else's service and is not testable
 * here, which is exactly why the one rule in that file that is ours -- when a
 * subscription is dead rather than unlucky -- is a function of its own.
 *
 * The errors are shaped the way `WebPushError` is rather than constructed with
 * it, because what this reads is a claim off another program: a status code on
 * an object. Building the real class here would be asserting that this reads
 * the class, when what it has to survive is the object.
 */

function webPushError(statusCode: number, endpoint: string): Error {
  return Object.assign(new Error(`Received unexpected response code`), {
    statusCode,
    endpoint,
    body: 'push subscription has unsubscribed or expired.\n',
  });
}

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bHxN0-example';

describe('reading a failed send', () => {
  it('treats 404 and 410 as a browser that is never coming back', () => {
    expect(outcomeForSendFailure(webPushError(404, ENDPOINT))).toEqual({ kind: 'gone' });
    expect(outcomeForSendFailure(webPushError(410, ENDPOINT))).toEqual({ kind: 'gone' });
  });

  it('treats every other status as weather the subscription survives', () => {
    expect(outcomeForSendFailure(webPushError(429, ENDPOINT))).toEqual({
      kind: 'failed',
      problem: 'the push service answered 429',
    });
    expect(outcomeForSendFailure(webPushError(500, ENDPOINT))).toEqual({
      kind: 'failed',
      problem: 'the push service answered 500',
    });
  });

  it('never puts the endpoint in what it says, because the endpoint is the capability', () => {
    const outcome = outcomeForSendFailure(webPushError(429, ENDPOINT));
    expect(JSON.stringify(outcome)).not.toContain('dQw4w9WgXcQ');
  });

  it('reads a socket that went quiet as weather, not as a dead subscription', () => {
    // What `web-push` destroys the request with when the timeout below fires.
    // A service that accepted the POST and said nothing is having a bad
    // minute; it is not the service saying this browser is gone.
    expect(outcomeForSendFailure(new Error('Socket timeout'))).toEqual({
      kind: 'failed',
      problem: 'Socket timeout',
    });
  });

  it('reads a failure with no status at all as a failure, not as a dead subscription', () => {
    // A DNS failure, a socket hang up, a TLS handshake refused. None of them
    // is the push service saying anything about this browser, and dropping the
    // subscription over one would lose a browser that is perfectly fine.
    expect(outcomeForSendFailure(new Error('getaddrinfo ENOTFOUND push.example'))).toEqual({
      kind: 'failed',
      problem: 'getaddrinfo ENOTFOUND push.example',
    });
    expect(outcomeForSendFailure('something that is not an error at all')).toEqual({
      kind: 'failed',
      problem: 'something that is not an error at all',
    });
  });
});

describe('what one POST is bounded by', () => {
  const VAPID = { publicKey: 'public-half', privateKey: 'private-half' };

  it('gives every send a deadline, because neither the library nor Node has one', () => {
    // Without this the request has no timeout at all: `web-push` sets none and
    // `https.request` has none, so a push service that accepts a POST and
    // never answers holds that send for the life of the process.
    expect(pushRequestOptions(VAPID).timeout).toBe(PUSH_SEND_TIMEOUT_MS);
    expect(PUSH_SEND_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('signs as this hub, and carries nothing else', () => {
    // The options are where a subject or a header would be added later, so
    // what is in them is worth asserting: the pair, the subject, the deadline.
    expect(pushRequestOptions(VAPID)).toEqual({
      timeout: PUSH_SEND_TIMEOUT_MS,
      vapidDetails: {
        subject: expect.stringContaining('mailto:') as unknown as string,
        publicKey: 'public-half',
        privateKey: 'private-half',
      },
    });
  });
});
