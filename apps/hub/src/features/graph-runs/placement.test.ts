import { describe, expect, it } from 'vitest';
import {
  graphNodeSchema,
  serverAddressSchema,
  storeIdSchema,
  type GraphNode,
  type ServerRegistrationId,
  type StoreId,
} from '@agentplex/protocol';
import { readyProvider } from '@agentplex/providers/testing';
import { createLogger } from '@agentplex/node-shared';
import type { ServerConnectionPhase, ServerConnectionReport } from '../servers/servers.js';
import { createFleetState, type HubStateSnapshot } from '../fleet-state/fleet-state.js';
import { placeNode } from './placement.js';

/**
 * Where a node's work goes, against real reduced state.
 *
 * Built by driving the reducer rather than by writing a snapshot literal, for
 * the reason the routing suite gives: a hand-written snapshot could describe a
 * fleet no sequence of reports produces. What this decides is small on
 * purpose -- Cheapest is a `null` the hub's own scheduler fills in, and Pin is
 * one machine checked for being there -- because a second scheduler here
 * would drift from the one every other start goes through.
 */

const START = 1_756_000_000_000;
const logger = createLogger('error', () => {});
const WORK = storeIdSchema.parse('store-work');

function registration(label: string): ServerRegistrationId {
  return `registration-${label}` as ServerRegistrationId;
}

function connection(
  label: string,
  phase: ServerConnectionPhase,
  stores: readonly StoreId[],
): ServerConnectionReport {
  return {
    registrationId: registration(label),
    label,
    address: serverAddressSchema.parse(`wss://${label}.example:8443`),
    serverId: null,
    phase,
    providers: [readyProvider()],
    stores,
    connectedSince: phase === 'connected' ? START : null,
    staleSince: phase === 'stale' ? START + 1_000 : null,
    lastConnectedAt: phase === 'connecting' ? null : START,
    failedAttempts: phase === 'stale' ? 1 : 0,
    problem: null,
    staleReason: phase === 'stale' ? 'unreachable' : null,
    draining: null,
  };
}

function fleet(
  machines: readonly { label: string; phase: ServerConnectionPhase }[],
): HubStateSnapshot {
  const reducer = createFleetState({ logger });
  for (const machine of machines) {
    reducer.applyConnection(connection(machine.label, machine.phase, [WORK]));
  }
  return reducer.snapshot();
}

function agent(placement: unknown, label = 'Rust reviewer'): GraphNode {
  return graphNodeSchema.parse({
    id: 'review',
    kind: 'agent',
    label,
    position: { x: 0, y: 0 },
    placement,
    retry: { max: 0, backoff: 1 },
    prompt: 'Review it.',
    provider: 'claude',
    storeId: WORK,
  });
}

describe('placeNode', () => {
  it('leaves Cheapest to the hub’s own scheduler: no machine named', () => {
    const state = fleet([
      { label: 'attic', phase: 'connected' },
      { label: 'workshop', phase: 'connected' },
    ]);

    expect(placeNode(state, agent({ kind: 'cheapest' }))).toEqual({ ok: true, server: null });
  });

  it('names the pinned machine when it is connected', () => {
    const state = fleet([{ label: 'gpu-box', phase: 'connected' }]);

    expect(placeNode(state, agent({ kind: 'pin', server: registration('gpu-box') }))).toEqual({
      ok: true,
      server: registration('gpu-box'),
    });
  });

  it('refuses a pin to a machine that is not connected, naming the node and the machine', () => {
    const state = fleet([{ label: 'gpu-box', phase: 'stale' }]);

    expect(placeNode(state, agent({ kind: 'pin', server: registration('gpu-box') }))).toEqual({
      ok: false,
      problem: 'Rust reviewer is pinned to gpu-box, which is not connected right now',
    });
  });

  it('refuses a pin to a machine this hub is not paired with', () => {
    const state = fleet([{ label: 'attic', phase: 'connected' }]);

    expect(placeNode(state, agent({ kind: 'pin', server: registration('gone') }))).toEqual({
      ok: false,
      problem: 'Rust reviewer is pinned to a server this hub is not paired with',
    });
  });

  it('names the node by its id when it has no label', () => {
    const state = fleet([]);

    expect(placeNode(state, agent({ kind: 'pin', server: registration('gone') }, ' '))).toEqual({
      ok: false,
      problem: 'review is pinned to a server this hub is not paired with',
    });
  });
});
