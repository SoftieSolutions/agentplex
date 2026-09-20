import { describe, expect, it } from 'vitest';
import { connectionView, toneForPhase } from './connection-model.js';
import { destinationHash } from './destinations.js';

/**
 * What the chrome says about the connection, and what it offers to do about
 * it.
 *
 * The words are the store's own, which is the point of the first group below:
 * this file adds no second vocabulary for a connection that is down, it asks
 * `connectionNotice` -- the sentence the session list has shown since AGX-29 --
 * and spends its own judgement on the one thing that function cannot know,
 * which is whether there is a credential to connect with at all.
 */
describe('the connection line in the chrome', () => {
  it('says connected, rather than saying nothing, once the fleet has arrived', () => {
    const view = connectionView({
      phase: 'connected',
      problem: null,
      hasState: true,
      hasToken: true,
    });

    expect(view.words).toBe('connected');
    expect(view.tone).toBe('running');
    expect(view.action).toBeNull();
  });

  it('carries the store’s own reconnect wording, stale label and all', () => {
    const view = connectionView({
      phase: 'reconnecting',
      problem: null,
      hasState: true,
      hasToken: true,
    });

    expect(view.words).toBe(
      'connection lost; reconnecting. Showing the last state received, which may be stale.',
    );
    expect(view.tone).toBe('needs-you');
  });

  it('says a failure in the words the failure arrived with', () => {
    const view = connectionView({
      phase: 'failed',
      problem: 'this client speaks protocol 21 and the hub speaks 20',
      hasState: false,
      hasToken: true,
    });

    expect(view.words).toBe('this client speaks protocol 21 and the hub speaks 20');
    expect(view.tone).toBe('blocked');
    // Nothing on the Settings screen changes which protocol either side
    // speaks, so there is no next action to name.
    expect(view.action).toBeNull();
  });

  it('keeps a protocol refusal in its own words, whatever this device has stored', () => {
    // `failed` is set in exactly two places (`hub-store.ts`): a
    // `protocol-version` refusal and a `protocol-error`. A 401 at the ticket
    // exchange is neither -- it goes through `scheduleRetry` and the phase is
    // `reconnecting`. So a token is never what is missing here, and a line
    // that named one the moment somebody cleared theirs on the settings
    // screen would be pointing at the wrong cause while hiding the hub's.
    const view = connectionView({
      phase: 'failed',
      problem: 'this hub speaks protocol 23, not 24',
      hasState: false,
      hasToken: false,
    });

    expect(view.words).toBe('this hub speaks protocol 23, not 24');
    expect(view.tone).toBe('blocked');
    expect(view.action).toBeNull();
  });

  it('names the missing token, and where it is typed, before naming the socket', () => {
    const view = connectionView({
      phase: 'reconnecting',
      problem: 'could not get a connection ticket from the hub',
      hasState: false,
      hasToken: false,
    });

    expect(view.words).toBe('no hub token on this device');
    expect(view.tone).toBe('blocked');
    expect(view.action).toEqual({ label: 'Settings', hash: destinationHash('settings') });
  });

  it('stops naming the token the moment one is stored, whatever the socket is doing', () => {
    const view = connectionView({
      phase: 'reconnecting',
      problem: 'could not get a connection ticket from the hub',
      hasState: false,
      hasToken: true,
    });

    expect(view.words).toBe('connection lost; reconnecting');
    expect(view.action).toBeNull();
  });

  it('does not claim a missing token while the connection is up', () => {
    // A token cleared in another tab is not a connection that has dropped:
    // this one holds a socket until the hub hangs up, and saying the token is
    // missing over a live connection would be the over-claim.
    const view = connectionView({
      phase: 'connected',
      problem: null,
      hasState: true,
      hasToken: false,
    });

    expect(view.words).toBe('connected');
    expect(view.action).toBeNull();
  });

  it('gives every phase a tone', () => {
    expect(toneForPhase('idle')).toBe('idle');
    expect(toneForPhase('connecting')).toBe('idle');
    expect(toneForPhase('connected')).toBe('running');
    expect(toneForPhase('reconnecting')).toBe('needs-you');
    expect(toneForPhase('failed')).toBe('blocked');
  });
});
