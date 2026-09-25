import { describe, expect, it } from 'vitest';
import type { Clock } from '@agentplex/node-shared';
import { machineLoadSchema } from '@agentplex/protocol';
import { createFakeMachineProbe } from './fake-machine-probe.js';
import { createMachineLoadReader, createNodeMachineProbe, type CpuTimes } from './machine-load.js';
import * as darwin from './machine-load-darwin.fixture.js';
import * as linux from './machine-load-linux.fixture.js';

/** A clock a test winds by hand, so a window is a number the test chose. */
function fakeClock(start = 1_700_000_000_000): Clock & { advance(ms: number): void } {
  let now = start;
  return { now: () => now, advance: (ms) => void (now += ms) };
}

/** Every platform whose real counters are captured, run through the same rules. */
const PLATFORMS = [
  { name: 'darwin', fixture: darwin },
  { name: 'linux', fixture: linux },
] as const;

describe('reading a machine load', () => {
  it('has no busy share on the first reading, because there is no interval yet', () => {
    const probe = createFakeMachineProbe(darwin.before, darwin.loadAverage);
    const reader = createMachineLoadReader({ probe, clock: fakeClock() });

    const load = reader.read();

    // Not zero. Zero would say this machine is idle, and what is true is only
    // that there is nothing yet to difference against.
    expect(load).toEqual({
      cpuCount: darwin.before.length,
      cpu: null,
      loadAverage: darwin.loadAverage,
    });
  });

  it('says nothing at all on a machine that exposes no cpu accounting', () => {
    const reader = createMachineLoadReader({
      probe: createFakeMachineProbe([]),
      clock: fakeClock(),
    });

    // `null` and not a reading with `cpuCount: 0`: a machine that cannot answer
    // the question has not answered it, and the protocol says a cpu count is
    // positive for that reason.
    expect(reader.read()).toBeNull();
  });

  describe.each(PLATFORMS)('on $name', ({ fixture }) => {
    it('differences two real readings into a share of the window they span', () => {
      const probe = createFakeMachineProbe(fixture.before, fixture.loadAverage);
      const clock = fakeClock();
      const reader = createMachineLoadReader({ probe, clock });

      reader.read();
      probe.set(fixture.after);
      clock.advance(fixture.windowMs);
      const load = reader.read();

      expect(load?.cpu?.windowMs).toBe(fixture.windowMs);
      // The capture spent its whole window burning cpu, so a share of zero
      // would mean the arithmetic never looked at the counters, and a share of
      // a hundred would mean it never looked at `idle`.
      expect(load?.cpu?.percent).toBeGreaterThan(0);
      expect(load?.cpu?.percent).toBeLessThan(100);
      expect(load?.cpuCount).toBe(fixture.before.length);
    });

    it('produces a reading the protocol accepts', () => {
      const probe = createFakeMachineProbe(fixture.before, fixture.loadAverage);
      const clock = fakeClock();
      const reader = createMachineLoadReader({ probe, clock });

      reader.read();
      probe.set(fixture.after);
      clock.advance(fixture.windowMs);

      // Parsed rather than asserted field by field: this value goes on a frame,
      // and the schema is what decides whether it may.
      expect(machineLoadSchema.safeParse(reader.read()).success).toBe(true);
    });

    it('rounds the share to a tenth rather than to whatever the division gave', () => {
      const probe = createFakeMachineProbe(fixture.before, fixture.loadAverage);
      const clock = fakeClock();
      const reader = createMachineLoadReader({ probe, clock });

      reader.read();
      probe.set(fixture.after);
      clock.advance(fixture.windowMs);
      const percent = reader.read()?.cpu?.percent ?? 0;

      expect(percent).toBe(Math.round(percent * 10) / 10);
    });
  });

  it('measures the window with the clock rather than assuming the interval', () => {
    const probe = createFakeMachineProbe(linux.before, linux.loadAverage);
    const clock = fakeClock();
    const reader = createMachineLoadReader({ probe, clock });

    reader.read();
    probe.set(linux.after);
    // Deliberately not the interval the capture was taken over. The window a
    // reading reports is the interval the hub actually left between questions,
    // which is the thing a reader of the frame can check it against.
    clock.advance(9_000);

    expect(reader.read()?.cpu?.windowMs).toBe(9_000);
  });

  it('refuses a share when the window did not advance', () => {
    const probe = createFakeMachineProbe(linux.before, linux.loadAverage);
    const reader = createMachineLoadReader({ probe, clock: fakeClock() });

    reader.read();
    probe.set(linux.after);

    // Two questions inside one millisecond. There is a counter delta and no
    // time to have spent it in, and dividing by nothing is how a percentage of
    // infinity gets onto a wire.
    expect(reader.read()?.cpu).toBeNull();
  });

  it('refuses a share when the clock stepped backwards', () => {
    const probe = createFakeMachineProbe(linux.before, linux.loadAverage);
    const clock = fakeClock();
    const reader = createMachineLoadReader({ probe, clock });

    reader.read();
    probe.set(linux.after);
    clock.advance(-5_000);

    expect(reader.read()?.cpu).toBeNull();
  });

  it('refuses a share when the number of cpus changed', () => {
    const probe = createFakeMachineProbe(linux.before, linux.loadAverage);
    const clock = fakeClock();
    const reader = createMachineLoadReader({ probe, clock });

    reader.read();
    // A cpu that went away. The two totals are sums over different sets, and
    // their difference is not a share of anything.
    probe.set(linux.after.slice(1));
    clock.advance(linux.windowMs);
    const load = reader.read();

    expect(load?.cpu).toBeNull();
    expect(load?.cpuCount).toBe(linux.after.length - 1);
  });

  it('refuses a share when the counters went backwards', () => {
    const probe = createFakeMachineProbe(linux.after, linux.loadAverage);
    const clock = fakeClock();
    const reader = createMachineLoadReader({ probe, clock });

    reader.read();
    // Accounting that was reset under us. Nothing true can be said about the
    // interval, and a negative share is not a thing a percentage may be.
    probe.set(linux.before);
    clock.advance(linux.windowMs);

    expect(reader.read()?.cpu).toBeNull();
  });

  it('re-baselines after a refusal, so one bad interval costs one reading', () => {
    const probe = createFakeMachineProbe(linux.before, linux.loadAverage);
    const clock = fakeClock();
    const reader = createMachineLoadReader({ probe, clock });

    reader.read();
    probe.set(linux.after);
    // The interval that could not be measured.
    reader.read();

    const later: readonly CpuTimes[] = linux.after.map((time) => ({
      ...time,
      user: time.user + 500,
      idle: time.idle + 500,
    }));
    probe.set(later);
    clock.advance(1_000);

    // The reading that follows is differenced against the one that failed,
    // rather than against the last one that worked: a window nobody can name
    // is worse than a fresh one.
    expect(reader.read()?.cpu).toEqual({ percent: 50, windowMs: 1_000 });
  });

  it('carries the load average through untouched, including one full of zeros', () => {
    const probe = createFakeMachineProbe(linux.before, [0, 0, 0]);
    const reader = createMachineLoadReader({ probe, clock: fakeClock() });

    // An idle machine's answer, not a missing one. Whether a platform keeps the
    // counter is the probe's decision and is made on the platform, so this
    // reports what it was told rather than reading absence out of the values.
    expect(reader.read()?.loadAverage).toEqual([0, 0, 0]);
  });

  it('carries an absent load average as absent', () => {
    const probe = createFakeMachineProbe(linux.before, null);
    const reader = createMachineLoadReader({ probe, clock: fakeClock() });

    expect(reader.read()?.loadAverage).toBeNull();
  });
});

