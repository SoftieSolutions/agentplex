import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { docNameSchema, type DocName } from '@agentplex/protocol';
import { createLogger } from '@agentplex/node-shared';
import { createFakeProjectFiles } from './fake-project-files.js';
import { capturedListing } from './doc-listing.fixture.js';
import { createProjectDocs } from './project-docs.js';
import {
  PROJECT_FILES_DIRECTORY,
  PROJECT_FILE_NAME,
  projectKeyFor,
  projectPath,
} from './project-files.js';

const logger = createLogger('error', () => {});
const DATA_ROOT = '/var/lib/agentplex';
const ROOT = join(DATA_ROOT, PROJECT_FILES_DIRECTORY);
const WORKING_TREE = '/Users/dev/Code/agentplex';

const PLAN: DocName = docNameSchema.parse('plan.md');

/** Where the working tree's documents land, by the same derivation the store uses. */
function folderOf(workingTree: string): string {
  const key = projectKeyFor(workingTree);
  if (!key.ok) throw new Error(key.problem);
  return projectPath(DATA_ROOT, key.projectKey);
}

function docs(files = createFakeProjectFiles()) {
  return { files, docs: createProjectDocs({ dataRoot: DATA_ROOT, files, logger }) };
}

describe('createProjectDocs().write', () => {
  it('makes the project folder on the first write and puts the document in it', async () => {
    const { files, docs: store } = docs();

    const written = await store.write({ directory: WORKING_TREE, name: PLAN, content: '# Plan\n' });

    expect(written.ok).toBe(true);
    expect(files.creates).toEqual([folderOf(WORKING_TREE)]);
    expect(files.written.get(join(folderOf(WORKING_TREE), 'plan.md'))).toBe('# Plan\n');
    // And the note, so the folder can say what it is for.
    expect(files.written.has(join(folderOf(WORKING_TREE), PROJECT_FILE_NAME))).toBe(true);
  });

  it('replaces the document whole and answers with the time of that write', async () => {
    const { files, docs: store } = docs();
    await store.write({ directory: WORKING_TREE, name: PLAN, content: 'first' });

    const again = await store.write({ directory: WORKING_TREE, name: PLAN, content: 'second' });

    expect(files.written.get(join(folderOf(WORKING_TREE), 'plan.md'))).toBe('second');
    const read = await files.readFile(join(folderOf(WORKING_TREE), 'plan.md'));
    expect(again).toEqual({ ok: true, updatedAt: read.kind === 'read' ? read.updatedAt : -1 });
  });

  it('accepts an empty document', async () => {
    const { docs: store } = docs();

    expect((await store.write({ directory: WORKING_TREE, name: PLAN, content: '' })).ok).toBe(true);
  });

  // The rule with the most at stake, against the record of everything that
  // happened. The working tree is the user's repository, and nothing this
  // store does may leave a file in it.
  it('writes under the project root and never in the working tree', async () => {
    const { files, docs: store } = docs();

    await store.write({ directory: WORKING_TREE, name: PLAN, content: 'x' });
    await store.write({ directory: '/srv/other', name: PLAN, content: 'y' });

    for (const path of [...files.creates, ...files.writes, ...files.written.keys()]) {
      expect(path.startsWith(`${ROOT}/`)).toBe(true);
      expect(path.startsWith(WORKING_TREE)).toBe(false);
      expect(path.startsWith('/srv/other')).toBe(false);
    }
  });

  it('refuses the folder note by name, so a document cannot overwrite it', async () => {
    const { files, docs: store } = docs();
    await store.write({ directory: WORKING_TREE, name: PLAN, content: 'x' });
    const note = files.written.get(join(folderOf(WORKING_TREE), PROJECT_FILE_NAME));

    const refused = await store.write({
      directory: WORKING_TREE,
      name: docNameSchema.parse(PROJECT_FILE_NAME),
      content: '{}',
    });

    expect(refused).toMatchObject({ ok: false, code: 'refused' });
    expect(refused.ok ? '' : refused.problem).toContain(PROJECT_FILE_NAME);
    expect(files.written.get(join(folderOf(WORKING_TREE), PROJECT_FILE_NAME))).toBe(note);
  });

  it('says the folder could not be made, as an internal failure, and writes nothing', async () => {
    const { files, docs: store } = docs(
      createFakeProjectFiles({ uncreatable: [folderOf(WORKING_TREE)] }),
    );

    const failed = await store.write({ directory: WORKING_TREE, name: PLAN, content: 'x' });

    expect(failed).toMatchObject({ ok: false, code: 'internal' });
    expect(files.writes).toEqual([]);
  });

  it('says the write failed, as an internal failure, when the disk refused it', async () => {
    const { docs: store } = docs(
      createFakeProjectFiles({ unwritableFiles: [join(folderOf(WORKING_TREE), 'plan.md')] }),
    );

    const failed = await store.write({ directory: WORKING_TREE, name: PLAN, content: 'x' });

    expect(failed).toMatchObject({ ok: false, code: 'internal' });
    expect(failed.ok ? '' : failed.problem).toContain('plan.md');
  });

  it('refuses a directory the key deriver will not take, and makes nothing', async () => {
    const { files, docs: store } = docs();

    const refused = await store.write({ directory: 'relative/tree', name: PLAN, content: 'x' });

    expect(refused).toMatchObject({ ok: false, code: 'refused' });
    expect(files.creates).toEqual([]);
  });
});

