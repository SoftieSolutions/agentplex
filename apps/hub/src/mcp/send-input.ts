import {
  TERMINAL_INPUT_MAX_CHARS,
  type ClientTerminalTarget,
  type FrameId,
  type HubFrame,
} from '@agentplex/protocol';
import type { Logger } from '@agentplex/node-shared';
import { z } from 'zod';
import type { TerminalClient } from '../terminal/terminal.js';
import { parsedSessionRef } from './session-args.js';
import { acts, answers, defineMcpTool, refuses, type McpTool } from './tool-registry.js';

/**
 * Typing into a session, through the relay, as an in-process client.
 *
 * ## A prompt is typed input and nothing else
 *
 * This is the tool an agent uses to say something to another agent, and it is
 * deliberately not called `send_prompt`, because there is no prompt frame in
 * this protocol and inventing one here would be inventing a second way to talk
 * to a terminal. The web's steer bar already made this decision and wrote it on
 * the screen: the words a person types into it are sent as keystrokes with
 * Enter after them, through the one input path. This tool is that bar, called
 * by something that is not a person.
 *
 * What that buys is that nothing downstream has a second case. The relay routes
 * it to the holder, the server writes it to the pty, and the program on the far
 * end cannot tell -- and must not be able to tell -- whether a hand or a model
 * typed it.
 *
 * ## Its own client identity, per call
 *
 * The relay keys everything by client object: a start handle belongs to the
 * socket that made it, and a target is resolved against that socket's own map.
 * So each call builds a `TerminalClient` and gives it back when it is done,
 * exactly as `read_terminal` does. `forget` is the release rather than a
 * detach, because this client is never coming back and a key left in the
 * relay's books would be one per call.
 *
 * Addressing is by session and never by a start handle. A handle names a start
 * *this connection* made, and this connection is one function call: an agent
 * that has just started a session waits for `list_sessions` to name it, which
 * is the same wait a person watching a pending pane is doing.
 *
 * ## What "sent" claims, and what it does not
 *
 * That the hub put the keystrokes to the machine holding the terminal. Not that
 * the program read them, because nothing on this protocol says so: input is
 * answered only when it fails, and a terminal acknowledges a keystroke by
 * echoing it. A browser can act on that -- the echo lands in the pane the
 * person is already looking at -- and an MCP caller cannot, so the honest thing
 * is to say what was put where and to name `read_terminal` as the thing that
 * says what came of it.
 *
 * Every refusal the hub itself can make arrives before this answers: a store
 * nobody has mounted, a session no machine reports, a machine that cannot be
 * reached, a pairing that is gone. Those are decided against the hub's own
 * state in the same turn as the call. A refusal from the holding machine --
 * which by then has the frame and is declining it -- arrives after this has
 * answered, and is logged rather than lost, because there is no longer a call
 * to return it to.
 */

/** What this tool needs of the relay: type, and give the client back. */
export interface TerminalWrites {
  input(client: TerminalClient, replyTo: FrameId, target: ClientTerminalTarget, data: string): void;
  forget(client: TerminalClient): void;
}

export interface SendInputDependencies {
  readonly terminal: TerminalWrites;
  /** Where a refusal that arrives after the answer goes, rather than nowhere. */
  readonly logger: Logger;
}

export function sendInputTool({ terminal, logger }: SendInputDependencies): McpTool {
  return defineMcpTool({
    name: 'send_input',
    description:
      'Types into a session, as a person typing at its terminal would. This is how a prompt is sent: the text, and a carriage return unless you ask for none. Read what came of it with read_terminal.',
    input: {
      storeId: z.string().describe('The store the session is filed under.'),
      sessionId: z.string().describe('The session id, as list_sessions returns it.'),
      text: z
        .string()
        .min(1)
        .max(TERMINAL_INPUT_MAX_CHARS)
        .describe(
          `What to type, verbatim. Control characters are typed as control characters: this is a keyboard, not a message. At most ${String(TERMINAL_INPUT_MAX_CHARS)} characters.`,
        ),
      newline: z
        .boolean()
        .default(true)
        .describe(
          'Whether to end with a carriage return, which is what Enter sends. True by default, because a prompt that is never submitted is a prompt the agent is still waiting for. Set it false to type keys that must not submit.',
        ),
    },
    output: {
      storeId: z.string(),
      sessionId: z.string(),
      characters: z
        .int()
        .describe(
          'How many characters were put to the machine holding the terminal, the carriage return included when one was added. It does not say the program has read them; read_terminal says that.',
        ),
      chunks: z
        .int()
        .describe(
          'How many terminal-input frames it took, in order. More than one only when the text is at the protocol bound.',
        ),
    },
    annotations: acts,
    run: ({ storeId, sessionId, text, newline }) => {
      const ref = parsedSessionRef(storeId, sessionId);
      if (!ref.ok) return ref;

      const target: ClientTerminalTarget = { by: 'session', ...ref.value };
      const payload = newline ? `${text}\r` : text;
      const chunks = inChunks(payload, TERMINAL_INPUT_MAX_CHARS);

      let refused: string | null = null;
      let answered = false;

      const client: TerminalClient = {
        // Nothing is buffered: this client is a function call. The relay reads
        // this to decide whether a socket is too far behind to be sent live
        // output, and there is no socket and nothing live being read.
        bufferedBytes: 0,
        send(frame: HubFrame): void {
          // A refusal is the only frame this client can be sent -- it
          // subscribes to nothing -- and every other frame the hub can put to a
          // client is not an answer to a keystroke.
          if (frame.type !== 'refusal') return;
          if (!answered) {
            refused = frame.message;
            return;
          }
          // The machine had the frame and declined it, after this call had
          // answered. There is nothing left to return it to, so it goes where
          // whoever is reading this hub's log will find it.
          logger.warn('a machine refused input after the tool had answered', {
            storeId,
            sessionId,
            problem: frame.message,
          });
        },
      };

      let sent = 0;
      try {
        for (const [at, chunk] of chunks.entries()) {
          // Numbered from one, so a refusal names the chunk it answers. A frame
          // id is unique within a connection and this client is one connection:
          // it is built for one call and forgotten.
          terminal.input(client, at + 1, target, chunk);
          // Every no the hub makes for itself is made in the turn that read the
          // call, so a second chunk after a first was refused would be
          // keystrokes put nowhere twice.
          if (refused !== null) break;
          sent += chunk.length;
        }
      } finally {
        answered = true;
        terminal.forget(client);
      }

      if (refused !== null) return refuses(refused);
      return answers({ storeId, sessionId, characters: sent, chunks: chunks.length });
    },
  });
}

/**
 * The payload as frames, in order.
 *
 * One frame is the ordinary case and the loop never runs for it. The split
 * exists because the carriage return is added here: text of exactly the bound
 * plus a return is one character over what the protocol will carry, and a frame
 * a server refuses to parse is a worse answer than two frames.
 *
 * Cut on code points rather than on units of a string, so a split can never
 * land between the halves of a surrogate pair and put half a character on the
 * wire. The pty has no opinion about where a write ends; a broken code point is
 * something only this side can cause.
 */
function inChunks(text: string, max: number): readonly string[] {
  if (text.length <= max) return [text];

  const chunks: string[] = [];
  let current = '';
  for (const character of text) {
    if (current.length + character.length > max) {
      chunks.push(current);
      current = '';
    }
    current += character;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
