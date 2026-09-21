import { describe, expect, it } from 'vitest';
import {
  PUSH_ENDPOINT_MAX_CHARS,
  PUSH_KEY_MAX_CHARS,
  pushEndpointSchema,
  pushSubscriptionSchema,
} from './push.js';

/** A real browser's endpoint, as the DOM's `PushSubscription.toJSON()` gives it. */
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bHxN0-example';

/** 65 bytes of uncompressed P-256 point, base64url, as a browser sends it. */
const P256DH =
  'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';
const AUTH = 'tBHItJI5svbpez7KI4CCXg';

describe('what an endpoint is allowed to be', () => {
  it('takes an https endpoint', () => {
    expect(pushEndpointSchema.parse(ENDPOINT)).toBe(ENDPOINT);
  });

  it('refuses a plaintext endpoint, which no push service offers', () => {
    expect(pushEndpointSchema.safeParse('http://push.example/x').success).toBe(false);
  });

  it('refuses an endpoint that is not a URL at all', () => {
    expect(pushEndpointSchema.safeParse('fcm.googleapis.com/send/x').success).toBe(false);
  });

  it('refuses credentials in the endpoint, which are a secret nothing rotates', () => {
    expect(pushEndpointSchema.safeParse('https://u:p@push.example/x').success).toBe(false);
  });

  it('refuses an endpoint longer than the bound', () => {
    const tooLong = `https://push.example/${'x'.repeat(PUSH_ENDPOINT_MAX_CHARS)}`;
    expect(pushEndpointSchema.safeParse(tooLong).success).toBe(false);
  });

  it('says in words what is wrong, because somebody reads the refusal', () => {
    const refused = pushEndpointSchema.safeParse('http://push.example/x');
    expect(refused.success).toBe(false);
    if (refused.success) return;
    expect(refused.error.message).toContain('https://');
  });
});

describe('what a subscription is allowed to say', () => {
  const SUBSCRIPTION = { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } };

  it('takes what a browser produces, in the shape a browser produces it', () => {
    const parsed = pushSubscriptionSchema.safeParse(SUBSCRIPTION);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual(SUBSCRIPTION);
  });

  it('refuses a key that is not base64url', () => {
    expect(
      pushSubscriptionSchema.safeParse({
        ...SUBSCRIPTION,
        keys: { p256dh: `${P256DH}+/=`, auth: AUTH },
      }).success,
    ).toBe(false);
  });

  it('refuses an empty key, which is absence wearing a value', () => {
    expect(
      pushSubscriptionSchema.safeParse({ ...SUBSCRIPTION, keys: { p256dh: '', auth: AUTH } })
        .success,
    ).toBe(false);
  });

  it('refuses a key past the bound', () => {
    expect(
      pushSubscriptionSchema.safeParse({
        ...SUBSCRIPTION,
        keys: { p256dh: P256DH, auth: 'a'.repeat(PUSH_KEY_MAX_CHARS + 1) },
      }).success,
    ).toBe(false);
  });

  it('refuses a subscription missing half of what encrypts a payload', () => {
    expect(
      pushSubscriptionSchema.safeParse({ endpoint: ENDPOINT, keys: { p256dh: P256DH } }).success,
    ).toBe(false);
  });

  it('carries nothing but the endpoint and the two keys', () => {
    // A subscription is not a place to describe a browser. Anything else a
    // caller attaches is dropped here rather than stored and later read by
    // something that assumed the hub had checked it.
    const parsed = pushSubscriptionSchema.safeParse({
      ...SUBSCRIPTION,
      expirationTime: null,
      userAgent: 'Firefox',
      title: 'fix-auth-refresh',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual(SUBSCRIPTION);
  });
});
