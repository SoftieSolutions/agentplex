import type { BeaconDatagram, BeaconReceiver, BeaconSource } from './beacon-listener.js';

/**
 * A network that delivers exactly the datagrams a test hands it.
 *
 * Every test that starts a hub needs one, because listening is unconditional
 * and a hub therefore always has a source. A required dependency and this fake
 * are what guarantee the suite never opens a UDP port on the machine running
 * it: there is no default that quietly reaches for `dgram`.
 *
 * A test that never calls `send` is a hub on a silent network, which is what
 * almost every test here wants.
 */

export interface FakeBeaconSource extends BeaconSource {
  /** Delivers one datagram to the listener, as the socket would. */
  send(text: string, from?: string): void;
  /** Whether something is listening: false before `listen`, false after `close`. */
  readonly listening: boolean;
  readonly closed: number;
}

export function createFakeBeaconSource(): FakeBeaconSource {
  let deliver: ((datagram: BeaconDatagram) => void) | null = null;
  let closed = 0;

  return {
    listen(onDatagram): BeaconReceiver {
      deliver = onDatagram;
      return {
        close(): void {
          deliver = null;
          closed += 1;
        },
      };
    },

    send(text: string, from = '192.168.1.24'): void {
      // Silently dropped when nothing is listening, exactly as a datagram
      // arriving at a machine with no socket bound is.
      deliver?.({ text, from });
    },

    get listening(): boolean {
      return deliver !== null;
    },

    get closed(): number {
      return closed;
    },
  };
}
