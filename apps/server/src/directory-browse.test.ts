import { describe, expect, it } from 'vitest';
import { DIRECTORY_ENTRIES_MAX, type DirectoryEntry } from '@agentplex/protocol';
import {
  createDirectoryBrowser,
  type DirectoryAllowance,
  type DirectoryOutcome,
} from './directory-browse.js';
import { createFakeDirectoryReader } from './fake-directory-reader.js';

const WORK = '/srv/work';

function entries(outcome: DirectoryOutcome): readonly DirectoryEntry[] {
  if (!outcome.ok) throw new Error(`expected a listing, got: ${outcome.problem}`);
  return outcome.entries;
}

function problem(outcome: DirectoryOutcome | DirectoryAllowance): string {
  if (outcome.ok) throw new Error('expected a refusal');
  return outcome.problem;
}

describe('a browse with no roots configured', () => {
  it('refuses every request, and the reason names the setting to change', async () => {
    const browser = createDirectoryBrowser({
      roots: [],
      reader: createFakeDirectoryReader({ directories: { [WORK]: [] } }),
    });

    for (const asked of [null, WORK]) {
      const outcome = await browser.list(asked);
      expect(outcome.ok).toBe(false);
      expect(problem(outcome)).toContain('AGENTPLEX_BROWSE_ROOTS');
      expect(problem(outcome)).toContain('--browse-root');
    }
  });

  it('is refused rather than internal: retrying changes nothing', async () => {
    const browser = createDirectoryBrowser({ roots: [], reader: createFakeDirectoryReader() });
    const outcome = await browser.list(null);
    expect(outcome.ok ? null : outcome.code).toBe('refused');
  });
});

describe('a browse of the roots themselves', () => {
  it('answers the roots as entries, with no directory, so a picker can start', async () => {
    const browser = createDirectoryBrowser({
      roots: [WORK, '/home/dev/code'],
      reader: createFakeDirectoryReader({ directories: { [WORK]: [] } }),
    });

    const outcome = await browser.list(null);
    expect(outcome).toEqual({
      ok: true,
      directory: null,
      roots: [WORK, '/home/dev/code'],
      entries: [
        { name: WORK, kind: 'directory' },
        { name: '/home/dev/code', kind: 'directory' },
      ],
      truncated: false,
    });
  });

  it('names them as configured, not as they resolve', async () => {
    // The operator wrote `/home/dev/code`; showing them `/mnt/dev/code` would
    // be showing them a path they never typed and every refusal will not name.
    const browser = createDirectoryBrowser({
      roots: ['/home/dev/code'],
      reader: createFakeDirectoryReader({
        links: { '/home/dev': '/mnt/dev' },
        directories: { '/mnt/dev/code': [] },
      }),
    });

    const outcome = await browser.list(null);
    expect(entries(outcome)).toEqual([{ name: '/home/dev/code', kind: 'directory' }]);
  });

  it('does not touch the disk to answer it', async () => {
    // A machine whose volume is not mounted still says what it would browse.
    const reader = createFakeDirectoryReader();
    const browser = createDirectoryBrowser({ roots: [WORK], reader });
    expect((await browser.list(null)).ok).toBe(true);
    expect(reader.resolved).toEqual([]);
    expect(reader.reads).toEqual([]);
  });
});

