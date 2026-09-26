import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalHookConnection } from './approval-gate.js';
import { connectToGate } from './approval-hook.js';
import { APPROVAL_LAUNCH_PREFIX } from './approval-launch.js';
import {
  APPROVAL_DIRECTORY,
  APPROVAL_LINE_MAX_BYTES,
  APPROVAL_SOCKET_NAME,
  openApprovalListener,
} from './node-approval-listener.js';

/**
 * The socket, against the real hook program's own connection.
 *
 * Everything else about approvals is driven through the seam this file is the
 * one implementation of, so what is left to check is exactly what a fake cannot
 * say: that a path is created with the permissions claimed for it, that the two
 * programs agree on where a line ends, and that an answer written on one side
 * comes out of the other. Both halves here are the shipped ones -- the listener
 * and `connectToGate` -- because a test that dialled the socket itself would be
 * asserting that this file works with a client this repository does not run.
 */

const roots: string[] = [];
const closers: (() => void)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function listening(): Promise<{
  readonly socketPath: string;
  readonly directory: string;
  /** Every hook the gate would have been handed, in order. */
  readonly connections: readonly ApprovalHookConnection[];
}> {
  const root = await mkdtemp(join(tmpdir(), 'agentplex-approvals-'));
  roots.push(root);
  const opened = await openApprovalListener(root);
  if (!opened.ok) throw new Error(opened.problem);
  closers.push(() => opened.listener.close());

  const connections: ApprovalHookConnection[] = [];
  opened.listener.onConnection((connection) => void connections.push(connection));
  return { socketPath: opened.socketPath, directory: opened.directory, connections };
}

/** Waits for the listener to have been handed a connection, or gives up. */
async function settled(connections: readonly unknown[], want = 1): Promise<void> {
  for (let attempt = 0; attempt < 200 && connections.length < want; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('the socket a blocked hook connects to', () => {
  it('carries one line in and the answer back out', async () => {
    const { socketPath, connections } = await listening();

    const channel = await connectToGate(socketPath);
    channel.send(`${JSON.stringify({ secret: 'a-launch-secret', payload: '{}' })}\n`);
    const answer = channel.read();

    await settled(connections);
    const connection = connections[0];
    expect(connection).toBeDefined();
    expect(JSON.parse(connection?.sent ?? '')).toEqual({
      secret: 'a-launch-secret',
      payload: '{}',
    });

    connection?.write('{"decided":true}');
    connection?.close();
    expect(await answer).toBe('{"decided":true}');
  });

  it('tells the gate when a hook goes away with nothing decided', async () => {
    const { socketPath, connections } = await listening();
    const channel = await connectToGate(socketPath);
    channel.send(`${JSON.stringify({ secret: 'a-launch-secret', payload: '{}' })}\n`);
    await settled(connections);

    let closed = false;
    connections[0]?.onClose(() => void (closed = true));
    channel.close();

    for (let attempt = 0; attempt < 200 && !closed; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(closed).toBe(true);
  });

  it('still tells the gate about a hook that went away before anybody asked for it', async () => {
    // Opened by hand rather than through `listening`, which asks for
    // connections at once: this is the connection that arrived, said its line
    // and hung up while nothing was yet asking.
    const root = await mkdtemp(join(tmpdir(), 'agentplex-approvals-'));
    roots.push(root);
    const opened = await openApprovalListener(root);
    if (!opened.ok) throw new Error(opened.problem);
    closers.push(() => opened.listener.close());

    const channel = await connectToGate(opened.socketPath);
    channel.send(`${JSON.stringify({ secret: 'a-launch-secret', payload: '{}' })}\n`);
    const answer = channel.read();
    channel.close();
    // The hook's read ends when the socket is gone from both sides.
    expect(await answer).toBe('');
    await new Promise((resolve) => setTimeout(resolve, 100));

    const connections: ApprovalHookConnection[] = [];
    opened.listener.onConnection((connection) => void connections.push(connection));
    expect(connections).toHaveLength(1);

    let closed = false;
    connections[0]?.onClose(() => void (closed = true));
    for (let attempt = 0; attempt < 200 && !closed; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(closed).toBe(true);
  });

  it('never hands over a line longer than the bound', async () => {
    const { socketPath, connections } = await listening();
    const channel = await connectToGate(socketPath);
    // No newline anywhere in it: a connection that writes forever is what the
    // bound is against, and the gate must never be handed what it wrote.
    channel.send('x'.repeat(APPROVAL_LINE_MAX_BYTES + 1));
    const answer = channel.read();

    // The read ends because the listener destroyed the socket, and it ends
    // empty, which is the hook's "nobody decided".
    expect(await answer).toBe('');
    expect(connections).toEqual([]);
  });

  it('puts the socket somewhere only this user can reach', async () => {
    const { directory, socketPath } = await listening();
    expect(socketPath).toBe(join(directory, APPROVAL_SOCKET_NAME));
    // The directory is what every system agentplex runs on actually enforces;
    // the socket's own mode is what some of them check as well.
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
  });

  it('clears the launch folders a killed server left behind, and nothing else', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentplex-approvals-'));
    roots.push(root);
    const directory = join(root, APPROVAL_DIRECTORY);
    // What a server killed mid-launch leaves: a folder whose settings file
    // carries a secret that died with it.
    await mkdir(join(directory, `${APPROVAL_LAUNCH_PREFIX}abc`), { recursive: true });
    await writeFile(join(directory, `${APPROVAL_LAUNCH_PREFIX}abc`, 'settings.json'), '{}');
    await writeFile(join(directory, 'other.txt'), 'not a launch');

    const opened = await openApprovalListener(root);
    if (!opened.ok) throw new Error(opened.problem);
    closers.push(() => opened.listener.close());

    expect((await readdir(directory)).sort()).toEqual([APPROVAL_SOCKET_NAME, 'other.txt']);
  });

  it('opens over a socket file a killed server left behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentplex-approvals-'));
    roots.push(root);
    const first = await openApprovalListener(root);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Not closed: the file stays on disk, exactly as it does when a server is
    // killed rather than stopped, and the next start has to be able to bind.
    const second = await openApprovalListener(root);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    closers.push(() => first.listener.close());
    closers.push(() => second.listener.close());
    expect(second.socketPath).toBe(first.socketPath);
  });
});
