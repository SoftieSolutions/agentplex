import {
  sessionIdSchema,
  storeIdSchema,
  TERMINAL_INPUT_MAX_CHARS,
  type ClientTerminalTarget,
  type FrameId,
} from '@agentplex/protocol';
import { createLogger, type LogRecord } from '@agentplex/node-shared';
import { describe, expect, it } from 'vitest';
import type { TerminalClient } from '../terminal/terminal.js';
import { sendInputTool, type TerminalWrites } from './send-input.js';
import { callTool, type ToolCall } from './test-tool-call.js';

/**
 * `send_input`, against a relay that records what it was typed into.
 *
 * The seam is two methods -- type, and give the client back -- so the stand-in
 * below is a few lines rather than the relay's own fake, which records a call
 * and answers nothing and therefore cannot refuse. What crosses the real relay,
 * the real server end and a real pty is the `tests/hub-server` scenario; what is
 * here is everything this tool decides for itself: what is typed, in how many
 * frames, what a refusal becomes, and where one that arrives too late goes.
 */

const WORK = storeIdSchema.parse('store-work');
const QUIET = sessionIdSchema.parse('session-quiet');

interface Typed {
  readonly client: TerminalClient;
  readonly replyTo: FrameId;
  readonly target: ClientTerminalTarget;
  readonly data: string;
}

interface StubTerminal extends TerminalWrites {
  readonly typed: readonly Typed[];
  readonly forgotten: readonly TerminalClient[];
}

interface Taking {
  /** A relay refusal instead of a delivery. */
  readonly refusal?: string;
  /**
   * Whether it arrives in a later turn.
   *
   * Which is what a refusal from the holding machine actually looks like: the
   * hub's own refusals are decided against its state in the turn that read the
   * call, and a machine that has the frame and declines it answers over a
   * socket.
   */
  readonly late?: boolean;
}

function relayTaking(options: Taking = {}): StubTerminal {
  const typed: Typed[] = [];
  const forgotten: TerminalClient[] = [];

  return {
    input(
      client: TerminalClient,
      replyTo: FrameId,
      target: ClientTerminalTarget,
      data: string,
    ): void {
      typed.push({ client, replyTo, target, data });
      const problem = options.refusal;
      if (problem === undefined) return;

      const refuse = (): void =>
        client.send({ type: 'refusal', replyTo, code: 'refused', message: problem, holder: null });
      if (options.late === true) setImmediate(refuse);
      else refuse();
    },
    forget(client: TerminalClient): void {
      forgotten.push(client);
    },
    get typed(): readonly Typed[] {
      return typed;
    },
    get forgotten(): readonly TerminalClient[] {
      return forgotten;
    },
  };
}

function typing(
  terminal: TerminalWrites,
  args: Record<string, unknown> = {},
  records: LogRecord[] = [],
): Promise<ToolCall> {
  return callTool(
    sendInputTool({
      terminal,
      logger: createLogger('debug', (record) => void records.push(record)),
    }),
    { storeId: WORK, sessionId: QUIET, text: 'run the tests', ...args },
  );
}

interface Sent {
  readonly storeId: string;
  readonly sessionId: string;
  readonly characters: number;
  readonly chunks: number;
}