describe('a browse of a directory under a root', () => {
  const reader = () =>
    createFakeDirectoryReader({
      directories: {
        [WORK]: [
          { name: 'notes.md', kind: 'file' },
          { name: '.git', kind: 'directory' },
          { name: 'agentplex', kind: 'directory' },
          { name: 'current', kind: 'other' },
        ],
        [`${WORK}/agentplex`]: [{ name: 'package.json', kind: 'file' }],
      },
    });

  it('lists the root itself', async () => {
    const browser = createDirectoryBrowser({ roots: [WORK], reader: reader() });
    const outcome = await browser.list(WORK);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.directory).toBe(WORK);
  });

  it('descends into a directory inside it', async () => {
    const browser = createDirectoryBrowser({ roots: [WORK], reader: reader() });
    expect(entries(await browser.list(`${WORK}/agentplex`))).toEqual([
      { name: 'package.json', kind: 'file' },
    ]);
  });

  it('sorts by name and lists hidden entries', async () => {
    // A dotfile is not a secret: `.git` is one of the two directories somebody
    // browsing for a project most wants to see.
    const browser = createDirectoryBrowser({ roots: [WORK], reader: reader() });
    expect(entries(await browser.list(WORK)).map((entry) => entry.name)).toEqual([
      '.git',
      'agentplex',
      'current',
      'notes.md',
    ]);
  });

  it('carries every root on the reply, so a breadcrumb knows where to stop', async () => {
    const browser = createDirectoryBrowser({ roots: [WORK, '/opt/src'], reader: reader() });
    const outcome = await browser.list(WORK);
    expect(outcome.ok && outcome.roots).toEqual([WORK, '/opt/src']);
  });
});

describe('the containment rule', () => {
  it('refuses a path outside every root', async () => {
    const browser = createDirectoryBrowser({
      roots: [WORK],
      reader: createFakeDirectoryReader({ directories: { [WORK]: [], '/etc': [] } }),
    });
    expect(problem(await browser.list('/etc'))).toContain('not under a directory');
  });

  it('refuses a sibling whose name merely starts with a root', async () => {
    // The separator is what makes this containment and not a prefix test.
    const browser = createDirectoryBrowser({
      roots: [WORK],
      reader: createFakeDirectoryReader({ directories: { [WORK]: [], '/srv/work-secrets': [] } }),
    });
    expect(problem(await browser.list('/srv/work-secrets'))).toContain('not under a directory');
  });

  it('refuses a path that climbs out with ..', async () => {
    const browser = createDirectoryBrowser({
      roots: [WORK],
      reader: createFakeDirectoryReader({ directories: { [WORK]: [], '/srv': [] } }),
    });
    expect(problem(await browser.list(`${WORK}/..`))).toContain('not under a directory');
  });

  it('refuses a symlink inside a root that points out of it', async () => {
    // The case no amount of string processing can see: the path is textually
    // under the root and the kernel says otherwise.
    const browser = createDirectoryBrowser({
      roots: [WORK],
      reader: createFakeDirectoryReader({
        links: { [`${WORK}/escape`]: '/etc' },
        directories: { [WORK]: [], '/etc': [] },
      }),
    });
    expect(problem(await browser.list(`${WORK}/escape`))).toContain('not under a directory');
  });

  it('names the path that was asked for, never the one it resolved to', async () => {
    // The resolved path is a fact about this disk, and whoever sent this was
    // just told they may not look at it.
    const browser = createDirectoryBrowser({
      roots: [WORK],
      reader: createFakeDirectoryReader({
        links: { [`${WORK}/escape`]: '/var/secrets' },
        directories: { [WORK]: [], '/var/secrets': [] },
      }),
    });
    const refused = problem(await browser.list(`${WORK}/escape`));
    expect(refused).toContain(`${WORK}/escape`);
    expect(refused).not.toContain('/var/secrets');
  });

  it('allows a root that is itself reached through a link', async () => {
    const browser = createDirectoryBrowser({
      roots: ['/home/dev/code'],
      reader: createFakeDirectoryReader({
        links: { '/home/dev': '/mnt/dev' },
        directories: { '/mnt/dev/code': [{ name: 'agentplex', kind: 'directory' }] },
      }),
    });
    expect(entries(await browser.list('/home/dev/code'))).toEqual([
      { name: 'agentplex', kind: 'directory' },
    ]);
  });

  it('lets an unresolvable root cost itself and not the request', async () => {
    // A machine with two roots, one of them an unmounted volume, still browses
    // the other. An unreadable item in a listing costs itself, not the listing.
    const browser = createDirectoryBrowser({
      roots: ['/mnt/absent', WORK],
      reader: createFakeDirectoryReader({
        directories: { [WORK]: [{ name: 'notes.md', kind: 'file' }] },
      }),
    });
    expect(entries(await browser.list(WORK))).toEqual([{ name: 'notes.md', kind: 'file' }]);
  });
});

