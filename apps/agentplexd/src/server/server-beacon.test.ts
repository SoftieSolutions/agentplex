import { describe, expect, it } from 'vitest';
import {
  BEACON_ANNOUNCE_INTERVAL_MS,
  PROTOCOL_VERSION,
  parseServerBeacon,
  parseTextFrame,
  type ServerId,
} from '@agentplex/protocol';
import { createLogger, type LogRecord } from '../shared/logger.js';
import { createFakeTimers } from '../shared/timers.js';
import {
  announceServer,
  chooseBeaconAddress,
  startServerBeacon,
  type BeaconNetwork,
  type BeaconTransport,
} from './server-beacon.js';

/**
 * Announcing is opt-in, and what it announces is four facts and no secret.
 *
 * Nothing here opens a socket: the transport is the seam, so what these assert
 * is the payload and the cadence, which is the whole of what the other side
 * depends on.
 */

const SERVER_ID = 'server-under-test' as ServerId;

function fakeTransport(options: { failWith?: string } = {}) {
  const sent: string[] = [];
  let closed = 0;

  return {
    sent,
    get closed(): number {
      return closed;
    },
    transport: {
      send(payload: string): void {
        if (options.failWith !== undefined) throw new Error(options.failWith);
        sent.push(payload);
      },
      close(): void {
        closed += 1;
      },
    } satisfies BeaconTransport,
  };
}

function announcing(options: { failWith?: string } = {}) {
  const lines: LogRecord[] = [];
  const transport = fakeTransport(options);
  const timers = createFakeTimers();
  const beacon = startServerBeacon({
    transport: transport.transport,
    timers,
    logger: createLogger('debug', (record) => void lines.push(record)),
    serverId: SERVER_ID,
    address: '192.168.1.24',
    port: 8081,
  });

  return { beacon, timers, transport, lines };
}

function beacons(sent: readonly string[]): readonly unknown[] {
  return sent.map((text) => {
    const parsed = parseTextFrame(parseServerBeacon, text);
    expect(parsed.ok).toBe(true);
    return parsed.ok ? parsed.value : null;
  });
}

describe('startServerBeacon', () => {
  it('announces at once rather than waiting out the first interval', () => {
    // A server that just started is the case discovery exists for: somebody is
    // standing at the pairing form now.
    const { transport } = announcing();

    expect(transport.sent).toHaveLength(1);
  });

  it('announces the four facts the hub needs to offer a pairing, and nothing else', () => {
    const { transport } = announcing();

    expect(beacons(transport.sent)[0]).toEqual({
      type: 'agentplex-server-beacon',
      protocolVersion: PROTOCOL_VERSION,
      serverId: SERVER_ID,
      address: '192.168.1.24',
      port: 8081,
    });
  });

  it('never puts the pairing token on the wire, whatever else it is holding', () => {
    // The identity that carries the token is not reachable from here at all:
    // this takes a serverId and a port, and there is no parameter through
    // which a secret could arrive to be broadcast. The assertion is on the
    // bytes, because that is what the network sees.
    const { transport } = announcing();

    expect(transport.sent.join('')).not.toContain('token');
  });

  it('repeats itself on the shared interval, so silence means gone on the other side', () => {
    const { timers, transport } = announcing();

    expect(timers.delays).toEqual([BEACON_ANNOUNCE_INTERVAL_MS]);

    timers.fireAll();
    timers.fireAll();

    expect(transport.sent).toHaveLength(3);
    expect(timers.delays).toEqual([BEACON_ANNOUNCE_INTERVAL_MS]);
  });

  it('stops announcing and closes the socket when the server stops', () => {
    const { beacon, timers, transport } = announcing();

    beacon.stop();

    expect(transport.closed).toBe(1);
    expect(timers.pending).toBe(0);

    timers.fireAll();
    beacon.stop();

    expect(transport.sent).toHaveLength(1);
    expect(transport.closed).toBe(1);
  });

  it('keeps announcing after a send fails, because an unreachable network comes back', () => {
    // A broadcast that cannot leave the machine costs itself and nothing else.
    // Tearing the beacon down over one failed datagram would mean a server
    // that came up before its network did never announces again.
    const { beacon, timers, lines } = announcing({ failWith: 'ENETUNREACH' });

    expect(timers.pending).toBe(1);
    timers.fireAll();
    expect(timers.pending).toBe(1);
    expect(lines.filter((line) => line.level === 'warn')).toHaveLength(2);

    beacon.stop();
  });
});

describe('announceServer', () => {
  function network(addresses: readonly string[]) {
    const opened = fakeTransport();
    let opens = 0;

    return {
      opened,
      get opens(): number {
        return opens;
      },
      network: {
        open(): BeaconTransport {
          opens += 1;
          return opened.transport;
        },
        localAddresses: () => addresses,
      } satisfies BeaconNetwork,
    };
  }

  function announce(network: BeaconNetwork | null, host: string) {
    const lines: LogRecord[] = [];
    const beacon = announceServer(network, {
      host,
      port: 8081,
      serverId: SERVER_ID,
      timers: createFakeTimers(),
      logger: createLogger('debug', (record) => void lines.push(record)),
    });
    return { beacon, lines };
  }

  it('opens no socket at all for a server that was not asked to announce', () => {
    // Opt-in is a type here rather than a boolean beside a socket: a server
    // that does not announce has nothing to announce with.
    expect(announce(null, '0.0.0.0').beacon).toBeNull();
  });

  it('announces the configured host when there is one', () => {
    const supplied = network([]);
    const { beacon } = announce(supplied.network, '10.1.2.3');

    expect(beacon).not.toBeNull();
    expect(supplied.opens).toBe(1);
    expect(beacons(supplied.opened.sent)[0]).toMatchObject({ address: '10.1.2.3', port: 8081 });
  });

  it('falls back to an address the machine actually has', () => {
    const supplied = network(['192.168.1.24']);
    announce(supplied.network, '0.0.0.0');

    expect(beacons(supplied.opened.sent)[0]).toMatchObject({ address: '192.168.1.24' });
  });

  it('stays quiet, and says why, when there is no address worth announcing', () => {
    // Announcing `0.0.0.0` would offer a pairing that cannot work, and the
    // user would be the one to find that out.
    const supplied = network([]);
    const { beacon, lines } = announce(supplied.network, '0.0.0.0');

    expect(beacon).toBeNull();
    expect(supplied.opens).toBe(0);
    expect(lines.filter((line) => line.level === 'warn')).toHaveLength(1);
  });
});

describe('chooseBeaconAddress', () => {
  it('announces the interface the server was told to bind', () => {
    expect(chooseBeaconAddress('192.168.1.24', [])).toBe('192.168.1.24');
  });

  it('picks a real address when the server binds every interface', () => {
    // `0.0.0.0` is what the process bound, not somewhere a hub can dial.
    // Announcing it would be an address that cannot fail to be useless.
    expect(chooseBeaconAddress('0.0.0.0', ['10.0.0.4', '192.168.1.24'])).toBe('10.0.0.4');
    expect(chooseBeaconAddress('::', ['10.0.0.4'])).toBe('10.0.0.4');
  });

  it('says it has no address rather than announcing one that cannot be dialled', () => {
    // Silence is the honest degradation: a beacon naming a wildcard would put
    // a machine in the pairing form that the hub can never reach, and the user
    // would be the one to discover it.
    expect(chooseBeaconAddress('0.0.0.0', [])).toBeNull();
    expect(chooseBeaconAddress('', [])).toBeNull();
  });
});
