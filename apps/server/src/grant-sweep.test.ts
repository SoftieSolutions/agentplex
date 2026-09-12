import { describe, expect, it } from 'vitest';
import { createLogger, type LogRecord } from '@agentplex/node-shared';
import { createFakeTimers } from '@agentplex/node-shared/testing';
import type { GrantId, ServerGrantStore, WithdrawnGrant } from '@agentplex/providers';
import { GRANT_SWEEP_INTERVAL_MS, sweepGrants } from './grant-sweep.js';
import type { HubAudience } from './hub-audience.js';

const logger = createLogger('error', () => {});

/** An audience with the sockets taken out: what it holds, and what was closed. */
function audience(grants: readonly string[]) {
  const closed: { readonly grantId: string; readonly reason: string }[] = [];
  const live = [...grants];
  const value: HubAudience = {
    join: () => () => {},
    reportToAll: () => Promise.resolve(),
    reportTo: () => Promise.resolve(),
    disconnect(grantId, reason) {
      const held = live.filter((one) => one === grantId).length;
      if (held > 0) closed.push({ grantId, reason });
      for (let index = live.length - 1; index >= 0; index -= 1) {
        if (live[index] === grantId) live.splice(index, 1);
      }
      return held;
    },
    get grants(): readonly GrantId[] {
      return [...new Set(live)] as GrantId[];
    },
  };
  return { audience: value, closed };
}

/** A grant store that only ever answers the one question the sweep asks. */
function store(
  refused: (grantIds: readonly GrantId[]) => Promise<readonly WithdrawnGrant[]>,
): ServerGrantStore & { readonly asked: readonly (readonly GrantId[])[] } {
  const asked: (readonly GrantId[])[] = [];
  const unreachable = (): never => {
    throw new Error('the sweep reached a grant store method it has no business in');
  };
  return {
    asked,
    refused: (grantIds) => {
      asked.push(grantIds);
      return refused(grantIds);
    },
    authorize: unreachable,
    list: unreachable,
    mint: unreachable,
    revoke: unreachable,
  };
}

describe('sweepGrants', () => {
  it('closes the connections a revoked grant holds', async () => {
    const timers = createFakeTimers();
    const { audience: hubs, closed } = audience(['grant-doomed', 'grant-fine']);
    const grants = store(() =>
      Promise.resolve([{ grantId: 'grant-doomed' as GrantId, refusal: 'revoked' }]),
    );
    sweepGrants({ grants, audience: hubs, timers, logger });

    timers.fireAll();
    await Promise.resolve();
    await Promise.resolve();

    expect(closed).toEqual([{ grantId: 'grant-doomed', reason: 'this grant was revoked' }]);
    expect(hubs.grants).toEqual(['grant-fine']);
  });

  it('closes a connection whose grant has expired, and says which it was', async () => {
    const timers = createFakeTimers();
    const { audience: hubs, closed } = audience(['grant-a']);
    const grants = store(() =>
      Promise.resolve([{ grantId: 'grant-a' as GrantId, refusal: 'expired' }]),
    );
    sweepGrants({ grants, audience: hubs, timers, logger });

    timers.fireAll();
    await Promise.resolve();
    await Promise.resolve();

    expect(closed).toEqual([{ grantId: 'grant-a', reason: 'this grant has expired' }]);
  });

  it('reads nothing while no hub is connected', () => {
    const timers = createFakeTimers();
    const { audience: hubs } = audience([]);
    const grants = store(() => Promise.resolve([]));
    sweepGrants({ grants, audience: hubs, timers, logger });

    timers.fireAll();

    expect(grants.asked).toEqual([]);
    // And it is still running: an empty pass reschedules like any other.
    expect(timers.pending).toBe(1);
  });

  it('keeps sweeping on the interval it was given', async () => {
    const timers = createFakeTimers();
    const { audience: hubs } = audience(['grant-a']);
    const grants = store(() => Promise.resolve([]));
    sweepGrants({ grants, audience: hubs, timers, logger, intervalMs: 500 });

    expect(timers.delays).toEqual([500]);
    timers.fireAll();
    await Promise.resolve();
    await Promise.resolve();

    expect(timers.delays).toEqual([500]);
    expect(grants.asked).toHaveLength(1);
  });

  it('defaults to an interval short enough to be one sentence with the revocation', () => {
    const timers = createFakeTimers();
    const { audience: hubs } = audience([]);
    sweepGrants({ grants: store(() => Promise.resolve([])), audience: hubs, timers, logger });

    expect(timers.delays).toEqual([GRANT_SWEEP_INTERVAL_MS]);
  });

  /**
   * A pass that threw costs that pass. Dropping every hub because one read
   * failed would be the outage revocation exists to avoid.
   */
  it('keeps going after a sweep that failed, without closing anything', async () => {
    const timers = createFakeTimers();
    const written: LogRecord[] = [];
    const { audience: hubs, closed } = audience(['grant-a']);
    const grants = store(() => Promise.reject(new Error('the disk went away')));
    sweepGrants({
      grants,
      audience: hubs,
      timers,
      logger: createLogger('debug', (record) => void written.push(record)),
    });

    timers.fireAll();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(closed).toEqual([]);
    expect(written.map((record) => record.message)).toContain('could not sweep the grants');
    expect(timers.pending).toBe(1);
  });

  it('stops, because a pending timer is a process that will not exit', () => {
    const timers = createFakeTimers();
    const { audience: hubs } = audience(['grant-a']);
    const sweep = sweepGrants({
      grants: store(() => Promise.resolve([])),
      audience: hubs,
      timers,
      logger,
    });

    sweep.stop();

    expect(timers.pending).toBe(0);
  });

  it('says nothing about a token, because it has never held one', async () => {
    const timers = createFakeTimers();
    const written: LogRecord[] = [];
    const { audience: hubs } = audience(['grant-a']);
    const grants = store(() =>
      Promise.resolve([{ grantId: 'grant-a' as GrantId, refusal: 'revoked' }]),
    );
    sweepGrants({
      grants,
      audience: hubs,
      timers,
      logger: createLogger('debug', (record) => void written.push(record)),
    });

    timers.fireAll();
    await Promise.resolve();
    await Promise.resolve();

    expect(written.map((record) => record.message)).toContain('hub connections closed');
    expect(JSON.stringify(written)).not.toContain('verifier');
  });
});
