import { docNameSchema, nodeIdSchema, serverRegistrationIdSchema } from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import { createFakeDocs, type FakeDocs } from '../docs/fake-docs.js';
import { docReadTool } from './doc-read.js';
import { callTool, type ToolCall } from './test-tool-call.js';

/**
 * `doc_read`, against the docs feature's own fake.
 *
 * Two subjects. The first is the addressing: a node id, or a project and a
 * name, and never both -- and a name that is two documents on two machines is
 * refused rather than resolved to whichever came first, because a project's
 * documents genuinely are one file per machine.
 *
 * The second is the refusal a machine that is away produces. The hub holds no
 * copy of any content, so "that machine is not connected" is the answer and
 * not a stale read -- and it arrives in the feature's own sentence, which is
 * the one that names the machine by the label a person typed.
 */

const PROJECT = nodeIdSchema.parse('node-project');
const ATTIC = serverRegistrationIdSchema.parse('registration-attic');
const WORKSHOP = serverRegistrationIdSchema.parse('registration-workshop');
const PLAN = docNameSchema.parse('plan.md');
const NOTES = docNameSchema.parse('notes.md');

function reading(docs: FakeDocs, args: Record<string, unknown>): Promise<ToolCall> {
  return callTool(docReadTool({ docs }), args);
}

/** One document in the fake, and the node id it was given. */
async function held(docs: FakeDocs, name = PLAN, content = '# Plan\n'): Promise<string> {
  const created = await docs.create(PROJECT, ATTIC, name, content);
  if (!created.ok) throw new Error('the fake refused a create');
  return created.nodeId;
}

interface Read {
  readonly docId: string;
  readonly content: string;
  readonly updatedAt: number;
}

describe('doc_read by node id', () => {
  it('answers with the whole document and the write time the machine reported', async () => {
    const docs = createFakeDocs();
    const docId = await held(docs);

    const answered = (await reading(docs, { docId })).structured as unknown as Read;

    expect(docs.opened).toEqual([docId]);
    expect(answered).toEqual({
      docId,
      content: '# Plan\n',
      updatedAt: expect.any(Number) as unknown as number,
    });
  });

  it('refuses a document on a machine that is away, rather than serving a copy', async () => {
    const docs = createFakeDocs({ label: 'attic' });
    const docId = await held(docs);
    docs.refuseWith({
      code: 'refused',
      problem:
        'attic is not connected right now, and the hub holds no copy of its documents: ' +
        'the machine that wrote a document is the only one that can answer for it',
    });

    const result = await reading(docs, { docId });

    expect(result.isError).toBe(true);
    expect(result.structured).toBeUndefined();
    // The feature's sentence whole, which is the one that names the machine.
    expect(result.text).toContain('attic is not connected right now');
    expect(result.text).toContain('the hub holds no copy of its documents');
  });

  it('refuses an id that is not one, before the feature is asked', async () => {
    const docs = createFakeDocs();

    const result = await reading(docs, { docId: 'x'.repeat(201) });

    expect(result.isError).toBe(true);
    expect(result.text).toBe('a node id is one to two hundred characters');
    expect(docs.opened).toHaveLength(0);
  });
});

describe('doc_read by project and name', () => {
  it('resolves the name through the index and reads the node it found', async () => {
    const docs = createFakeDocs();
    const docId = await held(docs);

    const answered = (await reading(docs, { projectId: PROJECT, name: 'plan.md' }))
      .structured as unknown as Read;

    // The listing is what resolved it, which is the hub asking itself: only the
    // open below crosses to another machine.
    expect(docs.listed).toEqual([PROJECT]);
    expect(answered.docId).toBe(docId);
    expect(answered.content).toBe('# Plan\n');
  });

  it('refuses a name that project does not have, and says where to look', async () => {
    const docs = createFakeDocs();
    await held(docs, NOTES);

    const result = await reading(docs, { projectId: PROJECT, name: 'plan.md' });

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      'that project has no document called plan.md; doc_list says what it has',
    );
    expect(docs.opened).toHaveLength(0);
  });

  it('refuses a name two machines both have, naming them, rather than picking one', async () => {
    // The ordinary shape of this store rather than a corruption: the file store
    // is under each server's own data root, so one project can hold a plan.md
    // per machine. Which one was meant is the caller's to say.
    const docs = createFakeDocs({ label: 'attic' });
    await held(docs);
    docs.hold({
      nodeId: nodeIdSchema.parse('doc-elsewhere'),
      projectId: PROJECT,
      server: WORKSHOP,
      name: PLAN,
      content: '# Another plan\n',
      updatedAt: 1_756_000_000_000,
    });

    const result = await reading(docs, { projectId: PROJECT, name: 'plan.md' });

    expect(result.isError).toBe(true);
    // Both named, neither chosen. The fake answers one label for every machine
    // it holds, so the two read the same here; what is being asserted is the
    // count, the name and the way out, which is the docId.
    expect(result.text).toBe(
      '2 machines in that project have a document called plan.md (attic, attic): ' +
        'name it by docId, which doc_list gives',
    );
    expect(docs.opened).toHaveLength(0);
  });

  it('refuses a name no filesystem would take, before anything is listed', async () => {
    const docs = createFakeDocs();

    const result = await reading(docs, { projectId: PROJECT, name: '../etc/passwd' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('one path segment');
    expect(result.text).toContain('.md, .txt, .json, .csv');
    expect(docs.listed).toHaveLength(0);
  });
});

describe('doc_read on an address it cannot read', () => {
  it('refuses a call that named neither address whole', async () => {
    const docs = createFakeDocs();

    const result = await reading(docs, { projectId: PROJECT });

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      'name a document by docId, or by projectId and name together: doc_list gives both',
    );
  });

  it('refuses a call that named both, rather than letting one quietly win', async () => {
    const docs = createFakeDocs();
    const docId = await held(docs);

    const result = await reading(docs, { docId, projectId: PROJECT, name: 'plan.md' });

    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      'name a document by docId or by projectId and name, not by both: a docId is the whole address',
    );
    expect(docs.opened).toHaveLength(0);
  });

  it('says it only reads, which is what a client asks a person about', () => {
    expect(docReadTool({ docs: createFakeDocs() }).annotations).toEqual({ readOnlyHint: true });
  });
});