describe('send_input', () => {
  it('types the text and a return, which is what the steer bar sends', async () => {
    const relay = relayTaking();

    const answered = (await typing(relay)).structured as unknown as Sent;

    // A prompt is typed input and nothing else. There is no prompt frame in
    // this protocol and this tool does not invent one: the words go to the pty
    // the way a person's do, with Enter after them.
    expect(relay.typed.map((call) => call.data)).toEqual(['run the tests\r']);
    expect(relay.typed[0]?.target).toEqual({ by: 'session', storeId: WORK, sessionId: QUIET });
    expect(answered).toEqual({
      storeId: WORK,
      sessionId: QUIET,
      characters: 14,
      chunks: 1,
    });
  });

  it('types exactly what it was given when the caller says no return', async () => {
    const relay = relayTaking();

    await typing(relay, { text: 'y', newline: false });

    // The keyboard case: a program already waiting on one key gets one key.
    expect(relay.typed.map((call) => call.data)).toEqual(['y']);
  });

  it('addresses the terminal by the session and never by a start handle', async () => {
    const relay = relayTaking();

    await typing(relay);

    // A start handle names a start the asking connection made, and this
    // connection is one function call. An agent that has just started a session
    // waits for list_sessions to name it, which is the wait a person watching a
    // pending pane is already doing.
    expect(relay.typed[0]?.target.by).toBe('session');
  });

  it('hands back the relay refusal, in the relay words', async () => {
    const relay = relayTaking({ refusal: 'the hub cannot reach attic right now' });

    const result = await typing(relay);

    expect(result.isError).toBe(true);
    expect(result.structured).toBeUndefined();
    // The relay's sentence, which names the machine. A blank answer and a
    // sleeping laptop look identical from an agent's side; the words are the
    // difference.
    expect(result.text).toBe('the hub cannot reach attic right now');
  });

  it('gives the client back, so the relay is not left a key per call', async () => {
    const relay = relayTaking();

    await typing(relay);

    expect(relay.forgotten).toHaveLength(1);
    expect(relay.forgotten[0]).toBe(relay.typed[0]?.client);
  });

  it('gives the client back after a refusal too', async () => {
    const relay = relayTaking({ refusal: 'no server the hub can see reports that session' });

    await typing(relay);

    expect(relay.forgotten).toHaveLength(1);
  });

  it('is its own client each call, because a client is a connection here', async () => {
    const relay = relayTaking();

    await typing(relay);
    await typing(relay);

    expect(relay.typed[0]?.client).not.toBe(relay.typed[1]?.client);
  });

  it('splits a payload the protocol cannot carry on one frame, in order', async () => {
    const relay = relayTaking();
    const text = 'x'.repeat(TERMINAL_INPUT_MAX_CHARS);

    const answered = (await typing(relay, { text })).structured as unknown as Sent;

    // The text is exactly what one frame may carry, and the return makes it one
    // character too many. Two frames in order rather than one the server would
    // refuse to parse -- and the second is the return, so nothing typed arrives
    // out of the order it was typed in.
    expect(relay.typed.map((call) => call.data)).toEqual([text, '\r']);
    expect(relay.typed.map((call) => call.replyTo)).toEqual([1, 2]);
    expect(answered.chunks).toBe(2);
    expect(answered.characters).toBe(TERMINAL_INPUT_MAX_CHARS + 1);
  });

  it('stops after a refused frame rather than typing the rest of it', async () => {
    const relay = relayTaking({ refusal: 'no server the hub can see reports that session' });

    const result = await typing(relay, { text: 'x'.repeat(TERMINAL_INPUT_MAX_CHARS) });

    expect(result.isError).toBe(true);
    expect(relay.typed).toHaveLength(1);
  });

  it('refuses text longer than a frame may carry, against the published schema', async () => {
    const relay = relayTaking();

    const result = await typing(relay, { text: 'x'.repeat(TERMINAL_INPUT_MAX_CHARS + 1) });

    expect(result.isError).toBe(true);
    expect(relay.typed).toHaveLength(0);
  });

  it('refuses an id that is not one, before anything is put to a machine', async () => {
    const relay = relayTaking();

    const result = await typing(relay, { storeId: '' });

    expect(result.isError).toBe(true);
    expect(result.text).toBe('a store id and a session id are each one to two hundred characters');
    expect(relay.typed).toHaveLength(0);
  });

  it('logs a refusal that arrives after it has answered, rather than losing it', async () => {
    const records: LogRecord[] = [];
    const relay = relayTaking({
      refusal: 'this server has no terminal for that session',
      late: true,
    });

    const result = await typing(relay, {}, records);
    await new Promise((resolve) => setImmediate(resolve));

    // Input is answered only when it fails, and a failure from the holding
    // machine is a round trip away: by the time it arrives there is no call
    // left to return it to. So the call says what was put where, and the
    // machine's own words go where whoever is reading this hub's log will find
    // them.
    expect(result.isError).toBe(false);
    const late = records.find(
      (record) => record.message === 'a machine refused input after the tool had answered',
    );
    expect(late?.fields).toMatchObject({
      storeId: WORK,
      sessionId: QUIET,
      problem: 'this server has no terminal for that session',
    });
  });

  it('says it changes something, and that it destroys nothing', () => {
    const tool = sendInputTool({
      terminal: relayTaking(),
      logger: createLogger('error', () => {}),
    });

    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });
});
