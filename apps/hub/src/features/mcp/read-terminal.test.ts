import {
  encodeTerminalChunk,
  sessionIdSchema,
  storeIdSchema,
  type ClientTerminalTarget,
  type FrameId,
} from '@agentplex/protocol';
import { createFakeTimers, type FakeTimers } from '@agentplex/node-shared/testing';
import { describe, expect, it } from 'vitest';
import type { TerminalClient } from '../terminal/terminal.js';
import { readTerminalTool, READ_TERMINAL_TIMEOUT_MS, type TerminalReads } from './read-terminal.js';
import { callTool, type ToolCall } from './test-tool-call.js';

/**
 * `read_terminal`, against a relay that replays what it is told to.
 *
 * The seam is two methods -- subscribe, and give the subscription back -- so
 * the stand-in below is a few lines rather than the relay's own fake, which
 * answers nothing and therefore cannot replay anything. What crosses the real
 * relay, the real server end and a real scrollback is the `tests/hub-server`
 * scenario; what is here is everything this tool decides for itself: when a
 * replay is complete, where the trim falls, what the bytes become, and what
 * happens when nobody answers.
 */

const WORK = storeIdSchema.parse('store-work');
const QUIET = sessionIdSchema.parse('session-quiet');
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

interface Replaying {
  /** What the subscription is answered with, oldest chunk first. */
  readonly chunks?: readonly Uint8Array[];
  readonly droppedBytes?: number;
  /** A relay refusal instead of a subscription. */
  readonly refusal?: string;
  /** Neither: a machine that took the subscribe and said nothing. */
  readonly silent?: boolean;
}

interface StubTerminal extends TerminalReads {
  readonly subscribers: readonly TerminalClient[];
  readonly forgotten: readonly TerminalClient[];
}

/**
 * A relay that answers a subscription and nothing else.
 *
 * Each frame goes out in its own turn of the loop, which is the thing worth
 * copying from the real one: a subscription's reply and the history it counted
 * arrive as separate frames off a socket, so a tool that read the reply and
 * returned would return an empty transcript.
 */
function relayReplaying(options: Replaying): StubTerminal {
  const subscribers: TerminalClient[] = [];
  const forgotten: TerminalClient[] = [];

  return {
    subscribe(client: TerminalClient, replyTo: FrameId, target: ClientTerminalTarget): void {
      subscribers.push(client);
      if (options.silent === true) return;

      const aimed = target.by === 'session' ? target : null;
      const storeId = aimed?.storeId ?? WORK;
      const sessionId = aimed?.sessionId ?? QUIET;

      if (options.refusal !== undefined) {
        setImmediate(() =>
          client.send({
            type: 'refusal',
            replyTo,
            code: 'refused',
            message: options.refusal ?? '',
            holder: null,
          }),
        );
        return;
      }

      const chunks = options.chunks ?? [];
      setImmediate(() => {
        client.send({
          type: 'session-subscribed',
          replyTo,
          storeId,
          sessionId,
          startId: null,
          replayChunks: chunks.length,
          droppedBytes: options.droppedBytes ?? 0,
        });
        for (const chunk of chunks) {
          setImmediate(() =>
            client.send({
              type: 'terminal-output',
              storeId,
              sessionId,
              startId: null,
              chunk: encodeTerminalChunk(chunk),
              droppedChunks: 0,
            }),
          );
        }
      });
    },
    forget(client: TerminalClient): void {
      forgotten.push(client);
    },
    get subscribers(): readonly TerminalClient[] {
      return subscribers;
    },
    get forgotten(): readonly TerminalClient[] {
      return forgotten;
    },
  };
}

function reading(
  terminal: TerminalReads,
  args: Record<string, unknown> = {},
  timers: FakeTimers = createFakeTimers(),
): Promise<ToolCall> {
  return callTool(readTerminalTool({ terminal, timers }), {
    storeId: WORK,
    sessionId: QUIET,
    ...args,
  });
}

interface Transcript {
  readonly text: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly droppedBytes: number;
}

