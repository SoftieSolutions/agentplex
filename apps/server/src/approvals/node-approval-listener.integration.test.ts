import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createFakeTimers } from '@agentplex/node-shared/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalHookConnection } from './approval-gate.js';
import { connectToGate } from './approval-hook.js';
import { APPROVAL_LAUNCH_PREFIX } from './approval-launch.js';
import {
  APPROVAL_DIRECTORY,
  APPROVAL_IDLE_MS,
  APPROVAL_LINE_MAX_BYTES,
  APPROVAL_SOCKET_NAME,
  type ApprovalListenerOptions,
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

async function listening(options?: ApprovalListenerOptions): Promise<{
  readonly socketPath: string;
  readonly directory: string;
  /** Every hook the gate would have been handed, in order. */
  readonly connections: readonly ApprovalHookConnection[];
}> {
  const root = await mkdtemp(join(tmpdir(), 'agentplex-approvals-'));
  roots.push(root);
  const opened = await openApprovalListener(root, options);
  if (!opened.ok) throw new Error(opened.problem);
  closers.push(() => opened.listener.close());

  const connections: ApprovalHookConnection[] = [];
  opened.listener.onConnection((connection) => void connections.push(connection));
  return { socketPath: opened.socketPath, directory: opened.directory, connections };
}

/** Waits for the listener to have been handed a connection, or gives up. */
async function settled(connections: readonly unknown[], want = 1): Promise<void> {
  await until(() => connections.length >= want);
}

/** Waits for a condition the listener's side of the socket will make true, or gives up. */
async function until(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !done(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const aLine = `${JSON.stringify({ secret: 'a-launch-secret', payload: '{}' })}\n`;

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

  it('hands over a line that arrived in pieces as one line', async () => {
    const { socketPath, connections } = await listening();
    const channel = await connectToGate(socketPath);
    // Three writes with the kernel given time to deliver each on its own, so
    // the listener sees three chunks and only the last carries the newline.
    const line = JSON.stringify({ secret: 'a-launch-secret', payload: '{"a":"b"}' });
    channel.send(line.slice(0, 10));
    await pause(5);
    channel.send(line.slice(10, 20));
    await pause(5);
    channel.send(`${line.slice(20)}\n`);

    await settled(connections);
    expect(connections).toHaveLength(1);
    expect(connections[0]?.sent).toBe(line);
    channel.close();
  });

  it('never hands over a line longer than the bound, and drops it at once', async () => {
    const { socketPath, connections } = await listening({ lineMaxBytes: 64 });
    const channel = await connectToGate(socketPath);
    const answer = channel.read();

    // No newline anywhere in it: a connection that writes forever is what the
    // bound is against, and the gate must never be handed what it wrote.
    const started = performance.now();
    channel.send('x'.repeat(65));
    // The read ends because the listener destroyed the socket, and it ends
    // empty, which is the hook's "nobody decided".
    expect(await answer).toBe('');
    expect(performance.now() - started).toBeLessThan(100);
    expect(connections).toEqual([]);
  });

  it('never hands over an over-long line even when its newline arrives with it', async () => {
    const { socketPath, connections } = await listening({ lineMaxBytes: 64 });
    const channel = await connectToGate(socketPath);
    const answer = channel.read();
    channel.send(`${'x'.repeat(65)}\n`);

    expect(await answer).toBe('');
    expect(connections).toEqual([]);
  });

  it('hands over a line exactly at the bound', async () => {
    const { socketPath, connections } = await listening({ lineMaxBytes: 64 });
    const channel = await connectToGate(socketPath);
    channel.send(`${'x'.repeat(64)}\n`);
    await settled(connections);
    // The bound counts bytes, not characters: 32 two-byte characters is 64.
    const second = await connectToGate(socketPath);
    second.send(`${'\u00e9'.repeat(32)}\n`);
    await settled(connections, 2);

    expect(connections.map((connection) => connection.sent)).toEqual([
      'x'.repeat(64),
      '\u00e9'.repeat(32),
    ]);
    channel.close();
    second.close();
  });

  it('bounds a line at eight mebibytes when nothing else is said', () => {
    expect(APPROVAL_LINE_MAX_BYTES).toBe(8 * 1024 * 1024);
  });

  it('drops a connection that has not finished its line when the idle bound fires', async () => {
    const timers = createFakeTimers();
    const { socketPath, connections } = await listening({ timers });
    const channel = await connectToGate(socketPath);
    const answer = channel.read();
    channel.send('{"secret":"a-launch-');

    // The client's connect can resolve before the listener's connection
    // handler has run, so wait for the bound to be armed before firing it.
    await until(() => timers.pending === 1);
    expect(timers.delays).toEqual([APPROVAL_IDLE_MS]);
    timers.fireAll();

    expect(await answer).toBe('');
    expect(connections).toEqual([]);
  });

  it('never drops a connection for idling once its line has arrived', async () => {
    const timers = createFakeTimers();
    const { socketPath, connections } = await listening({ timers });
    const channel = await connectToGate(socketPath);
    channel.send(aLine);
    const answer = channel.read();
    await settled(connections);

    // Cancelled on delivery: the wait for a person's answer is unbounded here.
    expect(timers.pending).toBe(0);
    timers.fireAll();

    const connection = connections[0];
    expect(connection).toBeDefined();
    connection?.write('{"decided":true}');
    connection?.close();
    expect(await answer).toBe('{"decided":true}');
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
