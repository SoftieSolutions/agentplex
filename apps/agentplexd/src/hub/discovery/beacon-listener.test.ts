import { describe, expect, it } from 'vitest';
import {
  BEACON_EXPIRY_MS,
  BEACON_ANNOUNCE_INTERVAL_MS,
  PROTOCOL_VERSION,
  formatServerBeacon,
  serverIdSchema,
  type ServerId,
} from '@agentplex/protocol';
import { createLogger, type LogRecord } from '../../shared/logger.js';
import { createFakeTimers, type FakeTimers } from '../../shared/timers.js';
import {
  startBeaconListener,
  type BeaconDatagram,
  type BeaconSource,
  type DiscoveredServer,
} from './beacon-listener.js';

/**
 * Listening, driven by hand.
 *
 * Nothing here opens a socket: the source is the seam, so what these assert is
 * the whole of what the hub does with a datagram -- who it keeps, for how long,
 * and what it refuses to conclude from having heard one.
 *
 * The payloads are formatted by the protocol's own `formatServerBeacon`, which
 * is the function the announcing server calls. A hand-typed JSON string here
 * would test that the listener can read what this file's author imagined a
 * beacon looks like.
 */

const START = 1_756_000_000_000;

function beaconText(overrides: Partial<Parameters<typeof formatServerBeacon>[0]> = {}): string {
  return formatServerBeacon({
    type: 'agentplex-server-beacon',
    protocolVersion: PROTOCOL_VERSION,
    serverId: serverIdSchema.parse('server-gpu-box'),
    address: '192.168.1.24',
    port: 8443,
    ...overrides,
  });
}

function listening(options: { expiryMs?: number; maxCandidates?: number } = {}) {
  let deliver: ((datagram: BeaconDatagram) => void) | null = null;
  let closed = 0;
  let now = START;

  const lines: LogRecord[] = [];
  const timers: FakeTimers = createFakeTimers();
  const heard: (readonly DiscoveredServer[])[] = [];

  const source: BeaconSource = {
    listen(onDatagram) {
      deliver = onDatagram;
      return {
        close(): void {
          closed += 1;
        },
      };
    },
  };

  const listener = startBeaconListener({
    source,
    clock: { now: () => now },
    timers,
    logger: createLogger('debug', (record) => void lines.push(record)),
    ...(options.expiryMs === undefined ? {} : { expiryMs: options.expiryMs }),
    ...(options.maxCandidates === undefined ? {} : { maxCandidates: options.maxCandidates }),
  });
  const unsubscribe = listener.subscribe((candidates) => void heard.push(candidates));

  return {
    listener,
    timers,
    lines,
    unsubscribe,
    /** Every set of candidates a subscriber was told about, in order. */
    published: heard,
    get closed(): number {
      return closed;
    },
    at(moment: number): void {
      now = moment;
    },
    advance(byMs: number): void {
      now += byMs;
    },
    /** Fires whatever the listener has scheduled, at the clock as it stands. */
    tick(): void {
      timers.fireAll();
    },
    send(text: string, from = '192.168.1.24'): void {
      if (deliver === null) throw new Error('the listener never started listening');
      deliver({ text, from });
    },
  };
}

