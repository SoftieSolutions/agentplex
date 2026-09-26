import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import type { ApprovalHookConnection, ApprovalHookListener } from './approval-gate.js';
import { APPROVAL_LAUNCH_PREFIX, type ApprovalFileSystem } from './approval-launch.js';

/**
 * The socket a blocked hook connects to, and the only thing in the approvals
 * path that touches the machine.
 *
 * A unix domain socket under this server's own state directory, rather than a
 * loopback port. A port would be reachable by every user on the box and by
 * anything that can talk to the loopback interface -- containers included --
 * and it would have to be discovered, which means written down somewhere a hook
 * can read. A socket is a path: the launch plan already hands the agent one,
 * the filesystem answers "who may connect" before any byte is read, and there
 * is no port to collide with a second server on the same machine.
 *
 * The permissions are belt and braces on purpose. The socket is created inside
 * a directory this server makes `0700`, *and* the socket itself is `0600`,
 * because the two are enforced differently on the systems agentplex runs on:
 * the directory's mode is what actually stops another user reaching a path on
 * every one of them, and the socket's own mode is what some of them check.
 * Neither is the access control on its own -- anything running as this user
 * still reaches it, which is why the per-launch secret exists.
 *
 * **The read bound is here and nowhere else.** One line per connection, and a
 * connection that has not produced one by the time the bound is reached is
 * dropped without the gate ever seeing it. It is where the bound belongs
 * because this is the only place that has read anything: above here a payload
 * is a string that already arrived whole.
 */

/** The server's own directory for everything a launch's hook needs. */
export const APPROVAL_DIRECTORY = 'approvals';

/** The socket inside it. One per server, shared by every launch it admits. */
export const APPROVAL_SOCKET_NAME = 'hook.sock';

/**
 * How much one hook may send before this stops reading it.
 *
 * Generous, and deliberately far above what a person will read: the line
 * carries the provider's whole payload, and that payload carries the tool's
 * whole input -- a `Write` proposes an entire file. What crosses the wire is
 * cut to four thousand characters much later, at the gate, so a bound here that
 * fitted a proposal would refuse exactly the large edits somebody most wants to
 * be asked about. What it is really against is a local process that opens a
 * connection and never stops writing to it.
 */
export const APPROVAL_LINE_MAX_BYTES = 8 * 1024 * 1024;

export type ApprovalListenerOpen =
  | {
      readonly ok: true;
      readonly listener: ApprovalHookListener;
      /** The path a launch's hook is pointed at. Never on a frame. */
      readonly socketPath: string;
      /** The directory the socket and every launch's settings file live in. */
      readonly directory: string;
    }
  | { readonly ok: false; readonly problem: string };

/**
 * Opens the listener under this server's data root, or says why it could not.
 *
 * A value rather than a throw, because a server that cannot open this socket is
 * still a server: it reports its stores, runs its sessions and serves its
 * terminals, and the one thing it cannot do is ask anybody about a tool call.
 * The launches it makes are then plain launches with no hook in them, and the
 * agent asks at its own terminal -- which is what a machine running no
 * agentplex at all does.
 */
export async function openApprovalListener(dataRoot: string): Promise<ApprovalListenerOpen> {
  const directory = join(dataRoot, APPROVAL_DIRECTORY);
  const socketPath = join(directory, APPROVAL_SOCKET_NAME);

  let server: Server;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // A directory that already existed may have been made with another mode --
    // by an older build, or by a umask that was wider that day -- and `mkdir`
    // says nothing about one it did not create.
    await chmod(directory, 0o700);
    await sweepLaunches(directory);
    // A socket file left behind by a process that was killed is not a listener
    // and cannot be bound over. Removing it is safe precisely because a live
    // one is not a file anybody else is using: a second server on this data
    // root would be a second server on one machine's state, which nothing here
    // supports and nothing detects either.
    await rm(socketPath, { force: true });
    server = await listen(socketPath);
    await chmod(socketPath, 0o600);
  } catch (error) {
    return { ok: false, problem: String(error) };
  }

  /**
   * Connections that arrived before the gate asked for them.
   *
   * The socket is open before the gate exists -- it has to be, the gate is
   * built over it -- and a hook that connects in that instant is a real agent
   * blocked on a real tool call. Dropping it would be a session that hangs at a
   * question nobody was ever shown.
   */
  const waiting: ApprovalHookConnection[] = [];
  let accept: ((connection: ApprovalHookConnection) => void) | null = null;

  server.on('connection', (socket: Socket) => {
    readLine(socket, (line) => {
      const connection = hookConnection(socket, line);
      if (accept === null) waiting.push(connection);
      else accept(connection);
    });
  });

  return {
    ok: true,
    socketPath,
    directory,
    listener: {
      onConnection(handler: (connection: ApprovalHookConnection) => void): void {
        accept = handler;
        for (const connection of waiting.splice(0)) handler(connection);
      },
      close(): void {
        server.close();
      },
    },
  };
}

