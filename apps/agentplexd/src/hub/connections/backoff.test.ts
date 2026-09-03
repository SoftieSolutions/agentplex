import { describe, expect, it } from 'vitest';
import { createExponentialBackoff } from './backoff.js';

/**
 * The retry schedule, on its own.
 *
 * It is a pure function of an attempt number and a source of randomness, which
 * is exactly why it is not written inline in the supervisor: a schedule that
 * can only be observed by watching a socket get dialled is one nobody checks
 * the arithmetic of.
 */

/** Jitter that takes nothing off, so the ceiling itself is what comes back. */
const noJitter = (): number => 0;
/** Jitter at its limit: `Math.random` never returns 1, so this is the worst case. */
const almostOne = (): number => 0.999_999;

describe('createExponentialBackoff', () => {
  it('doubles each attempt, from the base', () => {
    const backoff = createExponentialBackoff({ baseMs: 500, maxMs: 60_000, random: noJitter });

    const delays = [1, 2, 3, 4, 5].map((attempt) => backoff.delayMs(attempt));

    expect(delays).toEqual([500, 1000, 2000, 4000, 8000]);
  });

  it('stops doubling at the cap, however long the server stays down', () => {
    // The point of a cap: a laptop that has been shut for a week is retried
    // every minute, not every eleven hours, so opening it is enough to bring
    // it back rather than something the operator has to prod the hub about.
    const backoff = createExponentialBackoff({ baseMs: 500, maxMs: 4000, random: noJitter });

    const delays = [1, 4, 5, 20, 400].map((attempt) => backoff.delayMs(attempt));

    expect(delays).toEqual([500, 4000, 4000, 4000, 4000]);
  });

  it('does not overflow into nonsense on an attempt count that has been running for days', () => {
    // 2 ** 2000 is Infinity, and an Infinity that reached `setTimeout` is a
    // timer that fires immediately -- the busy loop the cap exists to prevent.
    const backoff = createExponentialBackoff({ baseMs: 500, maxMs: 60_000, random: noJitter });

    expect(backoff.delayMs(2000)).toBe(60_000);
  });

  it('subtracts jitter from the ceiling and never adds to it', () => {
    // Jitter is there so that a fleet of servers dropped by one network blip
    // does not come back in lockstep and dial the same instant forever.
    const backoff = createExponentialBackoff({
      baseMs: 1000,
      maxMs: 60_000,
      jitterRatio: 0.25,
      random: almostOne,
    });

    const delay = backoff.delayMs(1);

    expect(delay).toBeGreaterThanOrEqual(750);
    expect(delay).toBeLessThanOrEqual(1000);
  });

  it('never schedules a retry at zero, whatever the jitter says', () => {
    // A zero delay is a dial loop that pins a core and hammers a machine that
    // is already having a bad day. The jitter takes a fraction off; it can
    // never take the whole thing.
    const backoff = createExponentialBackoff({ baseMs: 1, maxMs: 60_000, random: almostOne });

    expect(backoff.delayMs(1)).toBeGreaterThan(0);
  });

  it('treats a first attempt and a nonsensical one alike, rather than inventing a delay', () => {
    const backoff = createExponentialBackoff({ baseMs: 500, maxMs: 60_000, random: noJitter });

    expect(backoff.delayMs(0)).toBe(500);
    expect(backoff.delayMs(-3)).toBe(500);
  });

  it('answers in whole milliseconds, because that is what a timer takes', () => {
    const backoff = createExponentialBackoff({
      baseMs: 1000,
      maxMs: 60_000,
      jitterRatio: 0.3,
      random: () => 0.123_456_789,
    });

    const delay = backoff.delayMs(3);

    expect(Number.isInteger(delay)).toBe(true);
  });
});
