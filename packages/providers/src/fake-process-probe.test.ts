import { describe, expect, it } from 'vitest';
import { createFakeProcessProbe } from './fake-process-probe.js';

describe('createFakeProcessProbe', () => {
  it('ends a process on cue, so a test can watch a caller notice it has gone', async () => {
    const probe = createFakeProcessProbe({ processes: { 100: 1_000 }, undatable: [200] });

    probe.exit(100);
    probe.exit(200);

    expect(await probe.isAlive(100)).toBe(false);
    expect(await probe.startedAt(100)).toBeNull();
    expect(await probe.isAlive(200)).toBe(false);
  });

  it('leaves every other process running', async () => {
    const probe = createFakeProcessProbe({ processes: { 100: 1_000, 101: 2_000 } });

    probe.exit(100);

    expect(await probe.isAlive(101)).toBe(true);
    expect(await probe.startedAt(101)).toBe(2_000);
  });
});

describe('createFakeProcessProbe.start', () => {
  it('issues a pid again to a later process, which dates as the later one', async () => {
    const probe = createFakeProcessProbe({ processes: { 100: 1_000 } });

    probe.exit(100);
    probe.start(100, 9_000);

    expect(await probe.isAlive(100)).toBe(true);
    expect(await probe.startedAt(100)).toBe(9_000);
  });
});
