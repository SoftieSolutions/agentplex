import { beforeEach, describe, expect, it } from 'vitest';
import {
  sessionIdSchema,
  startIdSchema,
  storeIdSchema,
  type SessionRef,
} from '@agentplex/protocol';
import { createLogger, type LogRecord } from '@agentplex/node-shared';
import { createFakeTimers, type FakeTimers } from '@agentplex/node-shared/testing';
import { createStartNaming, START_NAMING_TTL_MS, type StartNaming } from './start-naming.js';

/**
 * The two halves of a spawn's naming, held until they meet or their deadline
 * passes.
 *
 * Every case ends by asking how many timers are still armed, because the
 * point of the helper is that nothing it holds outlives its deadline and
 * nothing that has been paired keeps one.
 */

const WORK = storeIdSchema.parse('store-work');
const ATTIC = storeIdSchema.parse('store-attic');
const START = startIdSchema.parse('start-1');
const SPAWNED = sessionIdSchema.parse('session-migrate-db');
const REF: SessionRef = { storeId: WORK, sessionId: SPAWNED };

const MISMATCH = 'a start was reported under a store it was not made for';

let timers: FakeTimers;
let records: LogRecord[];
let naming: StartNaming;

function warns(): readonly { message: string; fields: unknown }[] {
  return records
    .filter((record) => record.level === 'warn')
    .map((record) => ({ message: record.message, fields: record.fields }));
}

describe('the start naming', () => {
  beforeEach(() => {
    timers = createFakeTimers();
    records = [];
    naming = createStartNaming({
      timers,
      logger: createLogger('debug', (record) => void records.push(record)),
    });
  });

  describe('a naming that arrives before anybody asks', () => {
    it('is held for the start, once, and costs no timer once claimed', async () => {
      await naming.named(WORK, [{ startId: START, sessionId: SPAWNED }]);
      expect(timers.delays).toEqual([START_NAMING_TTL_MS]);

      expect(naming.claim(START, WORK)).toEqual(REF);
      expect(naming.claim(START, WORK)).toBeNull();
      expect(timers.pending).toBe(0);
    });

    it('is dropped at its deadline when nobody claims it', async () => {
      await naming.named(WORK, [{ startId: START, sessionId: SPAWNED }]);
      timers.fireAll();

      expect(naming.claim(START, WORK)).toBeNull();
      expect(timers.pending).toBe(0);
    });

    it('keeps one deadline however many times the same naming is reported', async () => {
      // A server reports the tag again on a later scan until the hub has the
      // pair: a second report must not arm a second timer.
      await naming.named(WORK, [{ startId: START, sessionId: SPAWNED }]);
      await naming.named(WORK, [{ startId: START, sessionId: SPAWNED }]);
      expect(timers.pending).toBe(1);

      timers.fireAll();
      expect(naming.claim(START, WORK)).toBeNull();
      expect(timers.pending).toBe(0);
    });

    it('is refused to a start made for another store, with the warn, and not kept', async () => {
      await naming.named(ATTIC, [{ startId: START, sessionId: SPAWNED }]);

      expect(naming.claim(START, WORK)).toBeNull();
      expect(warns()).toEqual([
        { message: MISMATCH, fields: { startId: START, asked: WORK, reported: ATTIC } },
      ]);
      expect(timers.pending).toBe(0);
      expect(naming.claim(START, ATTIC)).toBeNull();
    });

    it('ignores a tag with no session yet', async () => {
      await naming.named(WORK, [{ startId: START, sessionId: null }]);
      expect(timers.pending).toBe(0);
      expect(naming.claim(START, WORK)).toBeNull();
    });
  });

  describe('a start that asks before it is named', () => {
    it('is called back once with the session, and the naming is not held after', async () => {
      const heard: (SessionRef | null)[] = [];
      naming.expect(START, WORK, (ref) => void heard.push(ref));
      expect(timers.delays).toEqual([START_NAMING_TTL_MS]);

      await naming.named(WORK, [{ startId: START, sessionId: SPAWNED }]);
      expect(heard).toEqual([REF]);
      expect(timers.pending).toBe(0);

      // Neither a second report nor a claim reaches it again.
      expect(naming.claim(START, WORK)).toBeNull();
      await naming.named(WORK, [{ startId: START, sessionId: SPAWNED }]);
      expect(heard).toEqual([REF]);
      expect(naming.claim(START, WORK)).toEqual(REF);
      expect(timers.pending).toBe(0);
    });

    it('is called back with null at the deadline when nobody names it, and dropped', async () => {
      const heard: (SessionRef | null)[] = [];
      naming.expect(START, WORK, (ref) => void heard.push(ref));

      timers.fireAll();
      expect(heard).toEqual([null]);

      await naming.named(WORK, [{ startId: START, sessionId: SPAWNED }]);
      expect(heard).toEqual([null]);
      expect(naming.claim(START, WORK)).toEqual(REF);
      expect(timers.pending).toBe(0);
    });

    it('is not called back for a naming under another store, which it keeps waiting past', async () => {
      const heard: (SessionRef | null)[] = [];
      naming.expect(START, WORK, (ref) => void heard.push(ref));

      await naming.named(ATTIC, [{ startId: START, sessionId: SPAWNED }]);
      expect(heard).toEqual([]);
      expect(warns()).toEqual([
        { message: MISMATCH, fields: { startId: START, asked: WORK, reported: ATTIC } },
      ]);
      // The refused naming is not held for anybody else either.
      expect(timers.pending).toBe(1);

      timers.fireAll();
      expect(heard).toEqual([null]);
      expect(timers.pending).toBe(0);
    });

    it('stops waiting when its disposer is called, and hears nothing after', async () => {
      const heard: (SessionRef | null)[] = [];
      const dispose = naming.expect(START, WORK, (ref) => void heard.push(ref));

      dispose();
      expect(timers.pending).toBe(0);

      timers.fireAll();
      await naming.named(WORK, [{ startId: START, sessionId: SPAWNED }]);
      expect(heard).toEqual([]);
      // The naming nobody waits for any more is held like any other.
      expect(timers.pending).toBe(1);
      dispose();
      expect(timers.pending).toBe(1);
    });

    it('may dispose of itself from inside its own callback', async () => {
      // The executor's finish runs the disposer as it settles, which is the
      // callback this helper is in the middle of calling.
      const heard: (SessionRef | null)[] = [];
      const dispose: () => void = naming.expect(START, WORK, (ref) => {
        heard.push(ref);
        dispose();
      });

      await naming.named(WORK, [{ startId: START, sessionId: SPAWNED }]);
      expect(heard).toEqual([REF]);
      expect(timers.pending).toBe(0);
    });

    it('lets named be awaited until every callback it made has settled', async () => {
      const order: string[] = [];
      naming.expect(START, WORK, async () => {
        await Promise.resolve();
        order.push('written');
      });

      await naming.named(WORK, [{ startId: START, sessionId: SPAWNED }]);
      order.push('returned');
      expect(order).toEqual(['written', 'returned']);
    });
  });

  it('takes its deadline from the caller when one is given', () => {
    const own = createStartNaming({
      timers,
      logger: createLogger('error', () => {}),
      ttlMs: 30_000,
    });
    own.expect(START, WORK, () => {});
    expect(timers.delays).toEqual([30_000]);
  });
});
