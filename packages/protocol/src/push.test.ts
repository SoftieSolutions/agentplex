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

describe('the addresses an endpoint may not be pointed at', () => {
  /** Refused, by family, each in every spelling a URL parser folds into one. */
  const refusedByFamily: Readonly<Record<string, readonly string[]>> = {
    'IPv4 loopback': [
      'https://127.0.0.1/send/x',
      // The same address in two spellings a URL parser normalises: a rule
      // reading the text rather than the parsed host would miss both.
      'https://127.1/send/x',
      'https://0x7f.1/send/x',
    ],
    'IPv4 private': [
      'https://10.0.0.5/send/x',
      'https://172.16.0.1/send/x',
      'https://172.31.255.255/send/x',
      'https://192.168.1.10/send/x',
    ],
    // 169.254.169.254 is the cloud metadata address, which is most of the
    // reason this rule is here rather than in a comment saying it would be nice.
    'IPv4 link-local': ['https://169.254.169.254/send/x', 'https://169.254.0.1/send/x'],
    'IPv4 unspecified': ['https://0.0.0.0/send/x', 'https://0.1.2.3/send/x'],
    'IPv6 loopback': ['https://[::1]/send/x'],
    'IPv6 unspecified': ['https://[::]/send/x'],
    'IPv6 unique local': ['https://[fc00::1]/send/x', 'https://[fd12:3456:789a::1]/send/x'],
    'IPv6 link-local': ['https://[fe80::1]/send/x', 'https://[FE80::dead:beef]/send/x'],
    'IPv4 mapped into IPv6': [
      'https://[::ffff:127.0.0.1]/send/x',
      'https://[::ffff:10.0.0.1]/send/x',
      // The last one again, in the hex a URL renders it back as.
      'https://[::ffff:a00:1]/send/x',
    ],
  };

  for (const [family, endpoints] of Object.entries(refusedByFamily)) {
    it(`refuses a ${family} literal`, () => {
      for (const endpoint of endpoints) {
        expect(pushEndpointSchema.safeParse(endpoint).success).toBe(false);
      }
    });
  }

  it('takes a public literal, of either family', () => {
    expect(pushEndpointSchema.safeParse('https://93.184.216.34/send/x').success).toBe(true);
    expect(pushEndpointSchema.safeParse('https://[2606:4700::1111]/send/x').success).toBe(true);
    // One octet past the private block, so what is refused is the documented
    // range rather than "anything beginning 172".
    expect(pushEndpointSchema.safeParse('https://172.32.0.1/send/x').success).toBe(true);
  });

  it('does not judge a hostname, and does not pretend to', () => {
    // A name is resolved by somebody else at send time and can resolve
    // somewhere else then. See the rule's comment for why refusing one here
    // would read as a defence without being one.
    expect(pushEndpointSchema.safeParse('https://push.example/send/x').success).toBe(true);
    expect(pushEndpointSchema.parse(ENDPOINT)).toBe(ENDPOINT);
  });

  it('says what it refused, because somebody reads the refusal', () => {
    const refused = pushEndpointSchema.safeParse('https://169.254.169.254/send/x');
    expect(refused.success).toBe(false);
    if (refused.success) return;
    expect(refused.error.message).toContain('169.254.169.254');
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
