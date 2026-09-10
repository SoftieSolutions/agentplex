/**
 * How long to wait before dialling a server again.
 *
 * Separated from the supervisor that uses it because it is arithmetic with no
 * sockets in it, and because the two questions it answers are worth being able
 * to change independently: how fast a server that blipped comes back, and how
 * hard the hub leans on a server that is genuinely down.
 */
export interface BackoffPolicy {
  /**
   * The wait before retry number `attempt`, where 1 is the first retry after
   * the first failure. Anything below 1 is treated as the first: an attempt
   * count is a count, and a caller that has miscounted should get the shortest
   * legal wait rather than a delay derived from a negative exponent.
   */
  delayMs(attempt: number): number;
}

export interface ExponentialBackoffOptions {
  /** The first wait, and the unit everything after it doubles from. */
  readonly baseMs?: number;
  /**
   * The longest wait, however long the server has been down.
   *
   * A cap rather than unbounded growth, because the failure this has to
   * recover from is a laptop that was shut on Friday: unbounded doubling means
   * opening it on Monday is not enough, and somebody has to restart the hub to
   * make it notice. A minute is short enough that reconnection feels automatic
   * and long enough that a dead machine costs nothing.
   */
  readonly maxMs?: number;
  /**
   * The fraction of the wait that jitter may remove, in [0, 1).
   *
   * Subtracted rather than added, so the cap stays a cap. Jitter exists for
   * one failure mode: a hub with a dozen paired servers loses the network for
   * thirty seconds, every connection drops in the same second, and without it
   * all twelve retry in the same millisecond forever after.
   */
  readonly jitterRatio?: number;
  /** `Math.random` in the build. Injected so a test can pin the schedule. */
  readonly random?: () => number;
}

const DEFAULT_BASE_MS = 500;
const DEFAULT_MAX_MS = 60_000;
const DEFAULT_JITTER_RATIO = 0.25;

export function createExponentialBackoff(options: ExponentialBackoffOptions = {}): BackoffPolicy {
  const baseMs = options.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS;
  const jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
  const random = options.random ?? Math.random;

  return {
    delayMs(attempt: number): number {
      const step = Math.max(1, Math.floor(attempt)) - 1;
      // `Math.min` first, so an attempt count large enough to make the power
      // `Infinity` is capped rather than carried into the arithmetic below --
      // an `Infinity` that reached `setTimeout` fires immediately, which is
      // the busy loop the cap is here to prevent.
      const ceiling = Math.min(maxMs, baseMs * 2 ** step);
      const jitter = ceiling * jitterRatio * random();
      // At least a millisecond: `random` is exclusive of 1 so the jitter can
      // never be the whole ceiling, but rounding could still land on zero for
      // a very small base, and a zero-delay retry is a dial loop.
      return Math.max(1, Math.round(ceiling - jitter));
    },
  };
}
