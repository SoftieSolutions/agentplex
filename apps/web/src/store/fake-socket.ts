import type { StoreSocket } from './hub-store.js';

/**
 * A `StoreSocket` a test drives by hand: it records what the store sent and
 * lets the test play the hub — open the socket, deliver captured frames, drop
 * the connection. No network, no timers of its own.
 */
export interface FakeSocket extends StoreSocket {
  /** Every text the store sent, in order. */
  readonly sent: readonly string[];
  /** The server end accepting the connection. */
  open(): void;
  /** The server end delivering one frame. */
  deliver(text: string): void;
  /** The connection ending from the far side (or the network). */
  drop(): void;
  /** Whether the store hung up on purpose. */
  readonly closedByStore: boolean;
}

/**
 * Builds sockets for `createHubStore` and keeps every one it built, so a test
 * can assert how many dials happened and drive each connection separately.
 */
export interface FakeSocketFactory {
  create(ticket: string): StoreSocket;
  readonly sockets: readonly FakeSocket[];
  /** The ticket each dial presented, in order. */
  readonly tickets: readonly string[];
}

export function createFakeSocketFactory(): FakeSocketFactory {
  const sockets: FakeSocket[] = [];
  const tickets: string[] = [];

  return {
    create(ticket: string): StoreSocket {
      tickets.push(ticket);
      const sent: string[] = [];
      let onOpen: (() => void) | null = null;
      let onMessage: ((text: string) => void) | null = null;
      let onClose: (() => void) | null = null;
      let ended = false;
      let closedByStore = false;

      const socket: FakeSocket = {
        send(text: string): void {
          sent.push(text);
        },
        close(): void {
          if (ended) return;
          ended = true;
          closedByStore = true;
          onClose?.();
        },
        onOpen(fire: () => void): void {
          onOpen = fire;
        },
        onMessage(fire: (text: string) => void): void {
          onMessage = fire;
        },
        onClose(fire: () => void): void {
          onClose = fire;
        },
        get sent(): readonly string[] {
          return [...sent];
        },
        open(): void {
          onOpen?.();
        },
        deliver(text: string): void {
          onMessage?.(text);
        },
        drop(): void {
          if (ended) return;
          ended = true;
          onClose?.();
        },
        get closedByStore(): boolean {
          return closedByStore;
        },
      };
      sockets.push(socket);
      return socket;
    },
    get sockets(): readonly FakeSocket[] {
      return [...sockets];
    },
    get tickets(): readonly string[] {
      return [...tickets];
    },
  };
}
