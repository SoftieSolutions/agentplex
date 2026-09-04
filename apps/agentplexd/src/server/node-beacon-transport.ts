import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { BEACON_PORT } from '@agentplex/protocol';
import type { Logger } from '../shared/logger.js';
import type { BeaconNetwork, BeaconTransport } from './server-beacon.js';

/**
 * The one place a UDP socket is opened, and the only file here that knows
 * `dgram` exists.
 *
 * Everything about what a beacon says and how often lives behind the seam in
 * `server-beacon.ts`, where a test can reach it. What is left is the part a
 * test cannot check without a network: binding, the broadcast flag, and the
 * address the operating system will admit this machine has.
 */

/** Limited broadcast: this subnet, and never forwarded past the first router. */
const BROADCAST_ADDRESS = '255.255.255.255';

export function createNodeBeaconNetwork(logger: Logger): BeaconNetwork {
  return {
    open: () => openBeaconTransport(logger),
    localAddresses,
  };
}

/**
 * Binds an ephemeral port and enables broadcast on it.
 *
 * The flag cannot be set before the socket is bound — `setBroadcast` on an
 * unbound handle fails with `EBADF`, which was run rather than assumed — so
 * binding is asynchronous and the first beacon can be ready before the socket
 * is. It is held and sent on `listening` rather than dropped: the first
 * announcement is the one somebody standing at the pairing form is waiting
 * for, and losing it would cost the full interval for no reason.
 *
 * Errors are logged and swallowed. A `dgram` socket with no `error` listener
 * throws the event, and a network that is not up yet must not take down a
 * server whose actual job is running sessions.
 */
function openBeaconTransport(logger: Logger): BeaconTransport {
  const socket = createSocket({ type: 'udp4' });
  let ready = false;
  let closed = false;
  let pending: string | null = null;

  const write = (payload: string): void => {
    socket.send(payload, BEACON_PORT, BROADCAST_ADDRESS, (error) => {
      if (error !== null) logger.warn('beacon send failed', { error: String(error) });
    });
  };

  socket.on('error', (error) => {
    logger.warn('beacon socket failed', { error: String(error) });
  });

  socket.on('listening', () => {
    if (closed) return;
    try {
      socket.setBroadcast(true);
    } catch (error) {
      // Without the flag every send to the broadcast address is refused. Say
      // so once, here, rather than once every interval from the caller.
      logger.warn('beacon cannot broadcast on this socket', { error: String(error) });
      return;
    }
    ready = true;
    if (pending !== null) {
      const first = pending;
      pending = null;
      write(first);
    }
  });

  // No port argument: a beacon is only ever sent, so the source port does not
  // matter and asking for a fixed one would collide with the hub listening on
  // this port in a `--role=both` process on the same machine.
  socket.bind();

  // Nothing about announcing should keep a process alive that is otherwise
  // done, exactly as the timer that drives it does not.
  socket.unref();

  return {
    send(payload: string): void {
      if (closed) return;
      if (!ready) {
        pending = payload;
        return;
      }
      write(payload);
    },
    close(): void {
      if (closed) return;
      closed = true;
      pending = null;
      try {
        socket.close();
      } catch {
        // Already closed, or never opened. Either way there is nothing left to
        // do and a shutdown path is the wrong place to raise it.
      }
    },
  };
}

/**
 * The addresses of this host a hub on the same network could dial.
 *
 * IPv4 and not internal: loopback is reachable only from this machine, so
 * announcing it would offer a pairing that works from nowhere but here. IPv6
 * is left out because the broadcast above is v4 — a v6 network discovers
 * nothing today, and half-answering it here would only make that harder to
 * see. An operator with one sets `--host` and announces exactly what they mean.
 */
function localAddresses(): readonly string[] {
  const found: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) found.push(address.address);
    }
  }
  return found;
}
