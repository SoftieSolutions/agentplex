import { describe, expect, it } from 'vitest';
import {
  runApprovalHook,
  APPROVAL_ANSWER_MAX_BYTES,
  APPROVAL_SECRET_VARIABLE,
  APPROVAL_SOCKET_VARIABLE,
  type ApprovalHookChannel,
} from './approval-hook.js';
import { encodeClaudePermissionAnswer } from '@agentplex/providers';

/**
 * The hook, driven against a listener this file wrote down.
 *
 * Every case here ends the same way -- exit zero, and either the gate's answer
 * on stdout or nothing at all -- because that is the whole contract with the
 * provider: an empty stdout means no decision was made, the tool call falls
 * through as though no hook had run, and the person is asked at their terminal.
 * A hook that failed loudly would block an agent on a broken socket; a hook
 * that invented an answer would decide something nobody was asked about.
 */

const SOCKET = '/var/lib/agentplex/approvals.sock';
const SECRET = 'the-launch-secret';
const PAYLOAD = JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' });

const ALLOW = encodeClaudePermissionAnswer({ behavior: 'allow' });

interface Listener {
  /** Every line the hook sent, as it sent it. */
  readonly sent: readonly string[];
  /** How many times the hook opened a connection. */
  readonly connects: number;
  readonly closed: boolean;
}

interface Run {
  readonly printed: string;
  readonly listener: Listener;
}

/**
 * Runs the hook against a listener that answers with whatever it was given.
 *
 * `answer: null` is the refusal every rule in the gate is written as: the
 * connection is closed with nothing written on it.
 */
async function run(
  options: {
    answer?: string | null;
    refuseConnection?: string;
    environment?: Record<string, string | undefined>;
    payload?: string | (() => Promise<string>);
  } = {},
): Promise<Run> {
  const sent: string[] = [];
  let connects = 0;
  let closed = false;
  let printed = '';

  const channel: ApprovalHookChannel = {
    send(line: string): void {
      sent.push(line);
    },
    read(): Promise<string> {
      return Promise.resolve(options.answer ?? '');
    },
    close(): void {
      closed = true;
    },
  };

  const payload = options.payload ?? PAYLOAD;
  await runApprovalHook({
    environment: options.environment ?? {
      [APPROVAL_SOCKET_VARIABLE]: SOCKET,
      [APPROVAL_SECRET_VARIABLE]: SECRET,
    },
    readPayload: typeof payload === 'function' ? payload : () => Promise.resolve(payload),
    connect: (path: string) => {
      connects += 1;
      expect(path).toBe(SOCKET);
      if (options.refuseConnection !== undefined) {
        return Promise.reject(new Error(options.refuseConnection));
      }
      return Promise.resolve(channel);
    },
    print: (text: string) => {
      printed += text;
    },
  });

  return { printed, listener: { sent, connects, closed } };
}

describe('the permission hook', () => {
  it('sends the secret and the payload as one line, and prints what comes back', async () => {
    const { printed, listener } = await run({ answer: ALLOW });

    expect(listener.sent).toHaveLength(1);
    expect(JSON.parse(listener.sent[0] ?? '')).toEqual({ secret: SECRET, payload: PAYLOAD });
    // The gate's bytes, unchanged. One encoder composes an answer to this
    // provider, on the machine holding the blocked process, and a hook that
    // re-encoded what it was handed would be a second one -- free to spell a
    // decision the way the provider silently ignores.
    expect(printed).toBe(ALLOW);
  });

  it('prints a denial as readily as a grant', async () => {
    const deny = encodeClaudePermissionAnswer({ behavior: 'deny', message: 'a person said no' });
    expect((await run({ answer: deny })).printed).toBe(deny);
  });

  it('sends its line on one connection and closes it', async () => {
    const { listener } = await run({ answer: ALLOW });
    expect(listener.connects).toBe(1);
    expect(listener.closed).toBe(true);
  });

  it('prints nothing when the gate closes without answering', async () => {
    // The gate's refusals are all silence: a secret that belongs to no live
    // launch, a payload its parser will not take, a request that expired while
    // somebody was deciding. None of them is a denial, and printing one here
    // would deny a tool call on the strength of a socket being closed.
    expect((await run({ answer: null })).printed).toBe('');
  });

  it('prints nothing when there is no listener to reach', async () => {
    const { printed, listener } = await run({ refuseConnection: 'ENOENT' });
    expect(printed).toBe('');
    expect(listener.sent).toEqual([]);
  });

  it('prints nothing, and opens nothing, when the launch told it nothing', async () => {
    // A `claude` an operator started themselves inherits no such variables, and
    // may still read a settings file left behind by a launch that died. It must
    // not reach for a socket it was not given the secret for.
    const { printed, listener } = await run({ environment: {}, answer: ALLOW });
    expect(printed).toBe('');
    expect(listener.connects).toBe(0);
  });

  it('prints nothing when the provider hands it nothing to ask about', async () => {
    const { printed, listener } = await run({ payload: '', answer: ALLOW });
    expect(printed).toBe('');
    expect(listener.connects).toBe(0);
  });

  it('prints nothing when reading the payload fails', async () => {
    const { printed } = await run({
      payload: () => Promise.reject(new Error('stdin closed')),
      answer: ALLOW,
    });
    expect(printed).toBe('');
  });

  it('prints nothing when the answer is longer than an answer', async () => {
    // Anything on this machine can write to a socket the hook has open, and the
    // one thing this program does with what it reads is put it on the stdin of
    // an agent. A bound is the difference between a refused answer and a
    // megabyte of somebody else's text arriving there.
    const flood = 'x'.repeat(APPROVAL_ANSWER_MAX_BYTES + 1);
    expect((await run({ answer: flood })).printed).toBe('');
  });
});
