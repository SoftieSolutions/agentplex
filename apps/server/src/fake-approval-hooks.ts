import type { ApprovalHookConnection, ApprovalHookListener } from './approval-gate.js';

/**
 * The hook side of the gate, as a test supplies it.
 *
 * A unix socket is the one thing a unit test cannot open, and it is also the
 * one thing none of the rules are about: what the gate does with a line, who is
 * answered, who is refused and what a client is told happened are all on this
 * side of the seam. So everything above `node-approval-listener.ts` is driven
 * through these, and the socket has one test of its own.
 *
 * Here rather than inside one suite because two of them need it -- the gate's
 * own, and the connection tests that assert a blocked hook reaches a hub as a
 * frame and a decision reaches it back.
 */

export interface FakeHookConnection {
  readonly connection: ApprovalHookConnection;
  /** Everything written toward the hook, in order. Empty is a refusal. */
  readonly writes: readonly string[];
  readonly closed: boolean;
  /** The hook's process went away before anything answered it. */
  disconnect(): void;
}

export interface FakeApprovalListener extends ApprovalHookListener {
  /** A hook has connected and sent its line. */
  present(connection: ApprovalHookConnection): void;
  readonly closed: boolean;
}

/**
 * One hook, blocked, with the line it sent already read.
 *
 * `onWrite` fires before the write is recorded, which is what lets a test make
 * a decision arrive in the middle of another one.
 */
export function createFakeHookConnection(line: string, onWrite?: () => void): FakeHookConnection {
  const writes: string[] = [];
  const closers: (() => void)[] = [];
  let closed = false;
  return {
    connection: {
      sent: line,
      write(answer: string): void {
        onWrite?.();
        writes.push(answer);
      },
      close(): void {
        closed = true;
      },
      onClose(handler: () => void): void {
        closers.push(handler);
      },
    },
    writes,
    get closed(): boolean {
      return closed;
    },
    disconnect(): void {
      closed = true;
      for (const handler of closers) handler();
    },
  };
}

export function createFakeApprovalListener(): FakeApprovalListener {
  let accept: ((connection: ApprovalHookConnection) => void) | null = null;
  let closed = false;
  return {
    onConnection(handler): void {
      accept = handler;
    },
    close(): void {
      closed = true;
    },
    present(connection): void {
      if (accept === null) throw new Error('the gate never asked for connections');
      accept(connection);
    },
    get closed(): boolean {
      return closed;
    },
  };
}

/** The line a hook sends: the secret it was launched with and the provider's bytes. */
export function hookLine(secret: string, payload: string): string {
  return JSON.stringify({ secret, payload });
}
