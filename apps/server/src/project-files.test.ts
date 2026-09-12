import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROJECT_FILES_DIRECTORY,
  PROJECT_FILE_NAME,
  ensureProjectFiles,
  parseProjectFile,
  parseProjectKey,
  projectFilesRoot,
  projectKeyFor,
  projectPath,
} from './project-files.js';
import type { ProjectKey } from './project-files.js';
import { createFakeProjectFiles } from './fake-project-files.js';

const DATA_ROOT = '/var/lib/agentplex';
const ROOT = join(DATA_ROOT, PROJECT_FILES_DIRECTORY);

/** The one path into a directory name. Everything below is about what it says no to. */
function keyOf(name: string): ProjectKey {
  const parsed = parseProjectKey(name);
  if (!parsed.ok) throw new Error(`expected ${name} to be a project key: ${parsed.problem}`);
  return parsed.projectKey;
}

function derivedKey(workingTree: string): ProjectKey {
  const derived = projectKeyFor(workingTree);
  if (!derived.ok) throw new Error(`expected a key for ${workingTree}: ${derived.problem}`);
  return derived.projectKey;
}

describe('parseProjectKey', () => {
  it('takes the shape the deriver produces', () => {
    expect(keyOf('agentplex-9f86d081a1b2c3d4')).toBe('agentplex-9f86d081a1b2c3d4');
    expect(keyOf('a')).toBe('a');
    expect(keyOf('0')).toBe('0');
  });

  // The list below is the reason this file exists. Each entry is a string that
  // has been a directory traversal in somebody's program, and the assertion is
  // that none of them can ever be the name of a directory this server makes.
  it.each([
    ['an empty name, which joins to the parent directory itself', ''],
    ['a parent reference', '..'],
    ['the current directory', '.'],
    ['a name that is only dots', '....'],
    ['a traversal', '../../etc'],
    ['a separator', 'work/notes'],
    ['a leading separator, which is an absolute path', '/etc/passwd'],
    ['a trailing separator', 'work/'],
    ['a backslash, which is a separator on the disk a volume came from', 'work\\notes'],
    ['a backslash traversal', '..\\..\\windows'],
    ['a drive letter', 'c:work'],
    ['a NUL byte, which truncates a path inside a syscall', 'work\u0000/etc'],
    ['a newline, which would end the name early in a log line', 'work\n'],
    ['a leading newline', '\nwork'],
    ['a space', 'my project'],
    ['a leading hyphen, which a program would read as a flag', '-rf'],
    ['a trailing hyphen', 'work-'],
    ['a doubled hyphen, which is not what the deriver emits', 'work--notes'],
    ['a leading dot, which would hide the directory', '.work'],
    ['a dot inside the name', 'work.notes'],
    ['a tilde, which a shell would expand', '~'],
    ['an upper-case letter, which is a second name for one directory on macOS', 'Work'],
  ])('refuses %s', (_why, name) => {
    expect(parseProjectKey(name).ok).toBe(false);
  });

  it('refuses a name longer than a filesystem will take', () => {
    expect(parseProjectKey('a'.repeat(101)).ok).toBe(false);
  });

  // NFC and NFD are the same word and two different byte strings, and macOS and
  // Linux disagree about which one a filesystem stores. Refusing both is what
  // keeps a directory this server made from having two spellings: a key is
  // ASCII, so the question never arises about anything under the project root.
  it('refuses both Unicode spellings of one name, so no directory has two', () => {
    const composed = 'caf\u00e9';
    const decomposed = 'cafe\u0301';

    expect(composed.normalize('NFD')).toBe(decomposed);
    expect(parseProjectKey(composed).ok).toBe(false);
    expect(parseProjectKey(decomposed).ok).toBe(false);
  });

  it('says what was wrong with the name it refused', () => {
    const parsed = parseProjectKey('../etc');

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.problem).toContain('../etc');
  });
});

