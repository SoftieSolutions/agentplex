import { docNameSchema, nodeIdSchema, serverRegistrationIdSchema } from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import { createFakeDocs, type FakeDocs } from '../docs/fake-docs.js';
import { docUpdateTool } from './doc-update.js';
import { callTool, type ToolCall } from './test-tool-call.js';

/**
 * `doc_update`, against the docs feature's own fake.
 *
 * The subject is the one thing a caller has to understand before it uses this:
 * the content it sends is what the file becomes. There is no patch form on the
 * wire and none here, and the assertion below is that a second save leaves the
 * second content and not the two of them.
 *
 * The node is the whole address, and that is the other assertion: the request
 * carries an id and the content, and nothing restating which project, which
 * machine or what the file is called -- because an argument that restated any
 * of those would be an argument that could redirect a write.
 */

const PROJECT = nodeIdSchema.parse('node-project');
const ATTIC = serverRegistrationIdSchema.parse('registration-attic');
const PLAN = docNameSchema.parse('plan.md');

function updating(docs: FakeDocs, args: Record<string, unknown>): Promise<ToolCall> {
  return callTool(docUpdateTool({ docs }), args);
}

async function held(docs: FakeDocs): Promise<string> {
  const created = await docs.create(PROJECT, ATTIC, PLAN, '# Plan\n');
  if (!created.ok) throw new Error('the fake refused a create');
  return created.nodeId;
}

interface Saved {
  readonly docId: string;
  readonly updatedAt: number;
}

describe('doc_update', () => {
  it('names the node and the content, and nothing else about where it lands', async () => {
    const docs = createFakeDocs();
    const docId = await held(docs);

    const answered = (await updating(docs, { docId, content: '# Plan\n\n- done\n' }))
      .structured as unknown as Saved;

    expect(docs.saved).toEqual([{ nodeId: docId, content: '# Plan\n\n- done\n' }]);
    expect(answered.docId).toBe(docId);
    expect(answered.updatedAt).toEqual(expect.any(Number));
  });

  it('replaces the document whole, so the last save is the file', async () => {
    const docs = createFakeDocs();
    const docId = await held(docs);

    await updating(docs, { docId, content: 'first\n' });
    await updating(docs, { docId, content: 'second\n' });
    const opened = await docs.open(nodeIdSchema.parse(docId));

    // Not appended and not merged. An agent that sends a fragment has deleted
    // the rest of the document, which is why the tool description says so in
    // those words.
    expect(opened.ok && opened.content).toBe('second\n');
  });

  it('carries the write time the machine recorded, not the hub receipt time', async () => {
    const docs = createFakeDocs({ updatedAt: 1_756_000_000_000 });
    const docId = await held(docs);

    const first = (await updating(docs, { docId, content: 'one\n' }))
      .structured as unknown as Saved;
    const second = (await updating(docs, { docId, content: 'two\n' }))
      .structured as unknown as Saved;

    // Two writes, two times, and the second is later: the number a person reads
    // as "edited two minutes ago" moves on every save, which is the reason this
    // tool does not claim to be idempotent.
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
  });

  it('refuses a document this hub has no node for', async () => {
    const docs = createFakeDocs();

    const result = await updating(docs, { docId: 'doc-nobody-has', content: 'x' });

    expect(result.isError).toBe(true);
    expect(result.structured).toBeUndefined();
    expect(result.text).toBe('this fake holds no document doc-nobody-has');
  });

  it('refuses a document on a machine that is away, rather than writing an index row', async () => {
    const docs = createFakeDocs({ label: 'attic' });
    const docId = await held(docs);
    docs.refuseWith({
      code: 'refused',
      problem:
        'attic is not connected right now, and the hub holds no copy of its documents: ' +
        'the machine that wrote a document is the only one that can answer for it',
    });

    const result = await updating(docs, { docId, content: 'x' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('attic is not connected right now');
  });

  it('refuses an id that is not one, before the feature is asked', async () => {
    const docs = createFakeDocs();

    const result = await updating(docs, { docId: 'x'.repeat(201), content: 'x' });

    expect(result.isError).toBe(true);
    expect(result.text).toBe('a node id is one to two hundred characters');
    expect(docs.saved).toHaveLength(0);
  });

  it('says it acts, takes nothing away, and is not a no-op done twice', () => {
    expect(docUpdateTool({ docs: createFakeDocs() }).annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });

  it('tells a model, in the description it reads, that a save is the whole document', () => {
    // The one place this rule can reach the party that has to keep it. A model
    // choosing this tool reads the description and the argument's own text, and
    // a comment in this file would reach neither.
    const tool = docUpdateTool({ docs: createFakeDocs() });

    expect(tool.description).toContain('whole');
    expect(tool.description).toContain('no patch form');
    // And again on the argument itself, which is the line a model reads beside
    // the value it is about to fill in.
    expect(tool.input.content?.description).toContain('not the part that changed');
  });
});
