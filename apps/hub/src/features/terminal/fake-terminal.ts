import type {
  ClientTerminalTarget,
  FrameId,
  ServerRegistrationId,
  SessionStartTag,
  StoreId,
  TerminalSize,
} from '@agentplex/protocol';
import type { TerminalOutputFrame } from '../servers/servers.js';
import type { ClientStart, Terminal, TerminalClient } from './terminal.js';

/**
 * The relay, recorded rather than run.
 *
 * The client connection's job with a terminal frame is to hand it over: it
 * decides that the peer has said hello and that the frame is one of these, and
 * everything after that belongs to the relay. So what a suite about the socket
 * needs is a seam that remembers what it was handed, and what a suite about the
 * relay needs is the real thing with a fake server under it -- which is the
 * split every fake in this codebase is drawn along.
 *
 * It answers nothing. A relay that replied here would make a socket suite quietly
 * dependent on the relay's behaviour, which is the coupling the two suites exist
 * to avoid; the frames a client is actually sent are asserted where they are
 * produced.
 */
export interface FakeTerminalCall {
  readonly client: TerminalClient;
  readonly replyTo: FrameId;
  readonly target: ClientTerminalTarget;
}

export interface FakeTerminal extends Terminal {
  readonly subscribed: readonly FakeTerminalCall[];
  readonly unsubscribed: readonly FakeTerminalCall[];
  readonly typed: readonly (FakeTerminalCall & { readonly data: string })[];
  readonly resized: readonly (FakeTerminalCall & { readonly size: TerminalSize })[];
  readonly noted: readonly { readonly handle: FrameId; readonly start: ClientStart }[];
  /** Every client this was told had gone away, in order. */
  readonly forgotten: readonly TerminalClient[];
}

export function createFakeTerminal(): FakeTerminal {
  const subscribed: FakeTerminalCall[] = [];
  const unsubscribed: FakeTerminalCall[] = [];
  const typed: (FakeTerminalCall & { data: string })[] = [];
  const resized: (FakeTerminalCall & { size: TerminalSize })[] = [];
  const noted: { handle: FrameId; start: ClientStart }[] = [];
  const forgotten: TerminalClient[] = [];

  return {
    subscribe(client: TerminalClient, replyTo: FrameId, target: ClientTerminalTarget): void {
      subscribed.push({ client, replyTo, target });
    },
    unsubscribe(client: TerminalClient, replyTo: FrameId, target: ClientTerminalTarget): void {
      unsubscribed.push({ client, replyTo, target });
    },
    input(
      client: TerminalClient,
      replyTo: FrameId,
      target: ClientTerminalTarget,
      data: string,
    ): void {
      typed.push({ client, replyTo, target, data });
    },
    resize(
      client: TerminalClient,
      replyTo: FrameId,
      target: ClientTerminalTarget,
      size: TerminalSize,
    ): void {
      resized.push({ client, replyTo, target, size });
    },
    noteStart(_client: TerminalClient, handle: FrameId, start: ClientStart): void {
      noted.push({ handle, start });
    },
    noteStarts(
      _registrationId: ServerRegistrationId,
      _storeId: StoreId,
      _starts: readonly SessionStartTag[],
    ): void {},
    deliver(_registrationId: ServerRegistrationId, _output: TerminalOutputFrame): void {},
    forget(client: TerminalClient): void {
      forgotten.push(client);
    },

    get subscribed(): readonly FakeTerminalCall[] {
      return subscribed;
    },
    get unsubscribed(): readonly FakeTerminalCall[] {
      return unsubscribed;
    },
    get typed(): readonly (FakeTerminalCall & { readonly data: string })[] {
      return typed;
    },
    get resized(): readonly (FakeTerminalCall & { readonly size: TerminalSize })[] {
      return resized;
    },
    get noted(): readonly { readonly handle: FrameId; readonly start: ClientStart }[] {
      return noted;
    },
    get forgotten(): readonly TerminalClient[] {
      return forgotten;
    },
  };
}