describe('projectPath', () => {
  it('is the project root and one segment, for every name the parser took', () => {
    for (const name of ['a', 'agentplex-9f86d081a1b2c3d4', 'x-1-2-3']) {
      expect(projectPath(DATA_ROOT, keyOf(name))).toBe(join(ROOT, name));
    }
  });

  it('stays under the project root for a key derived from a hostile path', () => {
    // Not because the join is careful, but because the name reaching it went
    // through the parser. This is the assertion the parser is for.
    const path = projectPath(DATA_ROOT, derivedKey('/srv/../../etc/../passwd'));

    expect(path.startsWith(`${ROOT}/`)).toBe(true);
    expect(path.slice(ROOT.length + 1)).not.toContain('/');
  });

  it('puts the project root under the data root and nowhere else', () => {
    expect(projectFilesRoot(DATA_ROOT)).toBe(ROOT);
    expect(PROJECT_FILES_DIRECTORY).not.toContain('.agentplex');
  });
});

describe('projectKeyFor', () => {
  it('derives a name the parser takes, from the working tree and nothing else', () => {
    expect(parseProjectKey(derivedKey('/Users/dev/Code/agentplex')).ok).toBe(true);
  });

  it('names the working tree in the key, so a person can read the directory', () => {
    expect(derivedKey('/Users/dev/Code/agentplex')).toMatch(/^agentplex-[0-9a-f]{16}$/);
  });

  it('gives one working tree one key, every time it is asked', () => {
    expect(derivedKey('/srv/work')).toBe(derivedKey('/srv/work'));
  });

  it('gives two working trees with one basename two keys', () => {
    expect(derivedKey('/srv/one/work')).not.toBe(derivedKey('/srv/two/work'));
  });

  it('reads a trailing separator and a redundant segment as the path they spell', () => {
    expect(derivedKey('/srv/work/')).toBe(derivedKey('/srv/work'));
    expect(derivedKey('/srv/./other/../work')).toBe(derivedKey('/srv/work'));
  });

  // The direction this degrades in. Two spellings that name one directory on a
  // case-insensitive or normalising filesystem get two folders; one folder
  // holding two projects' notes would be the other direction, and that one is a
  // leak rather than a duplicate.
  it('keeps two byte-different paths apart rather than guessing they are one', () => {
    expect(derivedKey('/srv/Work')).not.toBe(derivedKey('/srv/work'));
    expect(derivedKey('/srv/caf\u00e9')).not.toBe(derivedKey('/srv/cafe\u0301'));
  });

  it('leaves no Unicode in the key, whichever spelling the path arrived in', () => {
    for (const name of ['/srv/caf\u00e9', '/srv/cafe\u0301', '/srv/\u4f5c\u696d']) {
      expect(parseProjectKey(derivedKey(name)).ok).toBe(true);
    }
  });

  it.each([
    ['a parent reference', '/srv/work/../..'],
    ['a name that is only dots', '/srv/....'],
    ['a name full of separators it cannot keep', '/srv/my project (v2)!'],
    ['a name that is entirely punctuation', '/srv/---'],
    ['a name longer than a filesystem will take', `/srv/${'a'.repeat(300)}`],
    ['the filesystem root', '/'],
  ])('takes %s and still produces a name the parser takes', (_why, workingTree) => {
    expect(parseProjectKey(derivedKey(workingTree)).ok).toBe(true);
  });

  it.each([
    ['an empty working tree', ''],
    ['a relative working tree, which names no directory on its own', 'work'],
    ['a working tree that is only a parent reference', '../work'],
    ['a working tree with a NUL byte in it', '/srv/work\u0000/etc'],
  ])('refuses %s', (_why, workingTree) => {
    expect(projectKeyFor(workingTree).ok).toBe(false);
  });

  it('derives without touching the disk, so a removed working tree keeps its folder', () => {
    expect(derivedKey('/srv/gone-yesterday')).toBe(derivedKey('/srv/gone-yesterday'));
  });
});

