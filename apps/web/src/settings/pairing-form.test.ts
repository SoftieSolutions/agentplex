import { describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame } from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import {
  discoveredCandidates,
  parsePairingForm,
  prefillFromCandidate,
  type DiscoveredCandidate,
} from './pairing-form.js';

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
  it('selecting a candidate pre-fills the address and nothing else', () => {
    const candidate: DiscoveredCandidate = {
      address: 'wss://found-on-the-lan.local:8443',
      label: 'found-on-the-lan',
    };
    const prefill = prefillFromCandidate(candidate);
    expect(prefill).toEqual({ address: 'wss://found-on-the-lan.local:8443' });
    // The rule, asserted structurally: the pre-fill carries the one key. A
    // token could not even ride along by accident.
    expect(Object.keys(prefill)).toEqual(['address']);
  });

  it('reads zero candidates out of what the hub actually broadcasts', () => {
    // The captured machine-state frame carries no discovery field; the screen
    // therefore draws no candidates UI at all.
    const parsed = parseTextFrame(parseHubFrame, hubFrames.machineState);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.type !== 'machine-state') throw new Error('not machine-state');
    expect(discoveredCandidates(parsed.value.state)).toEqual([]);
    expect(discoveredCandidates(null)).toEqual([]);
  });
});
