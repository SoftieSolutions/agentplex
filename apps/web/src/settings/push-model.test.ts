import { describe, expect, it } from 'vitest';
import type { FrameId } from '@agentplex/protocol';
import type { RefusalView } from '../store/hub-store.js';
import {
  applicationServerKey,
  pushControlView,
  pushFollowUp,
  PUSH_SHARING_WORDS,
  type PushControlInput,
} from './push-model.js';

/**
 * The control's two pure halves: the key conversion the browser demands, and
 * the states the control can be in.
 *
 * Both are here rather than inside the component because both are decisions
 * with more than one wrong answer -- a key the browser silently refuses, a
 * button offered to somebody who has blocked notifications -- and a decision
 * asserted through a rendered DOM is a decision asserted once, in whatever
 * combination that test happened to mount.
 */

/** The hub's own VAPID public half, as the capture carries it. */
const HUB_KEY =
  'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM';

function input(overrides: Partial<PushControlInput> = {}): PushControlInput {
  return {
    supported: true,
    permission: 'default',
    subscribed: false,
    hubKey: HUB_KEY,
    waiting: false,
    refused: false,
    ...overrides,
  };
}

describe('the application server key', () => {
  it('is the byte form of the base64url the hub sent', () => {
    const key = applicationServerKey(HUB_KEY);

    // An uncompressed P-256 point: 65 bytes behind the 0x04 that says so.
    // What `PushManager.subscribe` wants is these bytes and not the text.
    expect(key).not.toBeNull();
    expect(key?.length).toBe(65);
    expect(key?.[0]).toBe(4);
  });

  it('reads the two characters base64url spells differently', () => {
    // `-` and `_` stand where `+` and `/` do. A conversion that forgot them
    // would decode most keys and mangle the ones that happen to contain a
    // byte over 0xfb, which is the sort of bug that shows up in one browser
    // on one hub and nowhere in a test suite.
    expect([...(applicationServerKey('-_8A') ?? [])]).toEqual([251, 255, 0]);
  });

  it('refuses text that is not a key rather than handing the browser rubbish', () => {
    expect(applicationServerKey('not a key!!')).toBeNull();
    expect(applicationServerKey('')).toBeNull();
  });
});

describe('what the push control says', () => {
  it('says nothing at all where the browser has no push', () => {
    // The ticket's own words: degrade silently. A browser without the Push
    // API cannot be talked into having it, so a sentence about it would be a
    // sentence with nothing behind it on every page load.
    expect(pushControlView(input({ supported: false }))).toEqual({ kind: 'silent' });
  });

  it('says in words that this hub cannot push, rather than offering a button', () => {
    const view = pushControlView(input({ hubKey: null }));

    expect(view.kind).toBe('words');
    expect(view.kind === 'words' ? view.words : '').toContain('not available from this hub');
  });

  it('offers one button where the browser and the hub can both do it', () => {
    const view = pushControlView(input());

    expect(view).toMatchObject({ kind: 'offer', action: 'subscribe', busy: false });
  });

  it('offers to turn it off where this browser is already subscribed', () => {
    const view = pushControlView(input({ permission: 'granted', subscribed: true }));

    expect(view).toMatchObject({ kind: 'offer', action: 'unsubscribe' });
    expect(view.kind === 'offer' ? view.label : '').toBe('Turn off');
  });

  it('still offers the way out of a subscription a hub has stopped being able to use', () => {
    // A hub that lost its key pair is a hub that will not push; the browser
    // still holds a subscription, and the person who wants it gone is the
    // one who would otherwise be left with a button that is not there.
    const view = pushControlView(input({ permission: 'granted', subscribed: true, hubKey: null }));

    expect(view).toMatchObject({ kind: 'offer', action: 'unsubscribe' });
  });

  it('names the browser as what has to change once notifications are blocked', () => {
    const view = pushControlView(input({ permission: 'denied' }));

    expect(view.kind).toBe('words');
    const words = view.kind === 'words' ? view.words : '';
    expect(words).toContain('site settings');
    // No button: the browser answers a second `requestPermission` with the
    // same "denied" and shows the person nothing, so a button here would be
    // one that does nothing whenever it is pressed.
    expect(words).toContain('blocked');
  });

  it('does not say a subscription the hub refused is one anybody is told through', () => {
    // The browser holds one; nothing will be sent to it. The button still
    // says Turn off, because dropping it is the one thing that still works.
    const view = pushControlView(input({ permission: 'granted', subscribed: true, refused: true }));

    expect(view).toMatchObject({ kind: 'offer', action: 'unsubscribe' });
    const words = view.kind === 'offer' ? view.words : '';
    expect(words).toContain('did not record');
    expect(words).not.toContain('is told when a session needs someone');
  });

  it('marks the button busy while the hub has not answered', () => {
    expect(pushControlView(input({ waiting: true }))).toMatchObject({ kind: 'offer', busy: true });
  });

  it('says that there is one hub token and no accounts, because everybody is told', () => {
    expect(PUSH_SHARING_WORDS).toContain('one shared hub token');
    expect(PUSH_SHARING_WORDS).toContain('no user accounts');
    expect(PUSH_SHARING_WORDS).toContain('mute');
    expect(PUSH_SHARING_WORDS).toContain('acknowledge');
  });
});

describe('the follow-up to a frame this control sent', () => {
  const PENDING = 7 as FrameId;

  it('is idle while nothing is out', () => {
    expect(pushFollowUp(null, null, null)).toEqual({ kind: 'idle' });
  });

  it('waits while the answer has not arrived', () => {
    expect(pushFollowUp(PENDING, null, null)).toEqual({ kind: 'waiting' });
  });

  it('carries the hub’s own sentence when it refused', () => {
    const refusal: RefusalView = {
      replyTo: PENDING,
      code: 'refused',
      message: 'no key pair here',
      holder: null,
    };

    expect(pushFollowUp(PENDING, null, refusal)).toEqual({
      kind: 'refused',
      words: 'no key pair here',
    });
  });

  it('is done, and says which way, when the answer is the one it waited for', () => {
    expect(pushFollowUp(PENDING, { replyTo: PENDING, subscribed: true }, null)).toEqual({
      kind: 'done',
      subscribed: true,
    });
  });

  it('ignores an answer to somebody else’s frame', () => {
    const other = { replyTo: 9 as FrameId, subscribed: true };

    expect(pushFollowUp(PENDING, other, null)).toEqual({ kind: 'waiting' });
  });
});