describe('ensureProjectFiles', () => {
  const WORKING_TREE = '/Users/dev/Code/agentplex';

  it('makes the folder, and every directory above it, on first use', async () => {
    const files = createFakeProjectFiles();

    const result = await ensureProjectFiles(DATA_ROOT, WORKING_TREE, files);

    expect(result.ok).toBe(true);
    expect(result.ok ? result.created : false).toBe(true);
    expect(result.ok ? result.path : '').toBe(join(ROOT, derivedKey(WORKING_TREE)));
  });

  it('takes the folder that is already there, which is every use after the first', async () => {
    const files = createFakeProjectFiles();
    await ensureProjectFiles(DATA_ROOT, WORKING_TREE, files);

    const again = await ensureProjectFiles(DATA_ROOT, WORKING_TREE, files);

    expect(again.ok).toBe(true);
    expect(again.ok ? again.created : true).toBe(false);
  });

  it('records the working tree in the folder, so the folder says what it is for', async () => {
    const files = createFakeProjectFiles();

    const result = await ensureProjectFiles(DATA_ROOT, WORKING_TREE, files);

    const written = files.written.get(join(result.ok ? result.path : '', PROJECT_FILE_NAME));
    const parsed = parseProjectFile(written ?? '');
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.file.workingTree : '').toBe(WORKING_TREE);
    expect(parsed.ok ? parsed.file.projectKey : '').toBe(derivedKey(WORKING_TREE));
  });

  // The rule this whole directory exists to keep. A session's working tree is
  // the user's repository, and the day this server leaves a file in one is the
  // day it becomes a program that edits projects nobody asked it to.
  it('writes nothing in the working tree', async () => {
    const files = createFakeProjectFiles();

    await ensureProjectFiles(DATA_ROOT, WORKING_TREE, files);

    for (const path of [...files.creates, ...files.written.keys()]) {
      expect(path.startsWith(`${ROOT}/`)).toBe(true);
    }
  });

  it('leaves a project file that is already there alone', async () => {
    const path = join(ROOT, derivedKey(WORKING_TREE), PROJECT_FILE_NAME);
    const files = createFakeProjectFiles({
      existingFiles: { [path]: 'written by an older build' },
    });

    await ensureProjectFiles(DATA_ROOT, WORKING_TREE, files);

    expect(files.written.get(path)).toBe('written by an older build');
  });

  it('refuses a working tree it cannot name, and makes no directory for it', async () => {
    const files = createFakeProjectFiles();

    const result = await ensureProjectFiles(DATA_ROOT, 'work', files);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.problem).toContain('absolute');
    expect(files.creates).toEqual([]);
  });

  it('refuses when the folder cannot be made, naming the path and the reason', async () => {
    const path = join(ROOT, derivedKey(WORKING_TREE));
    const files = createFakeProjectFiles({ uncreatable: [path] });

    const result = await ensureProjectFiles(DATA_ROOT, WORKING_TREE, files);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.problem).toContain(path);
  });

  it('refuses when something that is not a directory is in the way', async () => {
    const path = join(ROOT, derivedKey(WORKING_TREE));
    const files = createFakeProjectFiles({ notDirectories: [path] });

    const result = await ensureProjectFiles(DATA_ROOT, WORKING_TREE, files);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.problem).toContain('not a directory');
  });

  // A folder with no note in it is still a folder to write into. Failing the
  // whole call over the label would cost the thing the label is about.
  it('keeps the folder when only the note could not be written', async () => {
    const path = join(ROOT, derivedKey(WORKING_TREE));
    const files = createFakeProjectFiles({ unwritableFiles: [join(path, PROJECT_FILE_NAME)] });

    const result = await ensureProjectFiles(DATA_ROOT, WORKING_TREE, files);

    expect(result.ok).toBe(true);
    expect(result.ok ? result.described : true).toBe(false);
  });
});

describe('parseProjectFile', () => {
  it('reads back what was written', async () => {
    const files = createFakeProjectFiles();
    const result = await ensureProjectFiles(DATA_ROOT, '/srv/work', files);
    const contents = files.written.get(join(result.ok ? result.path : '', PROJECT_FILE_NAME));

    const parsed = parseProjectFile(contents ?? '');

    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.file.workingTree : '').toBe('/srv/work');
  });

  it.each([
    ['something that is not JSON', 'not json'],
    ['a JSON value that is not an object', '"work"'],
    ['an object with no working tree', '{"projectKey":"work-0123456789abcdef"}'],
    ['an object whose key is a traversal', '{"projectKey":"../etc","workingTree":"/srv/work"}'],
    [
      'an object with an empty working tree',
      '{"projectKey":"work-0123456789abcdef","workingTree":""}',
    ],
  ])('refuses %s', (_why, contents) => {
    expect(parseProjectFile(contents).ok).toBe(false);
  });
});