describe('the other three refusals', () => {
  it('refuses a path that is not there', async () => {
    const browser = createDirectoryBrowser({
      roots: [WORK],
      reader: createFakeDirectoryReader({ directories: { [WORK]: [] } }),
    });
    expect(problem(await browser.list(`${WORK}/gone`))).toContain('there is nothing at');
  });

  it('refuses a path that is a file', async () => {
    const browser = createDirectoryBrowser({
      roots: [WORK],
      reader: createFakeDirectoryReader({
        directories: { [WORK]: [] },
        files: [`${WORK}/notes.md`],
      }),
    });
    expect(problem(await browser.list(`${WORK}/notes.md`))).toContain('is not a directory');
  });

  it('calls a directory it may not read internal, because a fixed permission fixes it', async () => {
    const browser = createDirectoryBrowser({
      roots: [WORK],
      reader: createFakeDirectoryReader({
        directories: { [WORK]: [], [`${WORK}/private`]: [] },
        unreadable: { [`${WORK}/private`]: 'EACCES: permission denied' },
      }),
    });
    const outcome = await browser.list(`${WORK}/private`);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.code).toBe('internal');
    expect(problem(outcome)).toContain('EACCES');
  });

  it('says it could not look rather than claiming a path is outside a root', async () => {
    // A path this process cannot resolve is one it cannot place under a root
    // either, so "not under a root" would be a claim nothing checked.
    const browser = createDirectoryBrowser({
      roots: [WORK],
      reader: createFakeDirectoryReader({
        directories: { [WORK]: [] },
        unresolvable: { [`${WORK}/deep`]: 'ELOOP: too many symbolic links' },
      }),
    });
    const outcome = await browser.list(`${WORK}/deep`);
    expect(outcome.ok ? null : outcome.code).toBe('internal');
    expect(problem(outcome)).toContain('could not resolve');
  });

  it('refuses a relative path without asking the disk about it', async () => {
    const reader = createFakeDirectoryReader({ directories: { [WORK]: [] } });
    const browser = createDirectoryBrowser({ roots: [WORK], reader });
    expect(problem(await browser.list('work'))).toContain('absolute');
    expect(reader.resolved).toEqual([]);
  });

  it('refuses a path with a null byte, which a syscall would truncate', async () => {
    const reader = createFakeDirectoryReader({ directories: { [WORK]: [] } });
    const browser = createDirectoryBrowser({ roots: [WORK], reader });
    expect(problem(await browser.list(`${WORK}\u0000/../../etc`))).toContain('absolute path');
    expect(reader.resolved).toEqual([]);
  });
});

describe('the entry cap', () => {
  const many = (count: number): readonly DirectoryEntry[] =>
    Array.from({ length: count }, (_unused, index) => ({
      // Padded so that sorting by code unit is the same order as by number,
      // which is what makes the assertion below about the cap and not about
      // the comparison.
      name: `entry-${String(index).padStart(5, '0')}`,
      kind: 'file' as const,
    }));

  it('keeps a listing at the cap whole and says nothing was cut', async () => {
    const browser = createDirectoryBrowser({
      roots: [WORK],
      reader: createFakeDirectoryReader({ directories: { [WORK]: many(DIRECTORY_ENTRIES_MAX) } }),
    });
    const outcome = await browser.list(WORK);
    expect(entries(outcome)).toHaveLength(DIRECTORY_ENTRIES_MAX);
    expect(outcome.ok && outcome.truncated).toBe(false);
  });

  it('cuts a longer one and says so, rather than showing a prefix as the whole', async () => {
    const browser = createDirectoryBrowser({
      roots: [WORK],
      reader: createFakeDirectoryReader({
        directories: { [WORK]: many(DIRECTORY_ENTRIES_MAX + 5) },
      }),
    });
    const outcome = await browser.list(WORK);
    expect(entries(outcome)).toHaveLength(DIRECTORY_ENTRIES_MAX);
    expect(outcome.ok && outcome.truncated).toBe(true);
    // Sorted before it was cut, so what survives is the first page of one
    // order rather than the first page of whatever the kernel handed back.
    expect(entries(outcome)[0]?.name).toBe('entry-00000');
  });
});

