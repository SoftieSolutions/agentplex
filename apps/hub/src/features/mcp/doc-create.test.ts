import { docNameSchema, nodeIdSchema, serverRegistrationIdSchema } from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import { createFakeDocs, type FakeDocs } from '../docs/fake-docs.js';
import { docCreateTool } from './doc-create.js';
import { callTool, type ToolCall } from './test-tool-call.js';

/**
 * `doc_create`, against the docs feature's own fake.
 *
 * What it has to get right is the request: a project by node id, a machine by
 * registration id, a parsed name and the content, and nothing else -- there is
 * nowhere on this call to put a directory, which is the rule the document
 * frames are shaped around and which this endpoint may not be the exception
 * to.
 *
 * The refusals are the other half. Each is the docs feature's own sentence
 * passed through whole, because that feature is the one place that knows which
 * machine is away and what the project already holds.
 */

const PROJECT = nodeIdSchema.parse('node-project');
const ATTIC = serverRegistrationIdSchema.parse('registration-attic');
const PLAN = docNameSchema.parse('plan.md');

function creating(docs: FakeDocs, args: Record<string, unknown> = {}): Promise<ToolCall> {
  return callTool(docCreateTool({ docs }), {
    projectId: PROJECT,
    server: ATTIC,
    name: 'plan.md',
    content: '# Plan\n\n- read the failing test\n',
    ...args,
  });
}

describe('doc_create', () => {
  it('asks the feature for exactly what the client frame asks for', async () => {
    const docs = createFakeDocs();

    const answered = (await creating(docs)).structured;

    // The whole request, field by field, because what is not on it is the
    // subject: no directory, no path, no argv and no machine-local anything.
    // The hub turns the project into a path, on the machine that writes.
    expect(docs.created).toEqual([
      {
        nodeId: 'doc-1',
        projectId: PROJECT,
        server: ATTIC,
        name: PLAN,
        content: '# Plan\n\n- read the failing test\n',
      },
    ]);
    expect(answered).toEqual({ docId: 'doc-1' });
  });

  it('refuses a name the project already has on that machine, in the feature words', async () => {
    const docs = createFakeDocs({ label: 'attic' });
    await creating(docs);

    const result = await creating(docs);

    expect(result.isError).toBe(true);
    expect(result.structured).toBeUndefined();
    expect(result.text).toBe('that project already has a document called plan.md on attic');
  });

  it('refuses a project this hub does not have', async () => {
    const docs = createFakeDocs();
    docs.refuseWith({ code: 'refused', problem: 'this hub has no project by that id' });

    const result = await creating(docs);

    expect(result.isError).toBe(true);
    expect(result.text).toBe('this hub has no project by that id');
  });

  it('refuses a machine that is not connected, naming it', async () => {
    const docs = createFakeDocs();
    docs.refuseWith({
      code: 'refused',
      problem:
        'attic is not connected right now, and the hub holds no copy of its documents: ' +
        'the machine that wrote a document is the only one that can answer for it',
    });

    const result = await creating(docs);

    expect(result.isError).toBe(true);
    expect(result.text).toContain('attic is not connected right now');
  });

  it('refuses a name a filesystem would read as something other than a name', async () => {
    // The traversal, refused by the parser before a machine is asked anything.
    // The rule is `doc.ts`'s and this is the endpoint standing on it rather
    // than restating it.
    const docs = createFakeDocs();

    const result = await creating(docs, { name: '../../etc/passwd' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('one path segment');
    expect(docs.created).toHaveLength(0);
  });

  it('refuses a name with no extension this store will take', async () => {
    const docs = createFakeDocs();

    const result = await creating(docs, { name: 'plan.sh' });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('.md, .txt, .json, .csv');
    expect(docs.created).toHaveLength(0);
  });

  it('refuses ids that are not ones, before the feature is asked', async () => {
    const docs = createFakeDocs();

    expect((await creating(docs, { projectId: 'x'.repeat(201) })).text).toBe(
      'a node id is one to two hundred characters',
    );
    expect((await creating(docs, { server: 'x'.repeat(201) })).text).toBe(
      'a server registration id is one to two hundred characters',
    );
    expect(docs.created).toHaveLength(0);
  });

  it('says it acts and takes nothing away, which is what a client asks a person about', () => {
    expect(docCreateTool({ docs: createFakeDocs() }).annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });
});
