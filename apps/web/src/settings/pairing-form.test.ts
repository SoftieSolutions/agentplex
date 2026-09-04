import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  machineStateSchema,
  parseHubFrame,
  parseTextFrame,
  type MachineState,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import {
  discoveredCandidates,
  parsePairingForm,
  prefillFromCandidate,
  type DiscoveredCandidate,
} from './pairing-form.js';

function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') throw new Error('not machine-state');
  return parsed.value.state;
}

/**
 * A hub that has heard one machine at the given address.
 *
 * Built through the wire schema rather than cast into shape: the addresses
 * below are ones no capture contains -- an operator's own hostname, an IPv6
 * literal -- and a hand-made object asserted against would only prove that the
 * reader agrees with this file. The parser is what says the state is one the
 * hub could have sent.
 */
function stateAnnouncing(address: string): MachineState {
  return machineStateSchema.parse({
    version: 1,
    stores: [],
    servers: [],
    candidates: [
      { serverId: 'server-odd', address, port: 8443, protocolVersion: PROTOCOL_VERSION },
    ],
  });
}

describe('the pairing form parser', () => {
  it('accepts a complete form, trimmed', () => {
    const parsed = parsePairingForm({
      name: '  gpu-box-01  ',
      address: ' wss://gpu-box-01.example:8443 ',
      token: '  printed-by-the-server  ',
    });
    expect(parsed).toEqual({
      ok: true,
      request: {
        label: 'gpu-box-01',
        address: 'wss://gpu-box-01.example:8443',
        token: 'printed-by-the-server',
      },
    });
  });

  it('reports every problem at once, each in words', () => {
    const parsed = parsePairingForm({ name: '   ', address: 'nope', token: '' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems.name).toBe('expected a name for this server');
    expect(parsed.problems.address).toContain('wss://');
    expect(parsed.problems.token).toBe('expected the token this server printed');
  });

  it('refuses a name longer than the hub would store', () => {
    const parsed = parsePairingForm({
      name: 'x'.repeat(201),
      address: 'wss://box.example:8443',
      token: 't',
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.name).toContain('200');
  });

  it('carries the address problem through to the form result', () => {
    const parsed = parsePairingForm({
      name: 'box',
      address: 'ws://box.example:8443',
      token: 't',
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.address).toContain('"ws:"');
  });
});

describe('discovered candidates', () => {
  const candidate: DiscoveredCandidate = {
    serverId: 'found-on-the-lan',
    host: '192.168.1.24',
    port: 8443,
    protocolVersion: PROTOCOL_VERSION,
    address: 'wss://192.168.1.24:8443',
    unusable: null,
  };

  it('selecting a candidate pre-fills the address and nothing else', () => {
    const prefill = prefillFromCandidate(candidate);
    expect(prefill).toEqual({ address: 'wss://192.168.1.24:8443' });
    // The rule, asserted structurally: the pre-fill carries the one key. A
    // token could not ride along by accident, and neither could a name -- the
    // beacon's self-description is a hint on the list, not a value typed into
    // somebody's form on their behalf.
    expect(prefill === null ? [] : Object.keys(prefill)).toEqual(['address']);
  });

  it('pre-fills and stops: what it returns cannot pair anything', () => {
    // Selecting is not a shortcut past the token. The form still wants a name
    // and the token that server printed, and the parser is what says so.
    const prefill = prefillFromCandidate(candidate);
    expect(prefill).not.toBeNull();
    if (prefill === null) return;
    const parsed = parsePairingForm({ name: '', address: prefill.address, token: '' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.problems.address).toBeUndefined();
    expect(parsed.problems.token).toBe('expected the token this server printed');
  });

  it('reads what the hub actually broadcasts, one row per machine heard', () => {
    const found = discoveredCandidates(stateFrom(hubFrames.machineStateDiscovered));

    expect(found).toEqual([
      {
        serverId: 'server-mbp',
        host: '192.168.1.24',
        port: 8443,
        protocolVersion: PROTOCOL_VERSION,
        address: 'wss://192.168.1.24:8443',
        unusable: null,
      },
      {
        serverId: 'server-old-build',
        host: '192.168.1.31',
        port: 8443,
        protocolVersion: PROTOCOL_VERSION - 1,
        address: 'wss://192.168.1.31:8443',
        unusable: `this hub speaks protocol ${String(PROTOCOL_VERSION)} and that machine speaks ${String(PROTOCOL_VERSION - 1)}`,
      },
    ]);
  });

  it('shows a machine speaking another protocol, and marks it rather than hiding it', () => {
    // Degrading in the direction that does not over-claim: the honest report
    // is "it is there and this build cannot talk to it", which tells somebody
    // to upgrade one of the two. Hiding it would report an empty network.
    const [, mismatched] = discoveredCandidates(stateFrom(hubFrames.machineStateDiscovered));
    expect(mismatched).toBeDefined();
    if (mismatched === undefined) return;
    expect(mismatched.unusable).not.toBeNull();
    expect(prefillFromCandidate(mismatched)).toBeNull();
  });

  it('marks a candidate whose announced address cannot be dialled', () => {
    // A beacon is a claim like any other, and one naming something no `wss://`
    // URL can be built from is a claim that would fail the moment the user
    // acted on it. Better to show the machine and say so than to pre-fill an
    // address the form itself would refuse.
    const found = discoveredCandidates(stateAnnouncing('not a host name'));

    expect(found[0]?.address).toBeNull();
    expect(found[0]?.unusable).toContain('address');
  });

  it('brackets an IPv6 literal rather than building an address nothing parses', () => {
    const found = discoveredCandidates(stateAnnouncing('fd00::1'));

    expect(found[0]?.address).toBe('wss://[fd00::1]:8443');
    expect(found[0]?.unusable).toBeNull();
  });

  it('reads no candidates out of a hub that has heard nothing', () => {
    expect(discoveredCandidates(stateFrom(hubFrames.machineState))).toEqual([]);
    expect(discoveredCandidates(null)).toEqual([]);
  });

  it('never reads a paired server as a candidate', () => {
    // The two collections are separate on the wire, and this is the reader
    // holding to that: a state full of paired servers has no candidates in it.
    const state = stateFrom(hubFrames.machineStatePopulated);
    expect(state.servers.length).toBeGreaterThan(0);
    expect(discoveredCandidates(state)).toEqual([]);
  });
});