/**
 * The rule on its own, which is what a session start asks.
 *
 * Every refusal here is the same refusal a browse gets, from the same code, and
 * the tests say so by asserting the same sentences. What is different is what a
 * yes hands back: the path as it was asked for, because that is the string the
 * spawned session will report as its `cwd` and the string the hub keys a
 * project by. A spawn in the resolved path would file every session behind a
 * symlink under no project at all.
 */
describe('the guard a spawn asks', () => {
  it('allows a directory under a root, answering the path that was asked for', async () => {
    const browser = createDirectoryBrowser({
      roots: [WORK],
      reader: createFakeDirectoryReader({ directories: { [WORK]: [], [`${WORK}/agentplex`]: [] } }),
    });

    expect(await browser.allow(`${WORK}/agentplex`)).toEqual({
      ok: true,
      directory: `${WORK}/agentplex`,
    });
  });

  it('answers the asked-for spelling even when the real path is elsewhere', async () => {
    // A link inside a root pointing at another place inside the same root. The
    // containment test runs on what the kernel reaches; what comes back is what
    // the user picked, because that is what the session will report.
    const browser = createDirectoryBrowser({
      roots: [WORK],
      reader: createFakeDirectoryReader({
        directories: { [WORK]: [], [`${WORK}/real`]: [] },
        links: { [`${WORK}/link`]: `${WORK}/real` },
      }),
    });

    expect(await browser.allow(`${WORK}/link`)).toEqual({ ok: true, directory: `${WORK}/link` });
  });

  it('refuses a directory outside every root, in the same words a browse gets', async () => {
    const browser = createDirectoryBrowser({
      roots: [WORK],
      reader: createFakeDirectoryReader({ directories: { [WORK]: [], '/etc': [] } }),
    });

    const refused = await browser.allow('/etc');
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe('refused');
    expect(refused.problem).toContain('not under a directory');
  });

  it('refuses a symlink out of a root, which no string comparison would catch', async () => {
    const browser = createDirectoryBrowser({
      roots: [WORK],
      reader: createFakeDirectoryReader({
        directories: { [WORK]: [], '/elsewhere/secrets': [] },
        links: { [`${WORK}/away`]: '/elsewhere/secrets' },
      }),
    });

    expect(problem(await browser.allow(`${WORK}/away`))).toContain('not under a directory');
  });

  it('refuses a path with nothing at it, and a path that is a file', async () => {
    const browser = createDirectoryBrowser({
      roots: [WORK],
      reader: createFakeDirectoryReader({
        directories: { [WORK]: [] },
        files: [`${WORK}/notes.md`],
      }),
    });

    expect(problem(await browser.allow(`${WORK}/gone`))).toContain('there is nothing at');
    expect(problem(await browser.allow(`${WORK}/notes.md`))).toContain('is not a directory');
  });

  it('refuses everything on a machine nobody configured, and names the setting', async () => {
    // The default a server ships with. A machine with no roots spawns in no
    // directory an instruction names, which is the direction that does not
    // over-claim: the operator has not said this box may run anybody's project.
    const browser = createDirectoryBrowser({
      roots: [],
      reader: createFakeDirectoryReader({ directories: { [WORK]: [] } }),
    });

    expect(problem(await browser.allow(WORK))).toContain('AGENTPLEX_BROWSE_ROOTS');
  });
});
