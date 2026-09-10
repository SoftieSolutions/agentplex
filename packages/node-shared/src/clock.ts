/**
 * The time seam.
 *
 * Elapsed time is passed into the rules that need it rather than read inside
 * them, so that "how long since this session spoke" is a value a test can set.
 */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