describe('createProjectDocs().read', () => {
  it('reads back what was written, with the time it was written', async () => {
    const { docs: store } = docs();
    const written = await store.write({ directory: WORKING_TREE, name: PLAN, content: '# Plan\n' });

    const read = await store.read({ directory: WORKING_TREE, name: PLAN });

    expect(read).toEqual({
      ok: true,
      content: '# Plan\n',
      updatedAt: written.ok ? written.updatedAt : -1,
    });
  });

  it('refuses a document nobody has written, and makes no folder finding out', async () => {
    const { files, docs: store } = docs();

    const refused = await store.read({ directory: WORKING_TREE, name: PLAN });

    expect(refused).toMatchObject({ ok: false, code: 'refused' });
    expect(refused.ok ? '' : refused.problem).toContain('plan.md');
    expect(files.creates).toEqual([]);
  });

  it('refuses the folder note by name: it is not a document', async () => {
    const { docs: store } = docs();
    await store.write({ directory: WORKING_TREE, name: PLAN, content: 'x' });

    const refused = await store.read({
      directory: WORKING_TREE,
      name: docNameSchema.parse(PROJECT_FILE_NAME),
    });

    expect(refused).toMatchObject({ ok: false, code: 'refused' });
  });

  it('says a document that is there and cannot be read is an internal failure', async () => {
    const path = join(folderOf(WORKING_TREE), 'plan.md');
    const { docs: store } = docs(
      createFakeProjectFiles({
        directories: [folderOf(WORKING_TREE)],
        existingFiles: { [path]: 'x' },
        unreadableFiles: [path],
      }),
    );

    expect(await store.read({ directory: WORKING_TREE, name: PLAN })).toMatchObject({
      ok: false,
      code: 'internal',
    });
  });
});

describe('createProjectDocs().list', () => {
  it('answers an empty listing for a project nobody has written to, and makes no folder', async () => {
    const { files, docs: store } = docs();

    expect(await store.list({ directory: WORKING_TREE })).toEqual({ ok: true, entries: [] });
    expect(files.creates).toEqual([]);
  });

  it('lists what was written, by name, with size and write time', async () => {
    const { docs: store } = docs();
    const plan = await store.write({ directory: WORKING_TREE, name: PLAN, content: '# Plan\n' });
    const csv = await store.write({
      directory: WORKING_TREE,
      name: docNameSchema.parse('results.csv'),
      content: '',
    });

    const listed = await store.list({ directory: WORKING_TREE });

    expect(listed).toEqual({
      ok: true,
      entries: [
        { name: 'plan.md', updatedAt: plan.ok ? plan.updatedAt : -1, bytes: 7 },
        { name: 'results.csv', updatedAt: csv.ok ? csv.updatedAt : -1, bytes: 0 },
      ],
    });
  });

  // Against what a real disk said about a folder holding four documents and
  // five things that are not: the note, a temporary file from an interrupted
  // write, a file with no extension, an extension in the wrong case, a hidden
  // file. Each of those is something a folder actually accumulates, and each
  // costs itself and not the listing.
  it('lists only the documents in a folder a real disk described', async () => {
    const { docs: store } = docs(
      createFakeProjectFiles({ listings: { [folderOf(WORKING_TREE)]: capturedListing } }),
    );

    const listed = await store.list({ directory: WORKING_TREE });

    expect(listed.ok ? listed.entries.map((entry) => entry.name) : []).toEqual([
      'notes.txt',
      'plan.md',
      'results.csv',
      'settings.json',
    ]);
    // Verbatim from the disk, not recomputed here.
    const plan =
      capturedListing.kind === 'listed'
        ? capturedListing.entries.find((e) => e.name === 'plan.md')
        : undefined;
    expect(
      listed.ok ? listed.entries.find((entry) => entry.name === 'plan.md') : undefined,
    ).toEqual(plan);
  });

  it('lists one project and not another', async () => {
    const { docs: store } = docs();
    await store.write({ directory: WORKING_TREE, name: PLAN, content: 'x' });
    await store.write({
      directory: '/srv/other',
      name: docNameSchema.parse('other.md'),
      content: 'y',
    });

    const listed = await store.list({ directory: '/srv/other' });

    expect(listed.ok ? listed.entries.map((entry) => entry.name) : []).toEqual(['other.md']);
  });

  it('says a folder that could not be read is an internal failure', async () => {
    const { docs: store } = docs(
      createFakeProjectFiles({
        listings: { [folderOf(WORKING_TREE)]: { kind: 'failed', reason: 'EACCES' } },
      }),
    );

    expect(await store.list({ directory: WORKING_TREE })).toMatchObject({
      ok: false,
      code: 'internal',
    });
  });
});