async function settle(until: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200; turn += 1) {
    if (until()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('the tool never got as far as subscribing');
}

describe('read_terminal', () => {
  it('waits for the history the subscription promised, and returns it as text', async () => {
    const relay = relayReplaying({
      chunks: [bytes('building\r\n'), bytes('still building\r\n'), bytes('done\r\n')],
    });

    const result = await reading(relay);

    const answered = result.structured as unknown as Transcript;
    expect(answered.text).toBe('building\r\nstill building\r\ndone\r\n');
    expect(answered.bytes).toBe(32);
    expect(answered.truncated).toBe(false);
    // The text block is the transcript itself and not JSON of it. A terminal's
    // own output escaped into a string is the thing the caller asked for, made
    // unreadable.
    expect(result.text).toBe('building\r\nstill building\r\ndone\r\n');
  });

  it('answers a session that has printed nothing, rather than waiting for a chunk', async () => {
    const relay = relayReplaying({ chunks: [] });

    const answered = (await reading(relay)).structured as unknown as Transcript;

    expect(answered.text).toBe('');
    expect(answered.bytes).toBe(0);
    expect(answered.truncated).toBe(false);
  });

  it('trims to the last maxBytes on whole-chunk boundaries', async () => {
    const relay = relayReplaying({
      // Ten bytes each. A cut inside one would fall inside whatever escape
      // sequence the program was halfway through writing.
      chunks: [bytes('0123456789'), bytes('abcdefghij'), bytes('klmnopqrst')],
    });

    const answered = (await reading(relay, { maxBytes: 25 })).structured as unknown as Transcript;

    expect(answered.text).toBe('abcdefghijklmnopqrst');
    expect(answered.bytes).toBe(20);
    expect(answered.truncated).toBe(true);
  });

  it('returns the end and not the beginning', async () => {
    const relay = relayReplaying({ chunks: [bytes('oldest'), bytes('newest')] });

    const answered = (await reading(relay, { maxBytes: 6 })).structured as unknown as Transcript;

    expect(answered.text).toBe('newest');
    expect(answered.truncated).toBe(true);
  });

  it('returns a chunk larger than the bound whole, rather than nothing at all', async () => {
    // The one case where the boundary wins over the bound. Cutting inside the
    // chunk would break the rule; dropping it would answer a question about a
    // busy session with an empty string. `bytes` says what actually came back.
    const relay = relayReplaying({ chunks: [bytes('a hundred and one characters or so')] });

    const answered = (await reading(relay, { maxBytes: 4 })).structured as unknown as Transcript;

    expect(answered.text).toBe('a hundred and one characters or so');
    expect(answered.bytes).toBe(34);
  });

  it('decodes bytes no emulator would have minded, replacing what is not text', async () => {
    // Box drawing, an emoji past the basic plane, and two bytes that are half a
    // code point -- which is what a chunk boundary looks like from the outside.
    // This is the one place in the system that decodes terminal output, and it
    // does it in the direction that cannot fail.
    const drawn = new Uint8Array([...bytes('[1m┌──┐ \u{1f642}[0m\r\n'), 0xf0, 0x9f]);
    const relay = relayReplaying({ chunks: [drawn] });

    const answered = (await reading(relay)).structured as unknown as Transcript;

    // The escape sequences survive: they are what the program wrote, and an
    // agent reading a transcript is reading what was printed.
    expect(answered.text).toContain('[1m┌──┐ \u{1f642}[0m');
    expect(answered.text.endsWith('�')).toBe(true);
    expect(answered.bytes).toBe(drawn.length);
  });

  it('carries what the terminal had already evicted before the replay begins', async () => {
    const relay = relayReplaying({ chunks: [bytes('the last of it')], droppedBytes: 4_096 });

    const answered = (await reading(relay)).structured as unknown as Transcript;

    // The hub knows nothing about how much history exists; this is the holding
    // machine's own number, passed through, and it is what stops a bounded read
    // reading as a whole session.
    expect(answered.droppedBytes).toBe(4_096);
  });

  it('gives the subscription back, so the machine stops being watched', async () => {
    const relay = relayReplaying({ chunks: [bytes('done\r\n')] });

    await reading(relay);

    expect(relay.forgotten).toHaveLength(1);
    expect(relay.forgotten[0]).toBe(relay.subscribers[0]);
  });

  it('is its own client each call, because one client may not watch one terminal twice', async () => {
    const relay = relayReplaying({ chunks: [bytes('once\r\n')] });

    await reading(relay);
    await reading(relay);

    // Two calls are two clients. The relay refuses a second subscription from
    // one client -- correctly, since a second subscribe asks for a second
    // replay -- so a shared identity would make the second call a refusal.
    expect(relay.subscribers).toHaveLength(2);
    expect(relay.subscribers[0]).not.toBe(relay.subscribers[1]);
  });

  it('hands back the relay refusal, in the relay words', async () => {
    const relay = relayReplaying({ refusal: 'attic is not connected' });

    const result = await reading(relay);

    expect(result.isError).toBe(true);
    expect(result.text).toBe('attic is not connected');
    expect(result.structured).toBeUndefined();
    // And the subscription is given back even though there was nothing to give:
    // the client is gone either way, and a key left in the relay's books would
    // be one per refused call.
    expect(relay.forgotten).toHaveLength(1);
  });

  it('refuses in a sentence when the machine never answers, rather than never returning', async () => {
    const relay = relayReplaying({ silent: true });
    const timers = createFakeTimers();

    const pending = reading(relay, {}, timers);
    await settle(() => timers.pending > 0);
    timers.fireAll();
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(result.text).toContain(String(READ_TERMINAL_TIMEOUT_MS));
    expect(relay.forgotten).toHaveLength(1);
  });

  it('cancels its deadline once it has an answer', async () => {
    const timers = createFakeTimers();
    const relay = relayReplaying({ chunks: [bytes('done\r\n')] });

    await reading(relay, {}, timers);

    // A timer left pending would be one per call, and a fake one firing later
    // would settle a promise nobody is waiting on any more.
    expect(timers.pending).toBe(0);
  });

  it('refuses an id that is not one, before anything is asked of a machine', async () => {
    const relay = relayReplaying({ chunks: [] });

    const result = await reading(relay, { storeId: '' });

    expect(result.isError).toBe(true);
    // A sentence rather than whatever a parser would have thrown. Refusals are
    // values here, and this is the one place a string off a model becomes an id.
    expect(result.text).toBe('a store id and a session id are each one to two hundred characters');
    expect(relay.subscribers).toHaveLength(0);
  });

  it('says it only reads', () => {
    const tool = readTerminalTool({
      terminal: relayReplaying({ chunks: [] }),
      timers: createFakeTimers(),
    });

    expect(tool.annotations).toEqual({ readOnlyHint: true });
  });
});
