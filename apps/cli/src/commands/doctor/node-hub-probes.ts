import { access, constants } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { PathAccess, PortProbe, PortState, WriteAccess } from './hub.js';

/**
 * The two questions about a hub that only the machine can answer, as the calls
 * that ask it.
 *
 * Separate from `hub.ts` for the reason `node-store-files.ts` is separate from
 * the seam it implements: the rules are a pure function of what these return,
 * and a suite that had to arrange a permission or a bound port in order to test
 * a rule would be testing the arrangement.
 */

/**
 * Whether this process may write at a path, asked with `access` and nothing
 * else.
 *
 * `W_OK` and not a trial write: creating a file to find out whether one could
 * be created is exactly the thing a read-only check may not do, and it leaves
 * the file behind on the one machine where it worked. The usual caveat about
 * `access` -- that the answer can be stale by the time you act on it -- is the
 * caveat this whole program carries: it reports a machine as it was when it
 * looked.
 */
export const nodePathAccess: PathAccess = async (path: string): Promise<WriteAccess> => {
  try {
    await access(path, constants.W_OK);
    return { kind: 'writable' };
  } catch (error) {
    return { kind: 'denied', reason: String(error) };
  }
};

/**
 * Whether something already holds an address, asked by binding it and letting
 * go of it again.
 *
 * `exclusive: true` is load-bearing. Without it Node asks for `SO_REUSEPORT`
 * semantics inside a cluster, and a bind that succeeded alongside another
 * listener would report a held port as free -- which is the one answer this
 * must never give.
 *
 * The listener is closed before the promise resolves, so nothing outlives the
 * question. A connection cannot arrive in that window and be dropped: the
 * socket is closed before it is ever handed a connection handler, and anything
 * that did connect would find a closed port on the next packet -- the same
 * thing it finds one millisecond earlier.
 */
export const nodePortProbe: PortProbe = async (host: string, port: number): Promise<PortState> =>
  await new Promise<PortState>((resolve) => {
    const server = createServer();
    const settle = (state: PortState): void => {
      server.removeAllListeners();
      server.close(() => {
        resolve(state);
      });
    };

    server.once('error', (error: NodeJS.ErrnoException) => {
      server.removeAllListeners();
      // No `close()` here: a listener that never bound has nothing to close,
      // and calling it would produce a second error about not being open.
      resolve(
        error.code === 'EADDRINUSE'
          ? { kind: 'in-use' }
          : { kind: 'failed', reason: String(error) },
      );
    });
    server.once('listening', () => {
      settle({ kind: 'free' });
    });

    server.listen({ host, port, exclusive: true });
  });
