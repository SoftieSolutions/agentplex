import { createSocket } from 'node:dgram';
import { BEACON_PORT } from '@agentplex/protocol';
import type { Logger } from '../../shared/logger.js';
import type { BeaconReceiver, BeaconSource } from './beacon-listener.js';

/**
 * The one place the hub opens a UDP socket, and the only file here that knows
 * `dgram` exists.
 *
 * Everything about what a candidate is, how long a claim stands and what the
 * hub refuses to conclude from one lives behind the seam in
 * `beacon-listener.ts`, where a test can reach it. What is left is the part no
 * test can check without a network: binding the agreed port, and turning bytes
 * into text.
 *
 * The decode happens here for the reason the encode happens on the announcing
 * side's transport: `@agentplex/protocol` is bundled into a browser and has no
 * `Buffer`. Text crosses the seam in both directions, and only the two files
 * with a socket in them ever see bytes.
 */

export function createNodeBeaconSource(logger: Logger): BeaconSource {
  return {
    listen(onDatagram): BeaconReceiver {
      // `reuseAddr` because more than one thing on a machine may want to hear
      // beacons -- two hubs during an upgrade, or a hub restarting into a
      // socket the kernel has not finished releasing. Discovery traffic is
      // broadcast to everybody by design, so there is nothing here for one
      // listener to take from another.
      const socket = createSocket({ type: 'udp4', reuseAddr: true });
      let closed = false;

      socket.on('message', (data, from) => {
        if (closed) return;
        // Lossy on purpose: bytes that are not UTF-8 become replacement
        // characters and fail the parse behind the seam, which is where a
        // datagram that is not ours is supposed to be turned away.
        onDatagram({ text: data.toString('utf8'), from: from.address });
      });

      socket.on('error', (error) => {
        // Logged and swallowed, and this is the important one: a hub whose
        // discovery port is taken must still serve clients. A `dgram` socket
        // with no `error` listener throws the event, so an EADDRINUSE here
        // would take down a process whose actual job is the fleet. What the
        // failure costs is candidates, which is what the pairing form was
        // before this existed -- the user types an address.
        logger.warn('not listening for servers on the network', {
          port: BEACON_PORT,
          error: String(error),
        });
      });

      socket.on('listening', () => {
        logger.info('listening for servers on the network', { port: BEACON_PORT });
      });

      // The agreed port, and no address: the beacon is a broadcast, so it
      // arrives on whichever interface the network delivered it to, and
      // binding one of them would be choosing which half of a multi-homed
      // machine's network to be deaf to.
      socket.bind(BEACON_PORT);

      // Nothing about listening should hold a process open that is otherwise
      // done, exactly as the announcing side's socket does not.
      socket.unref();

      return {
        close(): void {
          if (closed) return;
          closed = true;
          try {
            socket.close();
          } catch {
            // Already closed, or never bound. A shutdown path is the wrong
            // place to raise either.
          }
        },
      };
    },
  };
}
