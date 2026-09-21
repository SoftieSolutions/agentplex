import type { FrameId } from '@agentplex/protocol';
import type { PushView, RefusalView } from '../store/hub-store.js';
import type { PushPermission } from './push-operations.js';

/**
 * Everything the push control decides, with nothing rendered.
 *
 * The control itself is a few elements over this file: what it may offer, what
 * it must say instead, and the one conversion the browser insists on. They are
 * here because each of them has a wrong answer that is invisible in a rendered
 * DOM -- a key the browser rejects for its encoding, a button shown to
 * somebody whose browser will never prompt again -- and a decision asserted
 * only through a mounted component is asserted once, in whichever combination
 * that test happened to set up.
 */

/**
 * The sentence every state of this control carries.
 *
 * It is not a caveat: it is what subscribing means here. The hub has one
 * shared token and no user identity (`config.ts`), so a subscription is not
 * "tell me" but "tell this browser, along with every other one that asked".
 * Mute and acknowledge are the same fact from the other side -- they are
 * facts about a session and not about a person -- and somebody who silences a
 * session on their laptop has silenced it for the phone in the next room.
 * Saying it once, in the control, is cheaper than the surprise.
 */
export const PUSH_SHARING_WORDS =
  'There is one shared hub token and no user accounts: every subscribed browser is told about ' +
  'every session that needs someone, and mute and acknowledge are shared too.';

/** What the control is looking at, with no browser and no store attached. */
export interface PushControlInput {
  /** Whether this browser has the Push API and notifications at all. */
  readonly supported: boolean;
  readonly permission: PushPermission;
  /** Whether this browser already holds a subscription. */
  readonly subscribed: boolean;
  /** The hub's VAPID public half, or `null` where it has none. */
  readonly hubKey: string | null;
  /** True while a frame this control sent has not been answered. */
  readonly waiting: boolean;
  /**
   * True when the hub refused the last frame this control sent.
   *
   * It exists for one state, and that state is reachable: the browser minted
   * a subscription, the hub would not record it, and this browser is now
   * holding a subscription nothing will ever send to. Saying "this browser is
   * subscribed" there would be true about the browser and a lie about what
   * anybody will be told.
   */
  readonly refused: boolean;
}

/** Turning it on, or turning it off: the button is never both. */
export type PushAction = 'subscribe' | 'unsubscribe';

export type PushControlView =
  /** Nothing is drawn. Not a heading, not a sentence. */
  | { readonly kind: 'silent' }
  /** Something true that no button here can change. */
  | { readonly kind: 'words'; readonly words: string }
  | {
      readonly kind: 'offer';
      readonly action: PushAction;
      readonly label: string;
      readonly words: string;
      readonly busy: boolean;
    };

const NO_HUB_KEY_WORDS =
  'Push is not available from this hub: it has no key pair to notify a browser with. The ' +
  'attention line in this page still works, which is the floor that works everywhere.';

const BLOCKED_WORDS =
  'This browser has blocked notifications for this site, so nothing can be sent to it. It is ' +
  'unblocked in the browser’s site settings for this page and nowhere else — asking ' +
  'again from here would show you nothing and be answered the same way.';

const STRANDED_WORDS =
  'This browser holds a subscription the hub did not record, so nothing will be sent to it. ' +
  'Turning it off drops it here; the hub’s own answer is below.';

const OFFER_WORDS =
  'Be told when a session needs someone and this page is not the one you are looking at.';

const SUBSCRIBED_WORDS =
  'This browser is subscribed. It is told when a session needs someone, and it is the browser ' +
  'and not you: another browser you use is subscribed separately or not at all.';

/**
 * Which of the four things this control is.
 *
 * The order of the branches is the argument. Unsupported comes first and
 * silently, because a browser without the API cannot be talked into having
 * one. An existing subscription comes before the hub's key, because
 * unsubscribing needs no key and the person left holding a subscription a
 * keyless hub will never use is exactly the person who wants it gone. A
 * blocked permission ends in words rather than a button: a second
 * `requestPermission` is answered "denied" without showing anybody anything,
 * so the button would be one that does nothing every time it is pressed, and
 * the thing that does work is named instead.
 */
export function pushControlView(input: PushControlInput): PushControlView {
  if (!input.supported) return { kind: 'silent' };
  if (input.subscribed) {
    return {
      kind: 'offer',
      action: 'unsubscribe',
      label: 'Turn off',
      words: input.refused ? STRANDED_WORDS : SUBSCRIBED_WORDS,
      busy: input.waiting,
    };
  }
  if (input.hubKey === null) return { kind: 'words', words: NO_HUB_KEY_WORDS };
  if (input.permission === 'denied') return { kind: 'words', words: BLOCKED_WORDS };
  return {
    kind: 'offer',
    action: 'subscribe',
    label: 'Turn on',
    words: OFFER_WORDS,
    busy: input.waiting,
  };
}

/**
 * The bytes `PushManager.subscribe` wants, or `null` when the text is not a
 * key.
 *
 * The hub sends its public half as base64url on the welcome, and the browser
 * takes an `applicationServerKey` as bytes -- Safari has never accepted the
 * string form -- so one conversion stands between them. It is a function
 * rather than three lines in a click handler because it has two ways of being
 * quietly wrong: `-` and `_` stand where `+` and `/` do, and the padding the
 * hub's encoder leaves off is padding `atob` wants back.
 *
 * A refusal is `null` and never an empty array. What reaches here has been
 * through `pushKeySchema` on the wire, so text that is not base64url is a hub
 * that is broken rather than a person who mistyped something -- and the honest
 * thing to do with it is say so, instead of handing the browser a buffer it
 * will reject with a sentence nobody can act on.
 */
export function applicationServerKey(text: string): Uint8Array<ArrayBuffer> | null {
  if (text.length === 0) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const base64 = text
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(text.length + ((4 - (text.length % 4)) % 4), '=');
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return null;
  }
  if (binary.length === 0) return null;
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export type PushFollowUp =
  | { readonly kind: 'idle' }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'refused'; readonly words: string }
  | { readonly kind: 'done'; readonly subscribed: boolean };

/**
 * What became of the frame this control sent, read off the snapshot.
 *
 * The same shape as the attention controls' follow-up, and for the same
 * reason: a command is answered by a frame that names the id it answers, and
 * the id is the only thing that tells this control's answer from the one
 * another tab is waiting for. `done` carries which way it went, because the
 * hub answers a subscribe and an unsubscribe with the same view.
 */
export function pushFollowUp(
  pending: FrameId | null,
  lastPush: PushView | null,
  lastRefusal: RefusalView | null,
): PushFollowUp {
  if (pending === null) return { kind: 'idle' };
  if (lastRefusal !== null && lastRefusal.replyTo === pending) {
    return { kind: 'refused', words: lastRefusal.message };
  }
  if (lastPush !== null && lastPush.replyTo === pending) {
    return { kind: 'done', subscribed: lastPush.subscribed };
  }
  return { kind: 'waiting' };
}