describe('the real machine', () => {
  it('reads counters this machine actually keeps', () => {
    const probe = createNodeMachineProbe();
    const times = probe.cpuTimes();

    // The integration point, and the one thing a fixture cannot prove: that
    // `os.cpus()` on the machine running this test has the shape the fixtures
    // were captured in.
    expect(times.length).toBeGreaterThan(0);
    for (const time of times) {
      expect(time.idle).toBeGreaterThan(0);
      expect(time.user + time.nice + time.sys + time.idle + time.irq).toBeGreaterThan(time.idle);
    }
  });

  it('reads a load average on the platforms that keep one', () => {
    const average = createNodeMachineProbe().loadAverage();

    // Linux and macOS both keep it; this suite does not run anywhere that does
    // not, and a null here on one of them would mean the platform check is
    // rejecting a platform that has the counter.
    expect(average).not.toBeNull();
    expect(average).toHaveLength(3);
  });

  it('reads its own load through the reader without inventing a first share', () => {
    const reader = createMachineLoadReader({
      probe: createNodeMachineProbe(),
      clock: { now: () => Date.now() },
    });

    const load = reader.read();
    expect(load).not.toBeNull();
    expect(load?.cpu).toBeNull();
    expect(machineLoadSchema.safeParse(load).success).toBe(true);
  });
});
