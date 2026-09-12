import { cpus, loadavg, platform } from 'node:os';
import type { MachineLoad, CpuSample } from '@agentplex/protocol';
import type { Clock } from '@agentplex/node-shared';

/**
 * How much work this machine is doing, sampled when somebody asks.
 *
 * Not an operation, because nothing is spawned: the numbers are counters the
 * kernel keeps and node hands over directly. The operation registry is the
 * closed list of programs this build can start, and putting a reading that
 * starts no program into it would dilute exactly the property that makes it
 * worth having. What this shares with an operation is the shape that matters --
 * a seam a test supplies, and a reading that says no rather than guessing.
 *
 * The whole of the design is in what it refuses to do. There is no timer here.
 * `read` is called by the thing that answers a hub's ping, so a server nobody
 * is connected to samples nothing, and a server two hubs are watching samples
 * when they ask. Load is the fastest-decaying fact in the panel it feeds, and a
 * reading held from before anybody asked would be exactly the staleness the
 * panel is trying not to claim its way past.
 */

/**
 * The cumulative time one cpu has spent in each state since boot, in
 * milliseconds, which is what `os.cpus()` reports for every platform node runs
 * on.
 *
 * Counters and not rates. A rate is what this module computes, and it can only
 * compute one by differencing two of these -- which is why a single reading
 * yields no percentage at all.
 */
export interface CpuTimes {
  readonly user: number;
  readonly nice: number;
  readonly sys: number;
  readonly idle: number;
  readonly irq: number;
}

/**
 * The machine, as something a test can write down.
 *
 * Two methods rather than one reading, because they fail differently. The cpu
 * counters exist everywhere and are sometimes an empty list -- a container with
 * no cpu accounting exposed -- and the load average exists on some platforms
 * and not others. Collapsing them into one call would force one answer for two
 * independent absences.
 */
export interface MachineProbe {
  /** One entry per cpu. Empty where the platform exposes no accounting. */
  cpuTimes(): readonly CpuTimes[];
  /** The 1, 5 and 15 minute averages, or `null` where the platform keeps none. */
  loadAverage(): [number, number, number] | null;
}

/**
 * The real machine.
 *
 * `os.loadavg()` answers `[0, 0, 0]` on a platform that does not keep the
 * counter rather than failing, so the decision to report it is made on the
 * platform and never on the value: a machine that is genuinely idle answers
 * nearly the same thing, and a reader that inferred absence from zeros would
 * confuse the two in both directions. Windows is the platform node documents as
 * having none, and this server is a Linux and macOS thing besides -- so this is
 * a guard rather than a branch anybody exercises, and it is here so that the
 * value never has to be interrogated.
 */
export function createNodeMachineProbe(): MachineProbe {
  return {
    cpuTimes: () => cpus().map(({ times }) => times),

    loadAverage: () => {
      if (platform() === 'win32') return null;
      const [one, five, fifteen] = loadavg();
      // A shape check and not a value check. `os.loadavg()` is documented to
      // return three numbers, and a runtime that returned something else has
      // not answered the question that was asked.
      if (one === undefined || five === undefined || fifteen === undefined) return null;
      return [one, five, fifteen];
    },
  };
}

export interface MachineLoadReader {
  /**
   * Takes a reading now, and reports the busy share since the last one.
   *
   * `null` when this machine exposes no cpu accounting at all, which is a
   * machine that cannot answer the question rather than one that answered zero.
   */
  read(): MachineLoad | null;
}

export interface MachineLoadReaderDependencies {
  readonly probe: MachineProbe;
  /**
   * What the window is measured with.
   *
   * The wall clock rather than the counters' own total, even though dividing
   * the counter delta by the cpu count would give something close. Close is the
   * problem: it would be the span the kernel accounted for, which drifts from
   * the span that elapsed, and the number this reports is meant to be checkable
   * against the interval the hub pinged over.
   */
  readonly clock: Clock;
}

/**
 * One reading of the counters, reduced to the two numbers a rate needs.
 *
 * Held rather than published. What leaves this module is a difference between
 * two of these; the absolute counters are since-boot totals and mean nothing on
 * their own.
 */
interface CpuCounters {
  readonly at: number;
  readonly cpuCount: number;
  readonly busy: number;
  readonly total: number;
}

/**
 * The reader, which is the only thing here that holds state.
 *
 * One previous reading, and it is per server process rather than per
 * connection. So the window a hub is told about is "since this machine was last
 * asked, by anyone", which is why the window is reported rather than assumed: a
 * machine two hubs ping alternately answers each of them over half an interval,
 * and both answers are true of the span they name.
 */
export function createMachineLoadReader({
  probe,
  clock,
}: MachineLoadReaderDependencies): MachineLoadReader {
  let previous: CpuCounters | null = null;

  return {
    read(): MachineLoad | null {
      const current = countersOf(probe.cpuTimes(), clock.now());
      if (current === null) return null;

      const cpu = share(previous, current);
      previous = current;

      return { cpuCount: current.cpuCount, cpu, loadAverage: probe.loadAverage() };
    },
  };
}

function countersOf(times: readonly CpuTimes[], at: number): CpuCounters | null {
  if (times.length === 0) return null;

  let busy = 0;
  let total = 0;
  for (const time of times) {
    const all = time.user + time.nice + time.sys + time.idle + time.irq;
    busy += all - time.idle;
    total += all;
  }

  return { at, cpuCount: times.length, busy, total };
}

/**
 * The busy share between two readings, or `null` for every way of not having
 * one.
 *
 * Each guard is a case where a number could still be produced and would be a
 * lie. There is no previous reading on the first call, so there is no interval.
 * A different cpu count means the two readings are sums over different sets and
 * their difference is not a share of anything. A window that did not advance is
 * a clock that stepped or two questions inside one millisecond, and dividing by
 * it yields infinity. Counters that moved backwards are a machine whose
 * accounting was reset under us. Zero would be a plausible-looking answer to
 * all of them, and it is the one answer that says the machine is idle.
 */
function share(previous: CpuCounters | null, current: CpuCounters): CpuSample | null {
  if (previous === null || previous.cpuCount !== current.cpuCount) return null;

  const windowMs = current.at - previous.at;
  const total = current.total - previous.total;
  const busy = current.busy - previous.busy;
  if (windowMs <= 0 || total <= 0 || busy < 0 || busy > total) return null;

  // One decimal. A share read off tick counters sampled seconds apart has no
  // business claiming more precision than that, and a percentage that renders
  // as 31.400000000000002 is a number somebody will eventually round twice.
  return { percent: Math.round((busy / total) * 1000) / 10, windowMs };
}
