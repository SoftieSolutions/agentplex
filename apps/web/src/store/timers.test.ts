import { describe, expect, it } from 'vitest';
import { createFakeTimers } from './timers.js';

describe('createFakeTimers', () => {
  it('keeps every delay in delayHistory, fired or cancelled, in scheduling order', () => {
    const timers = createFakeTimers();
    timers.schedule(100, () => undefined);
    const cancel = timers.schedule(200, () => undefined);
    cancel();
    timers.fireAll();
    timers.schedule(400, () => undefined);

    expect(timers.delayHistory).toEqual([100, 200, 400]);
  });

  it('counts in pending only what has neither fired nor been cancelled', () => {
    const timers = createFakeTimers();
    const fired: number[] = [];
    timers.schedule(100, () => fired.push(100));
    const cancel = timers.schedule(200, () => fired.push(200));
    expect(timers.pending).toBe(2);

    cancel();
    expect(timers.pending).toBe(1);

    timers.fireAll();
    expect(fired).toEqual([100]);
    expect(timers.pending).toBe(0);

    timers.schedule(400, () => fired.push(400));
    expect(timers.pending).toBe(1);
  });
});
