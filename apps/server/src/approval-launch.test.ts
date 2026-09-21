import { describe, expect, it } from 'vitest';
import { createLogger, type IdGenerator, type LogRecord } from '@agentplex/node-shared';
import { storeIdSchema, type StoreDescriptor, type StoreId } from '@agentplex/protocol';
import { claudePermissionHook } from '@agentplex/providers';
import { APPROVAL_HOOK_TIMEOUT_SECONDS, type ApprovalGate } from './approval-gate.js';
import { APPROVAL_SECRET_VARIABLE, APPROVAL_SOCKET_VARIABLE } from './approval-hook.js';
import { createLaunchApprovals, type ApprovalFileSystem } from './approval-launch.js';

/**
 * What a launch is given before it starts, and what is taken back when it ends.
 *
 * The gate here is a record of what was admitted and retired rather than the
 * real one: what this file is about is the file on disk and the two values that
 * reach the child, and the gate's own rules have their own suite.
 */

const STORE: StoreDescriptor = {
  storeId: storeIdSchema.parse('store-a'),
  path: '/Users/dev/.claude',
};
const DIRECTORY = '/var/lib/agentplex/approvals';
const SOCKET = `${DIRECTORY}/hook.sock`;
const HOOK_COMMAND = '/usr/local/bin/node';
const HOOK_ARGS = ['/opt/agentplex/server/approval-hook.js'];

interface FakeGate extends ApprovalGate {
  /** Every store admitted, and whether its admission has been retired. */
  readonly admitted: readonly { readonly storeId: StoreId; readonly secret: string }[];
  readonly retired: readonly string[];
}

function fakeGate(): FakeGate {
  const admitted: { storeId: StoreId; secret: string }[] = [];
  const retired: string[] = [];
  let next = 0;
  return {
    admit(storeId: StoreId) {
      const secret = `secret-${(next += 1)}`;
      admitted.push({ storeId, secret });
      return { secret, close: () => void retired.push(secret) };
    },
    decide() {
      throw new Error('this file decides nothing');
    },
    stop() {
      throw new Error('this file stops nothing');
    },
    admitted,
    retired,
  };
}

interface FakeFiles extends ApprovalFileSystem {
  readonly written: Map<string, string>;
  readonly removed: readonly string[];
  /** Set to make the next write fail, as a full or read-only disk would. */
  problem: string | null;
}

function fakeFiles(): FakeFiles {
  const written = new Map<string, string>();
  const removed: string[] = [];
  const files: FakeFiles = {
    problem: null,
    written,
    removed,
    write(path: string, content: string): Promise<void> {
      if (files.problem !== null) return Promise.reject(new Error(files.problem));
      written.set(path, content);
      return Promise.resolve();
    },
    removeDirectory(path: string): Promise<void> {
      removed.push(path);
      return Promise.resolve();
    },
  };
  return files;
}

function counting(): IdGenerator {
  let next = 0;
  return { newId: () => `${(next += 1)}` };
}

function approvals(records: LogRecord[] = []) {
  const gate = fakeGate();
  const files = fakeFiles();
  return {
    gate,
    files,
    records,
    launches: createLaunchApprovals({
      gate,
      files,
      directory: DIRECTORY,
      socketPath: SOCKET,
      hookCommand: HOOK_COMMAND,
      hookArgs: HOOK_ARGS,
      ids: counting(),
      logger: createLogger('warn', (record) => void records.push(record)),
    }),
  };
}

describe('preparing one launch to ask', () => {
  it('writes the provider its settings file and hands back where it is', async () => {
    const { launches, files } = approvals();
    const opened = await launches.open(STORE, claudePermissionHook);

    expect(opened).not.toBeNull();
    expect(opened?.approval.settingsFile).toBe(`${DIRECTORY}/launch-1/settings.json`);
    expect([...files.written.keys()]).toEqual([`${DIRECTORY}/launch-1/settings.json`]);
  });

  it('gives the hook the gate’s own patience and nobody else’s', async () => {
    // The number in the file and the deadline the gate expires on are one
    // decision. A launch that told the provider to wait less than the gate does
    // would leave a person answering a question the agent had stopped asking.
    const { launches, files } = approvals();
    await launches.open(STORE, claudePermissionHook);
    const document = JSON.parse([...files.written.values()][0] ?? '') as {
      hooks: Record<string, { hooks: { command: string; timeout: number }[] }[]>;
    };
    const entry = document.hooks['PermissionRequest']?.[0]?.hooks[0];
    expect(entry?.timeout).toBe(APPROVAL_HOOK_TIMEOUT_SECONDS);
    expect(entry?.command).toContain(HOOK_ARGS[0]);
  });

  it('tells the child where to connect and what to present, in its environment', async () => {
    const { launches, gate } = approvals();
    const opened = await launches.open(STORE, claudePermissionHook);

    expect(gate.admitted).toEqual([{ storeId: STORE.storeId, secret: 'secret-1' }]);
    expect(opened?.approval.env).toEqual({
      [APPROVAL_SOCKET_VARIABLE]: SOCKET,
      [APPROVAL_SECRET_VARIABLE]: 'secret-1',
    });
  });

  it('retires the secret and removes the file when the launch ends', async () => {
    const { launches, gate, files } = approvals();
    const opened = await launches.open(STORE, claudePermissionHook);
    opened?.close();

    expect(gate.retired).toEqual(['secret-1']);
    // Awaited by nobody: the removal is started from the end of a process.
    await Promise.resolve();
    expect(files.removed).toEqual([`${DIRECTORY}/launch-1`]);
  });

  it('prepares nothing for a provider that cannot be made to ask', async () => {
    const { launches, gate, files } = approvals();
    expect(await launches.open(STORE, null)).toBeNull();
    // Nothing minted and nothing written: a codex session produces no
    // approvals at all, which is not the same as producing unanswerable ones.
    expect(gate.admitted).toEqual([]);
    expect(files.written.size).toBe(0);
  });

  it('costs the approval and not the session when the disk says no', async () => {
    const records: LogRecord[] = [];
    const { launches, gate, files } = approvals(records);
    files.problem = 'EROFS: read-only file system';

    expect(await launches.open(STORE, claudePermissionHook)).toBeNull();
    // The secret is retired at once. A launch that will not carry the file must
    // not leave an admission behind for something else to present.
    expect(gate.retired).toEqual(['secret-1']);
    expect(records.map((record) => record.message)).toEqual([
      'a launch could not be given a way to ask',
    ]);
  });
});
