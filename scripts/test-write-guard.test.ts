import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  compareSnapshots,
  describeChanges,
  parseTestWindows,
  snapshotTree,
  type Entry,
  type Snapshot,
  type TestWindow,
} from './test-write-guard.js';

const made: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'write-guard-'));
  made.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(made.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function entry(over: Partial<Entry> = {}): Entry {
  return { kind: 'file', size: 1, mtimeMs: 1000, ...over };
}

function snapshot(entries: Record<string, Entry>): Snapshot {
  return new Map(Object.entries(entries));
}

describe('a snapshot of a tree', () => {
  it('records every path under the root', async () => {
    const root = await directory();
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'file'), 'one');

    const taken = snapshotTree(root, new Set());

    expect([...taken.keys()].sort()).toEqual([join(root, 'nested'), join(root, 'nested', 'file')]);
    expect(taken.get(join(root, 'nested', 'file'))?.kind).toBe('file');
    expect(taken.get(join(root, 'nested'))?.kind).toBe('directory');
  });

  it('descends into no directory it was told to skip', async () => {
    const root = await directory();
    const disposable = join(root, 'tmp');
    await mkdir(disposable);
    await writeFile(join(disposable, 'scratch'), 'one');

    const taken = snapshotTree(root, new Set([disposable]));

    expect([...taken.keys()]).toEqual([]);
  });

  it('records a symlink without walking through it', async () => {
    const root = await directory();
    await mkdir(join(root, 'target'));
    await writeFile(join(root, 'target', 'file'), 'one');
    await symlink(join(root, 'target'), join(root, 'link'));

    const taken = snapshotTree(root, new Set());

    expect(taken.get(join(root, 'link'))?.kind).toBe('symlink');
    expect(taken.has(join(root, 'link', 'file'))).toBe(false);
  });

  it('sees a file written between two passes', async () => {
    const root = await directory();
    const before = snapshotTree(root, new Set());
    await writeFile(join(root, 'leak'), 'one');
    const after = snapshotTree(root, new Set());

    expect(compareSnapshots(before, after).map((change) => change.path)).toEqual([
      join(root, 'leak'),
    ]);
  });
});

describe('comparing two snapshots', () => {
  it('reports nothing when the tree is unchanged', () => {
    const before = snapshot({ '/root/.bashrc': entry() });

    expect(compareSnapshots(before, snapshot({ '/root/.bashrc': entry() }))).toEqual([]);
  });

  it('names a path that appeared', () => {
    const after = snapshot({ '/root/leak': entry({ mtimeMs: 4200 }) });

    expect(compareSnapshots(new Map(), after)).toEqual([
      { kind: 'added', path: '/root/leak', at: 4200 },
    ]);
  });

  it('names a path that went away', () => {
    const before = snapshot({ '/root/.bashrc': entry() });

    expect(compareSnapshots(before, new Map())).toEqual([
      { kind: 'removed', path: '/root/.bashrc' },
    ]);
  });

  it('names a path whose contents moved under it', () => {
    const before = snapshot({ '/root/.npmrc': entry({ size: 10, mtimeMs: 1000 }) });
    const after = snapshot({ '/root/.npmrc': entry({ size: 20, mtimeMs: 5000 }) });

    expect(compareSnapshots(before, after)).toEqual([
      { kind: 'changed', path: '/root/.npmrc', at: 5000 },
    ]);
  });

  it('leaves out the directory a new file restamped, which is the same news twice', () => {
    const before = snapshot({ '/root': entry({ kind: 'directory', mtimeMs: 1000 }) });
    const after = snapshot({
      '/root': entry({ kind: 'directory', mtimeMs: 5000 }),
      '/root/leak': entry({ mtimeMs: 5000 }),
    });

    expect(compareSnapshots(before, after)).toEqual([
      { kind: 'added', path: '/root/leak', at: 5000 },
    ]);
  });

  it('keeps a directory that changed with nothing inside it to explain why', () => {
    const before = snapshot({ '/root': entry({ kind: 'directory', mtimeMs: 1000 }) });
    const after = snapshot({ '/root': entry({ kind: 'directory', mtimeMs: 5000 }) });

    expect(compareSnapshots(before, after)).toEqual([{ kind: 'changed', path: '/root', at: 5000 }]);
  });

  it('sorts by path, so two runs of the same leak read the same', () => {
    const after = snapshot({ '/root/b': entry(), '/root/a': entry() });

    expect(compareSnapshots(new Map(), after).map((change) => change.path)).toEqual([
      '/root/a',
      '/root/b',
    ]);
  });
});

