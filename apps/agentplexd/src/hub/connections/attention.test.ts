import { describe, expect, it } from 'vitest';
import { storeIdSchema, type StoreId } from '@agentplex/protocol';
import { serverAddressSchema } from '../pairing/server-address.js';
import type { ServerRegistrationId } from '../pairing/server-registrations.js';
import { attentionEligibleStores, countsTowardAttention, unreachableStores } from './attention.js';
import type { ServerConnectionPhase, ServerConnectionReport } from './server-connection.js';

/**
 * The exclusion, on its own.
 *
 * "A badge you cannot clear by looking is worse than none" is a product
 * decision with exactly one testable consequence, and this is it: what the
 * count is allowed to include.
 */

const START = 1_756_000_000_000;

function store(id: string): StoreId {
  return storeIdSchema.parse(id);
}

function report(
  label: string,
  phase: ServerConnectionPhase,
  stores: readonly string[],
): ServerConnectionReport {
  return {
    registrationId: `registration-${label}` as ServerRegistrationId,
    label,
    address: serverAddressSchema.parse(`wss://${label}.example:8443`),
    serverId: null,
    phase,
    stores: stores.map(store),
    connectedSince: phase === 'connected' ? START : null,
    staleSince: phase === 'stale' ? START : null,
    lastConnectedAt: phase === 'connected' ? START : null,
    failedAttempts: phase === 'stale' ? 1 : 0,
    problem: null,
    staleReason: phase === 'stale' ? 'unreachable' : null,
  };
}

describe('countsTowardAttention', () => {
  it('counts a server the hub is holding a connection to', () => {
    expect(countsTowardAttention(report('laptop', 'connected', []))).toBe(true);
  });

  it('does not count a server that is unreachable', () => {
    expect(countsTowardAttention(report('laptop', 'stale', []))).toBe(false);
  });

  it('does not count a server that is only being dialled', () => {
    // A dial in flight is not evidence of anything. Under-counting for the few
    // seconds of a reconnect is a badge that comes back; over-counting is a
    // badge nobody can clear.
    expect(countsTowardAttention(report('laptop', 'connecting', []))).toBe(false);
    expect(countsTowardAttention(report('laptop', 'stopped', []))).toBe(false);
  });
});

describe('attentionEligibleStores', () => {
  it('takes the stores of every connected server', () => {
    const eligible = attentionEligibleStores([
      report('laptop', 'connected', ['store-a', 'store-b']),
      report('box', 'connected', ['store-c']),
    ]);

    expect([...eligible].sort()).toEqual(['store-a', 'store-b', 'store-c']);
  });

  it('leaves out the stores of an unreachable server', () => {
    const eligible = attentionEligibleStores([
      report('laptop', 'connected', ['store-a']),
      report('box', 'stale', ['store-c']),
    ]);

    expect([...eligible]).toEqual(['store-a']);
  });

  it('keeps a shared store when any one server still has it', () => {
    // One store, one session list, N attached servers. A session is
    // {storeId, sessionId} and never the machine, so if any server can reach
    // the volume the sessions on it can still be answered.
    const eligible = attentionEligibleStores([
      report('laptop', 'stale', ['store-shared']),
      report('box', 'connected', ['store-shared']),
    ]);

    expect([...eligible]).toEqual(['store-shared']);
  });

  it('counts nothing when nothing is connected', () => {
    expect(attentionEligibleStores([report('laptop', 'stale', ['store-a'])]).size).toBe(0);
    expect(attentionEligibleStores([]).size).toBe(0);
  });
});

describe('unreachableStores', () => {
  it('names the stores no connected server has mounted', () => {
    const unreachable = unreachableStores([
      report('laptop', 'connected', ['store-a']),
      report('box', 'stale', ['store-c']),
    ]);

    expect([...unreachable]).toEqual(['store-c']);
  });

  it('does not call a store unreachable when another server still holds it', () => {
    const unreachable = unreachableStores([
      report('laptop', 'stale', ['store-shared']),
      report('box', 'connected', ['store-shared']),
    ]);

    expect(unreachable.size).toBe(0);
  });
});