describe('the hub beacon listener', () => {
  it('makes a candidate of the first beacon it hears', () => {
    const hub = listening();
    hub.send(beaconText());

    expect(hub.listener.candidates).toEqual([
      {
        serverId: 'server-gpu-box',
        address: '192.168.1.24',
        port: 8443,
        protocolVersion: PROTOCOL_VERSION,
        heardAt: START,
        heardFrom: '192.168.1.24',
      },
    ]);
    expect(hub.published).toHaveLength(1);
  });

  it('listens the moment it is started, without being asked to', () => {
    // Unconditional is the design: hearing a beacon costs nothing and grants
    // nothing, so there is no setting to consult and nothing to turn on.
    const hub = listening();
    expect(() => hub.send(beaconText())).not.toThrow();
    expect(hub.listener.candidates).toHaveLength(1);
  });

  it('refreshes a repeated claim without waking every client for it', () => {
    const hub = listening();
    hub.send(beaconText());
    hub.advance(BEACON_ANNOUNCE_INTERVAL_MS);
    hub.send(beaconText());

    expect(hub.listener.candidates).toHaveLength(1);
    // The published shape did not change, so nothing was published. A server
    // announcing every five seconds must not be five seconds of broadcast
    // traffic to every attached client saying the same thing.
    expect(hub.published).toHaveLength(1);
    expect(hub.listener.candidates[0]?.heardAt).toBe(START + BEACON_ANNOUNCE_INTERVAL_MS);
  });

  it('ages a claim out after six missed announcements, and says so', () => {
    const hub = listening();
    hub.send(beaconText());

    // One short of the window: five missed announcements is a machine having a
    // bad minute on a wifi network, not a machine that is gone.
    hub.advance(BEACON_EXPIRY_MS - 1);
    hub.tick();
    expect(hub.listener.candidates).toHaveLength(1);

    hub.advance(1);
    hub.tick();
    expect(hub.listener.candidates).toEqual([]);
    expect(hub.published.at(-1)).toEqual([]);
  });

  it('keeps a refreshed claim past the window the first beacon opened', () => {
    const hub = listening();
    hub.send(beaconText());
    hub.advance(BEACON_ANNOUNCE_INTERVAL_MS);
    hub.send(beaconText());

    hub.advance(BEACON_EXPIRY_MS - BEACON_ANNOUNCE_INTERVAL_MS);
    hub.tick();
    expect(hub.listener.candidates).toHaveLength(1);

    hub.advance(BEACON_ANNOUNCE_INTERVAL_MS);
    hub.tick();
    expect(hub.listener.candidates).toEqual([]);
  });

  it('never reports a claim that has aged out, whether or not the sweep has run', () => {
    // The read is filtered as well as swept. A client asking between the last
    // beacon and the next sweep must not be offered a machine that is gone,
    // and the sweep exists to tell clients rather than to be the only thing
    // that knows.
    const hub = listening();
    hub.send(beaconText());
    hub.advance(BEACON_EXPIRY_MS);
    expect(hub.listener.candidates).toEqual([]);
  });

  it('lets a machine that came back be a candidate again', () => {
    const hub = listening();
    hub.send(beaconText());
    hub.advance(BEACON_EXPIRY_MS);
    hub.tick();
    expect(hub.listener.candidates).toEqual([]);

    hub.send(beaconText());
    expect(hub.listener.candidates).toHaveLength(1);
    expect(hub.published.at(-1)).toHaveLength(1);
  });

  it('replaces a claim when the machine says it moved', () => {
    const hub = listening();
    hub.send(beaconText());
    hub.send(beaconText({ address: '10.0.0.9', port: 9443 }));

    expect(hub.listener.candidates).toHaveLength(1);
    expect(hub.listener.candidates[0]?.address).toBe('10.0.0.9');
    expect(hub.listener.candidates[0]?.port).toBe(9443);
    expect(hub.published).toHaveLength(2);
  });

  it('costs a malformed datagram itself and not the listener', () => {
    const hub = listening();
    hub.send('not a frame at all');
    hub.send('{"type":"someone-elses-protocol","hello":true}');
    hub.send(beaconText());

    expect(hub.listener.candidates).toHaveLength(1);
    expect(hub.listener.candidates[0]?.serverId).toBe('server-gpu-box');
    // Logged, and at a level nobody is paged by: an open UDP port collects
    // whatever the network sends it, and another program's datagram is not a
    // fault of this one's.
    const ignored = hub.lines.filter((line) => line.message.includes('not a beacon'));
    expect(ignored).toHaveLength(2);
    expect(ignored.every((line) => line.level === 'debug')).toBe(true);
  });

  it('refuses a datagram carrying a secret, however plausible the rest of it', () => {
    // The strict schema, from this side: a build that started broadcasting a
    // token fails to be understood rather than being trusted.
    const hub = listening();
    hub.send(
      JSON.stringify({
        type: 'agentplex-server-beacon',
        protocolVersion: PROTOCOL_VERSION,
        serverId: 'server-gpu-box',
        address: '192.168.1.24',
        port: 8443,
        token: 'here-is-my-token',
      }),
    );
    expect(hub.listener.candidates).toEqual([]);
  });

  it('keeps a machine speaking another protocol, and carries the version it claimed', () => {
    const hub = listening();
    hub.send(beaconText({ protocolVersion: PROTOCOL_VERSION + 1 }));

    // Kept, because the honest report is "a machine is there and this hub
    // cannot speak to it". Dropping it would report silence, which is a
    // different and untrue thing.
    expect(hub.listener.candidates).toHaveLength(1);
    expect(hub.listener.candidates[0]?.protocolVersion).toBe(PROTOCOL_VERSION + 1);
    expect(hub.lines.some((line) => line.message.includes('another protocol'))).toBe(true);
  });

  it('sorts candidates by server id, so two reads never disagree about order', () => {
    const hub = listening();
    hub.send(beaconText({ serverId: serverIdSchema.parse('server-zulu') }));
    hub.send(beaconText({ serverId: serverIdSchema.parse('server-alpha') }));

    expect(hub.listener.candidates.map((candidate) => candidate.serverId)).toEqual([
      'server-alpha',
      'server-zulu',
    ]);
  });

  it('records where a datagram came from, without publishing a verdict about it', () => {
    // The source address is a cross-check an operator can read, not a rule: a
    // server told to announce a hostname the operator configured is announcing
    // exactly what they meant, and a mismatch there is ordinary.
    const hub = listening();
    hub.send(beaconText({ address: 'gpu-box.example' }), '192.168.1.24');

    expect(hub.listener.candidates[0]?.address).toBe('gpu-box.example');
    expect(hub.listener.candidates[0]?.heardFrom).toBe('192.168.1.24');
  });

  it('stops listening and publishing when the hub stops', () => {
    const hub = listening();
    hub.send(beaconText());
    hub.listener.stop();

    expect(hub.closed).toBe(1);
    expect(hub.timers.pending).toBe(0);
    expect(hub.listener.candidates).toEqual([]);

    hub.listener.stop();
    expect(hub.closed).toBe(1);
  });

  it('tells a subscriber nothing more once it has unsubscribed', () => {
    const hub = listening();
    hub.unsubscribe();
    hub.send(beaconText());
    expect(hub.published).toEqual([]);
    expect(hub.listener.candidates).toHaveLength(1);
  });

  it('costs a subscriber that throws itself and not the others', () => {
    const hub = listening();
    const also: (readonly DiscoveredServer[])[] = [];
    hub.listener.subscribe(() => {
      throw new Error('this listener is broken');
    });
    hub.listener.subscribe((candidates) => void also.push(candidates));
    hub.send(beaconText());

    expect(also).toHaveLength(1);
    expect(hub.lines.some((line) => line.message.includes('listener threw'))).toBe(true);
  });

  it('holds a bounded number of claims, keeping the ones it already had', () => {
    // The one place a stranger can make this hub allocate. A flood is refused
    // rather than allowed to evict, so the machine somebody is actually
    // waiting to pair with cannot be pushed out of the list by noise.
    const hub = listening({ maxCandidates: 2 });
    hub.send(beaconText({ serverId: serverIdSchema.parse('server-alpha') }));
    hub.send(beaconText({ serverId: serverIdSchema.parse('server-bravo') }));
    hub.send(beaconText({ serverId: serverIdSchema.parse('server-charlie') }));

    expect(hub.listener.candidates.map((candidate) => candidate.serverId)).toEqual([
      'server-alpha',
      'server-bravo',
    ]);
    expect(hub.lines.some((line) => line.message.includes('than this hub will hold'))).toBe(true);
  });

  it('lets a held machine keep refreshing itself while the bound is reached', () => {
    const hub = listening({ maxCandidates: 1 });
    hub.send(beaconText({ serverId: serverIdSchema.parse('server-alpha') }));
    hub.send(beaconText({ serverId: serverIdSchema.parse('server-bravo') }));
    hub.advance(BEACON_ANNOUNCE_INTERVAL_MS);
    hub.send(beaconText({ serverId: serverIdSchema.parse('server-alpha'), port: 9443 }));

    expect(hub.listener.candidates).toHaveLength(1);
    expect(hub.listener.candidates[0]?.port).toBe(9443);
  });

  it('takes an expiry a deployment set rather than assuming the shared one', () => {
    const hub = listening({ expiryMs: 100 });
    hub.send(beaconText());
    hub.advance(100);
    hub.tick();
    expect(hub.listener.candidates).toEqual([]);
  });
});

/** The type is the assertion: nothing about a candidate names a pairing. */
describe('what a candidate is not', () => {
  it('carries no registration id, no label, and no token', () => {
    const hub = listening();
    hub.send(beaconText());
    const candidate = hub.listener.candidates[0];
    expect(candidate).toBeDefined();
    if (candidate === undefined) return;
    expect(Object.keys(candidate).sort()).toEqual([
      'address',
      'heardAt',
      'heardFrom',
      'port',
      'protocolVersion',
      'serverId',
    ]);
  });

  it('is keyed by what the machine calls itself and nothing the hub assigned', () => {
    const hub = listening();
    const serverId: ServerId = serverIdSchema.parse('server-gpu-box');
    hub.send(beaconText({ serverId }));
    hub.send(beaconText({ serverId, address: '10.0.0.9' }));
    expect(hub.listener.candidates).toHaveLength(1);
  });
});
