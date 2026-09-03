/**
 * The deadline seam, browser edition.
 *
 * The same shape as the service's `Timers` (apps/agentplexd/src/shared), and
 * deliberately not imported from there: nothing crosses a package line but the
 * protocol, and an interface this small is cheaper to restate than to share.
 * It exists for the reason the service's does — a test that waits out a real
 * reconnect backoff is a test nobody runs.
 *
 * Scheduling returns its own cancel rather than a handle, so no caller ever
 * holds a platform timer id.
 */
export interface Timers {
  /** Runs `fire` after `afterMs`. The returned function cancels it; calling it twice is safe. */
  schedule(afterMs: number, fire: () => void): () => void;
}

export const browserTimers: Timers = {
  schedule(afterMs: number, fire: () => void): () => void {
    const handle = setTimeout(fire, afterMs);
    return () => clearTimeout(handle);
  },
};

/** A `Timers` a test fires by hand. Nothing happens until `fireAll` is called. */
export interface FakeTimers extends Timers {
  /** Fires everything currently scheduled, in the order it was scheduled. */
  fireAll(): void;
  readonly pending: number;
  /**
   * The delay of everything ever scheduled, in order.
   *
   * How a backoff is asserted. Firing timers proves a reconnect happened; only
   * the delays prove each wait was longer than the one before it, and a
   * backoff whose progression nothing checks is a backoff that quietly becomes
   * a busy loop.
   */
  readonly delays: readonly number[];
}

export function createFakeTimers(): FakeTimers {
  const scheduled = new Map<number, () => void>();
  const delays: number[] = [];
  let next = 0;

  return {
    schedule(afterMs: number, fire: () => void): () => void {
      const id = (next += 1);
      delays.push(afterMs);
      scheduled.set(id, fire);
      return () => void scheduled.delete(id);
    },
    fireAll(): void {
      const due = [...scheduled.values()];
      scheduled.clear();
      for (const fire of due) fire();
    },
    get pending(): number {
      return scheduled.size;
    },
    get delays(): readonly number[] {
      return [...delays];
    },
  };
}
