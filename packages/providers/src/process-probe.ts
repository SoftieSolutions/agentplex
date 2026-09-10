/**
 * The process seam: is this pid alive, and when did it start.
 *
 * Both questions, because neither answers alone. A provider's registry names a
 * pid and is never cleaned up, so entries outlive their processes by weeks;
 * pids recycle, so a live pid is not the process the entry meant. Only "alive
 * *and* started no later than the entry claims" is evidence, and that needs a
 * start time as well as a signal.
 *
 * Two methods rather than one call returning both, and the order they are used
 * in is load-bearing. Liveness is asked first and dating second, so a process
 * that exits between the two makes `startedAt` return `null` — unverifiable,
 * which the caller reads as "do not claim". The race can only cost a claim,
 * never manufacture one, which is the direction a race in this code has to run.
 *
 * `startedAt` returning `null` is a real answer and not a failure: it means
 * this platform will not date its processes. A caller must then fall back to
 * whatever it can prove without a date, because an undatable pid is exactly the
 * pid a recycled one is indistinguishable from.
 */
export interface ProcessProbe {
  /** Whether any process currently holds this pid. Says nothing about which. */
  isAlive(pid: number): Promise<boolean>;
  /**
   * Epoch ms at which the process now holding this pid began, or `null` if it
   * is gone or this platform cannot say.
   */
  startedAt(pid: number): Promise<number | null>;
}
