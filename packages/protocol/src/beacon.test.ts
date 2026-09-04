import { describe, expect, it } from 'vitest';
import {
  BEACON_ANNOUNCE_INTERVAL_MS,
  BEACON_EXPIRY_MS,
  BEACON_MISSED_LIMIT,
  BEACON_PORT,
  formatServerBeacon,
  parseServerBeacon,
  type ServerBeacon,
} from './beacon.js';
import { parseTextFrame } from './parse.js';
import { PROTOCOL_VERSION, checkProtocolVersion } from './version.js';

const beacon = {
  type: 'agentplex-server-beacon',
  protocolVersion: PROTOCOL_VERSION,
  serverId: 'server-under-test',
  address: '192.168.1.24',
  port: 8081,
} as const;

function parse(payload: unknown): ReturnType<typeof parseServerBeacon> {
  return parseServerBeacon(payload);
}

describe('parseServerBeacon', () => {
  it('reads back what a server announced', () => {
    const text = formatServerBeacon(beacon as ServerBeacon);

    expect(parseTextFrame(parseServerBeacon, text)).toEqual({ ok: true, value: beacon });
  });

  it('refuses a datagram that is not a beacon at all', () => {
    // The listening port is open to whatever else broadcasts on the network,
    // so "not ours" has to be cheap and unmistakable.
    expect(parse({ type: 'some-other-protocol', address: '10.0.0.4', port: 8081 }).ok).toBe(false);
    expect(parseTextFrame(parseServerBeacon, 'not json at all').ok).toBe(false);
  });

  it('refuses a beacon carrying anything beyond the four facts, a token above all', () => {
    // The no-token rule is enforced by the parser rather than by everybody
    // remembering it: a build that started putting a secret in a broadcast
    // would fail to be understood by the hub instead of being trusted by it.
    const withToken = { ...beacon, token: 'a-pairing-token' };

    expect(parse(withToken).ok).toBe(false);
  });

  it('refuses a beacon with no usable address or port to dial', () => {
    expect(parse({ ...beacon, address: '' }).ok).toBe(false);
    expect(parse({ ...beacon, port: 0 }).ok).toBe(false);
    expect(parse({ ...beacon, port: 70000 }).ok).toBe(false);
    expect(parse({ ...beacon, serverId: '' }).ok).toBe(false);
  });

  it('parses a beacon from a peer on another protocol version, and leaves the verdict to the caller', () => {
    // Parsing is not version checking. A hub that refused to read a beacon
    // from a mismatched build could only report silence, where what it can
    // report is a machine it can see and cannot speak to.
    const older = { ...beacon, protocolVersion: PROTOCOL_VERSION - 1 };
    const parsed = parse(older);

    expect(parsed.ok).toBe(true);
    expect(parsed.ok && checkProtocolVersion(parsed.value.protocolVersion)).toEqual({
      expected: PROTOCOL_VERSION,
      received: PROTOCOL_VERSION - 1,
    });
  });

  it('refuses a protocol version that is not a version', () => {
    expect(parse({ ...beacon, protocolVersion: 0 }).ok).toBe(false);
    expect(parse({ ...beacon, protocolVersion: '4' }).ok).toBe(false);
  });
});

describe('the beacon cadence', () => {
  it('ages a claim out after the six missed announcements the design names', () => {
    // Pinned rather than derived: changing the interval changes how long a
    // machine that went away stays on screen, and this is the line that makes
    // somebody decide that on purpose.
    expect(BEACON_MISSED_LIMIT).toBe(6);
    expect(BEACON_ANNOUNCE_INTERVAL_MS).toBe(5_000);
    expect(BEACON_EXPIRY_MS).toBe(30_000);
  });

  it('leaves the machine ports alone', () => {
    // Discovery is its own port on purpose: the hub listens for beacons
    // whether or not it serves on the port a server happens to be dialled on.
    expect(BEACON_PORT).toBeGreaterThan(1023);
    expect(BEACON_PORT).toBeLessThan(65536);
  });
});