/**
 * The disk under a launch's settings file, beside the socket it points at.
 *
 * Owner-only, both the folder and the file: it names a socket and carries a
 * secret, and anything that can read it can present that secret as the launch
 * it belongs to. Written in place rather than through a temporary and a rename,
 * unlike the grants file: nothing reads this but the agent this server is about
 * to start, and it is started after the write returns.
 */
export const nodeApprovalFiles: ApprovalFileSystem = {
  async write(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
  },

  async removeDirectory(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  },
};

/**
 * Removes every launch folder a previous process left behind.
 *
 * A launch's folder goes when its agent's process ends, and a server that was
 * killed never saw that end: each folder it left holds a secret that died with
 * it. Nothing can be using one -- this runs before any gate, launch or session
 * exists -- so every one of them is litter.
 *
 * Never a reason not to open. An entry that will not go costs itself and the
 * rest are still tried, and a directory that cannot be listed leaves the litter
 * where it is: approvals are worth more than a tidy folder.
 */
async function sweepLaunches(directory: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => name.startsWith(APPROVAL_LAUNCH_PREFIX))
      .map((name) =>
        rm(join(directory, name), { recursive: true, force: true }).catch(() => undefined),
      ),
  );
}

function listen(socketPath: string): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      // From here on an error is one connection's problem and not the
      // listener's: a socket that faults mid-read ends that hook's wait, and
      // an unhandled `error` event would end the process.
      server.on('error', () => undefined);
      resolve(server);
    });
  });
}

/**
 * Reads exactly one line, then stops.
 *
 * Nothing after the newline is read, because there is nothing after it: a hook
 * says one thing and then waits. A connection that reaches the bound without
 * producing a line is destroyed rather than handed on -- the gate's refusals
 * are silences toward the hook, and so is this one.
 */
function readLine(socket: Socket, deliver: (line: string) => void): void {
  socket.setEncoding('utf8');
  let read = '';
  let delivered = false;

  socket.on('data', (chunk: string) => {
    if (delivered) return;
    read += chunk;
    const newline = read.indexOf('\n');
    if (newline === -1) {
      if (Buffer.byteLength(read, 'utf8') > APPROVAL_LINE_MAX_BYTES) socket.destroy();
      return;
    }
    delivered = true;
    deliver(read.slice(0, newline));
  });

  // A hook that closed without sending a line is a hook that is no longer
  // waiting, so there is nothing to hand over and nobody to answer.
  socket.on('error', () => void socket.destroy());
}

function hookConnection(socket: Socket, line: string): ApprovalHookConnection {
  // Latched from the moment the line arrived, because the gate may not ask for
  // this connection until later: a hook that hung up while it waited would
  // otherwise have closed before anybody was listening, and nobody would learn.
  let closed = false;
  socket.once('close', () => void (closed = true));

  return {
    sent: line,
    write(answer: string): void {
      socket.write(answer);
    },
    close(): void {
      // `end` and not `destroy`: the answer is in the kernel's buffer and the
      // hook is still reading. A destroy here would settle an approval on this
      // side and deliver nothing on the other.
      socket.end();
    },
    onClose(handler: () => void): void {
      // Deferred and not called in place: the gate registers this before it
      // announces the request, and a withdrawal must never overtake it.
      if (closed) queueMicrotask(handler);
      else socket.once('close', handler);
    },
  };
}
