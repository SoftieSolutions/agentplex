import { connect as connectSocket } from 'node:net';
import process from 'node:process';

/**
 * The program a coding agent runs when it wants permission, and the smallest
 * thing in this repository.
 *
 * It is started by the provider, once per blocked tool call, with the request
 * on its stdin. It sends that request to the server holding this machine's
 * sessions, waits for an answer on the same connection, prints whatever comes
 * back and exits. The provider reads its stdout: an answer decides the tool
 * call, and an empty stdout means nobody decided, so the agent asks at its own
 * terminal exactly as it would with no hook installed.
 *
 * **Every failure prints nothing and exits zero.** No listener, a socket that
 * closed, a payload it could not read, an answer longer than an answer: all of
 * them are silence, which is the provider's third answer and the only honest
 * one here. The alternative failures are both worse than a person being asked
 * twice -- a hook that exits non-zero puts an error in front of the agent
 * instead of a question, and a hook that invents a decision allows or denies
 * something nobody was asked about.
 *
 * **It is told where to go in its environment and never on its argv.** A hook
 * process is a child of the agent, so it inherits what the launch plan set on
 * the agent, and `ps` on every machine this runs on would have shown a secret
 * passed as an argument to anything else running on the box. Which is the whole
 * of the access control here: a unix socket under the server's own directory is
 * reachable by anything running as that user, and the per-launch secret is what
 * separates the agent that was started by this server from everything else.
 *
 * It holds no timer. The gate on the other end gives up before the provider
 * does and closes the connection when it has, which arrives here as an empty
 * answer; the provider's own timeout is behind that again.
 */

/** Where the server is listening, as the launch plan told the agent. */
export const APPROVAL_SOCKET_VARIABLE = 'AGENTPLEX_APPROVAL_SOCKET';

/** What this hook presents so the gate knows which launch it belongs to. */
export const APPROVAL_SECRET_VARIABLE = 'AGENTPLEX_APPROVAL_SECRET';

/**
 * How much of an answer this will read before deciding it is not one.
 *
 * Generous for what it carries -- a behaviour and a sentence -- and bounded
 * because the answer goes straight onto the stdin of an agent. Anything running
 * as this user can write to the socket this connects to, and the bound is the
 * difference between that being a refused answer and being a megabyte of
 * somebody else's text arriving in a model's context.
 */
export const APPROVAL_ANSWER_MAX_BYTES = 16 * 1024;

/**
 * The conversation with the gate, as this program has it.
 *
 * A seam because a unix socket is the one thing a unit test cannot supply, and
 * everything worth asserting about this program -- what it sends, what it does
 * with an answer, what it does with silence -- is on this side of it.
 */
export interface ApprovalHookChannel {
  /** Sends the one line, which is the whole of what this side ever says. */
  send(line: string): void;
  /** Everything the gate wrote before it closed, whole, or empty for silence. */
  read(): Promise<string>;
  close(): void;
}

export interface ApprovalHookDependencies {
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** The provider's request, as it arrived on stdin. */
  readPayload(): Promise<string>;
  connect(path: string): Promise<ApprovalHookChannel>;
  /** Writes the provider's stdout. Called once, or not at all. */
  print(answer: string): void;
}

/**
 * Asks, waits, and prints -- or prints nothing.
 *
 * It never rejects. There is no caller to handle a rejection: the caller is a
 * process exiting, and the exit code it wants is zero whatever happened.
 */
export async function runApprovalHook({
  environment,
  readPayload,
  connect,
  print,
}: ApprovalHookDependencies): Promise<void> {
  const socket = environment[APPROVAL_SOCKET_VARIABLE];
  const secret = environment[APPROVAL_SECRET_VARIABLE];
  // Not an error, and not a surprise. An operator's own `claude`, started by
  // hand, can read a settings file this server left behind and run this program
  // with none of it set. There is nothing to connect to and nothing to present,
  // so there is nothing to do but let the terminal ask.
  if (socket === undefined || socket === '' || secret === undefined || secret === '') return;

  let payload: string;
  try {
    payload = await readPayload();
  } catch {
    return;
  }
  if (payload === '') return;

  let channel: ApprovalHookChannel;
  try {
    channel = await connect(socket);
  } catch {
    // The server is not running, or is not the one that started this agent.
    return;
  }

  try {
    // One line, and both fields are strings: the payload is the provider's own
    // JSON, carried as text rather than reparsed here, so that the one parser
    // for this direction is the one at the gate.
    channel.send(`${JSON.stringify({ secret, payload })}\n`);
    const answer = await channel.read();
    if (answer === '' || Buffer.byteLength(answer, 'utf8') > APPROVAL_ANSWER_MAX_BYTES) return;
    print(answer);
  } catch {
    return;
  } finally {
    channel.close();
  }
}

/**
 * The real connection: a unix socket, opened once, read to the end.
 *
 * Nothing is written back to the gate but the one line, and nothing is read
 * from it but the answer, so there is no framing on this side: the gate closes
 * when it has said its piece, and the end of the stream is the end of the
 * answer.
 */
export function connectToGate(path: string): Promise<ApprovalHookChannel> {
  return new Promise<ApprovalHookChannel>((resolve, reject) => {
    const socket = connectSocket(path);
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.removeListener('error', reject);
      resolve({
        send: (line: string) => void socket.write(line),
        read: () =>
          new Promise<string>((answered) => {
            let received = '';
            const finish = (): void => void answered(received);
            socket.on('data', (chunk: string) => {
              received += chunk;
              // Read no further than the bound. What follows an over-long
              // answer is not going to make it a shorter one.
              if (received.length > APPROVAL_ANSWER_MAX_BYTES) finish();
            });
            // An error mid-read is an answer that did not arrive whole, which
            // is silence. `received` is dropped on that path by the caller's
            // bound check only if it grew; an empty read resolves empty.
            socket.once('error', () => void answered(''));
            socket.once('end', finish);
            socket.once('close', finish);
          }),
        close: () => void socket.destroy(),
      });
    });
  });
}

/** Everything on stdin, bounded by the answer the gate will accept for it. */
async function readStandardInput(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let payload = '';
  for await (const chunk of process.stdin) payload += chunk as string;
  return payload;
}

/**
 * The program, when this file is what node was asked to run.
 *
 * Guarded, because the same module is imported by the tests and by nothing
 * else: a top-level call would make importing it hang on a stdin that is never
 * going to close.
 */
export async function main(): Promise<void> {
  await runApprovalHook({
    environment: process.env,
    readPayload: readStandardInput,
    connect: connectToGate,
    print: (answer: string) => void process.stdout.write(answer),
  });
}

const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === new URL(`file://${invoked}`).href) {
  // Never a rejection and never a non-zero exit: see the top of this file.
  void main();
}
