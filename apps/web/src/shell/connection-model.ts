import { connectionNotice } from '../sessions/session-list-model.js';
import type { ConnectionPhase } from '../store/hub-store.js';
import type { Tone } from '../ui/tokens.js';
import { destinationHash } from './destinations.js';
import type { NextAction } from './next-action.js';

/**
 * How the connection is doing, as the chrome says it.
 *
 * Pure, and in its own file, because two chromes draw it -- the top bar's slot
 * on a desk, the compact header's on a phone -- and a rule spelled twice is a
 * rule two screens can disagree about. The component is
 * `connection-status.tsx`; everything decided is here.
 *
 * The words are `connectionNotice`, which the session list has shown since the
 * list existed. Not a copy of it and not a shorter version of it: a chrome that
 * said "offline" over a screen saying "connection lost; reconnecting. Showing
 * the last state received, which may be stale." would be two claims about one
 * socket, and the longer one is the honest one -- it is what says the fleet on
 * screen is a memory.
 *
 * The one fact this file adds is whether a credential exists to connect with.
 * `connectionNotice` cannot know: the store dials with an empty Bearer when no
 * token is stored, the hub answers its ordinary 401, and the store reports
 * exactly what it saw -- a ticket exchange that refused, and a retry pending.
 * That is true and it is a dead end, because no number of retries invents a
 * token. So when there is none, this says so instead, and names the screen
 * where one is typed.
 */

/** The dot beside the words. Same vocabulary the settings screen's line uses. */
export function toneForPhase(phase: ConnectionPhase): Tone {
  switch (phase) {
    case 'connected':
      return 'running';
    case 'connecting':
    case 'idle':
      return 'idle';
    case 'reconnecting':
      return 'needs-you';
    case 'failed':
      return 'blocked';
  }
}

/** What the chrome is told, all of it read off the hub snapshot but the token. */
export interface ConnectionFacts {
  readonly phase: ConnectionPhase;
  /** The snapshot's `problem`, which is what a failure's words come from. */
  readonly problem: string | null;
  /** Whether the hub has ever answered with a fleet; the stale label turns on it. */
  readonly hasState: boolean;
  /** Whether a token is stored on this device at all. */
  readonly hasToken: boolean;
}

export interface ConnectionView {
  readonly tone: Tone;
  /** Always a sentence: the slot says "connected" rather than emptying. */
  readonly words: string;
  /** Where to go about it, or `null` when nothing on offer would help. */
  readonly action: NextAction | null;
}

export function connectionView(facts: ConnectionFacts): ConnectionView {
  // A live connection outranks a missing token: this tab holds a socket it was
  // given a ticket for, and a token cleared in another tab (or a storage this
  // browser has since started refusing) does not make the socket a lie.
  if (!facts.hasToken && facts.phase !== 'connected') {
    return {
      tone: 'blocked',
      words: 'no hub token on this device',
      action: { label: 'Settings', hash: destinationHash('settings') },
    };
  }
  return {
    tone: toneForPhase(facts.phase),
    // `connectionNotice` is silent when there is nothing to report, and this
    // slot is not: a status indicator that disappears when all is well is one
    // nobody can tell from a broken one.
    words: connectionNotice(facts.phase, facts.problem, facts.hasState) ?? 'connected',
    action: null,
  };
}