describe('the failure the guard prints', () => {
  const windows: readonly TestWindow[] = [
    { file: '/app/apps/cli/src/setup.test.ts', start: 2000, end: 3000 },
    { file: '/app/apps/hub/src/hub.test.ts', start: 2500, end: 4000 },
  ];

  function report(changes: Parameters<typeof describeChanges>[0]['changes']): string {
    return describeChanges({ changes, windows, startedAt: 1000, workspaceRoot: '/app' });
  }

  it('names the path that was written', () => {
    expect(report([{ kind: 'added', path: '/root/leak', at: 2100 }])).toContain('/root/leak');
  });

  it('says how far into the run it was written', () => {
    expect(report([{ kind: 'added', path: '/root/leak', at: 2100 }])).toContain(
      '1.1s into the run',
    );
  });

  it('names the test file that was running when it was written', () => {
    const printed = report([{ kind: 'added', path: '/root/leak', at: 2100 }]);

    expect(printed).toContain('apps/cli/src/setup.test.ts');
    expect(printed).not.toContain('apps/hub/src/hub.test.ts');
  });

  it('names every test file in flight, because the suites run in parallel', () => {
    const printed = report([{ kind: 'added', path: '/root/leak', at: 2600 }]);

    expect(printed).toContain('apps/cli/src/setup.test.ts');
    expect(printed).toContain('apps/hub/src/hub.test.ts');
  });

  it('says so rather than guessing when no test file was running', () => {
    const printed = report([{ kind: 'added', path: '/root/leak', at: 9000 }]);

    expect(printed).toContain('/root/leak');
    expect(printed).toContain('no test file was running');
  });

  it('reports a removed path without claiming a time it does not have', () => {
    const printed = report([{ kind: 'removed', path: '/etc/hosts' }]);

    expect(printed).toContain('/etc/hosts');
    expect(printed).toContain('removed');
    expect(printed).not.toContain('into the run');
  });

  it('counts what it does not list, so a flood cannot hide the count', () => {
    const changes = Array.from({ length: 60 }, (_, index) => ({
      kind: 'added' as const,
      path: `/root/leak-${String(index).padStart(2, '0')}`,
      at: 2100,
    }));

    const printed = report(changes);

    expect(printed).toContain('60 paths');
    expect(printed).toContain('10 more');
    expect(printed).not.toContain('/root/leak-59');
  });
});

describe('reading a vitest report', () => {
  it('takes one window per test file', () => {
    const text = JSON.stringify({
      testResults: [
        { name: '/app/apps/cli/src/setup.test.ts', startTime: 1000, endTime: 1200.5 },
        { name: '/app/apps/hub/src/hub.test.ts', startTime: 1100, endTime: 1900 },
      ],
    });

    expect(parseTestWindows('cli.json', text)).toEqual([
      { file: '/app/apps/cli/src/setup.test.ts', start: 1000, end: 1200.5 },
      { file: '/app/apps/hub/src/hub.test.ts', start: 1100, end: 1900 },
    ]);
  });

  it('refuses a document that is not one, naming the file it came from', () => {
    expect(() => parseTestWindows('cli.json', '{"testResults":[{"name":"x"}]}')).toThrow(
      'cli.json',
    );
  });

  it('refuses text that is not JSON at all, naming the file it came from', () => {
    expect(() => parseTestWindows('cli.json', 'not json')).toThrow('cli.json');
  });
});
