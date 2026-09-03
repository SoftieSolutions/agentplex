/**
 * The deadline seam.
 *
 * Separate from `Clock`, which answers what time it is now. This one is about
 * something happening later, and a test that has to wait 20 real seconds for a
 * handshake deadline is a test nobody runs.
 *
 * Scheduling returns its own cancel rather than a handle, so no caller ever
 * holds a `NodeJS.Timeout` — which is what makes this the same interface in a
 * browser bundle if the client protocol ever needs one.
 */
export interface Timers {
  /** Runs `fire` after `afterMs`. The returned function cancels it; calling it twice is safe. */
  schedule(afterMs: number, fire: () => void): () => void;
}

export const systemTimers: Timers = {
  schedule(afterMs: number, fire: () => void): () => void {
    const handle = setTimeout(fire, afterMs);
    // Node keeps the process alive for a pending timer, and a handshake
    // deadline must not be the thing holding a shutdown open.
    handle.unref?.();
    return () => clearTimeout(handle);
  },
};

/** A `Timers` a test fires by hand. Nothing happens until `advance` is called. */
export interface FakeTimers extends Timers {
  /** Fires everything due at or before `afterMs` from when it was scheduled. */
  fireAll(): void;
  readonly pending: number;
  /**
   * The delays of everything currently scheduled, in the order it was
   * scheduled.
   *
   * How a retry schedule is asserted. Firing timers proves a reconnect
   * happened; only the delay proves it waited longer than the time before, and
   * a backoff whose progression nothing checks is a backoff that quietly
   * becomes a busy loop.
   */
  readonly delays: readonly number[];
}

export function createFakeTimers(): FakeTimers {
  const scheduled = new Map<number, { readonly afterMs: number; readonly fire: () => void }>();
  let next = 0;

  return {
    schedule(afterMs: number, fire: () => void): () => void {
      const id = (next += 1);
      scheduled.set(id, { afterMs, fire });
      return () => void scheduled.delete(id);
    },
    fireAll(): void {
      const due = [...scheduled.values()];
      scheduled.clear();
      for (const { fire } of due) fire();
    },
    get pending(): number {
      return scheduled.size;
    },
    get delays(): readonly number[] {
      return [...scheduled.values()].map((timer) => timer.afterMs);
    },
  };
}
