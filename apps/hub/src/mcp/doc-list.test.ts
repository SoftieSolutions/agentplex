import { docNameSchema, nodeIdSchema, serverRegistrationIdSchema } from '@agentplex/protocol';
import { describe, expect, it } from 'vitest';
import { createFakeDocs, type FakeDocs } from '../docs/fake-docs.js';
import { docListTool, type DocRow } from './doc-list.js';
import { callTool } from './test-tool-call.js';

/**
 * `doc_list`, against the docs feature's own fake.
 *
 * The subject is the one thing this tool claims that no other document tool
 * does: it answers out of the hub's index, so a project's documents are
 * listable while the machine holding them is away -- and every row says which
 * machine and whether that machine can be reached, so the claim is readable
 * for what it is rather than mistaken for "this content is available".
 */

const PROJECT = nodeIdSchema.parse('node-project');
const ATTIC = serverRegistrationIdSchema.parse('registration-attic');
const WORKSHOP = serverRegistrationIdSchema.parse('registration-workshop');
const PLAN = docNameSchema.parse('plan.md');

function listing(docs: FakeDocs, args: Record<string, unknown> = {}) {
  return callTool(docListTool({ docs }), { projectId: PROJECT, ...args });
}

interface Listed {
  readonly docs: readonly DocRow[];
}

describe('doc_list', () => {
  it('answers with a row per document, naming the machine each is on', async () => {
    const docs = createFakeDocs({ label: 'attic' });
    await docs.create(PROJECT, ATTIC, PLAN, '# Plan\n');

    const answered = (await listing(docs)).structured as unknown as Listed;

    expect(docs.listed).toEqual([PROJECT]);
    expect(answered.docs).toEqual([
      {
        docId: 'doc-1',
        name: 'plan.md',
        server: ATTIC,
        label: 'attic',
        reachable: true,
        updatedAt: expect.any(Number) as unknown as number,
      },
    ]);
  });

  it('is an empty listing for a project with nothing in it, not a refusal', async () => {
    // "There are no documents" and "that project does not exist" are different
    // facts, and a caller has to handle the empty list anyway.
    const answered = (await listing(createFakeDocs())).structured as unknown as Listed;

    expect(answered.docs).toEqual([]);
  });

  it('lists a document on a machine that is away, with reachable saying so', async () => {
    // The whole value of the index in one assertion. The fake holds the row and
    // the listing answers it; what the row does not claim is that the content
    // can be had right now, which is what `reachable` is for.
    const docs = createFakeDocs({ label: 'workshop' });
    docs.hold({
      nodeId: nodeIdSchema.parse('doc-away'),
      projectId: PROJECT,
      server: WORKSHOP,
      name: PLAN,
      content: '# Plan\n',
      updatedAt: 1_756_000_000_000,
    });

    const answered = (await listing(docs)).structured as unknown as Listed;

    expect(answered.docs).toEqual([
      {
        docId: 'doc-away',
        name: 'plan.md',
        server: WORKSHOP,
        label: 'workshop',
        reachable: true,
        updatedAt: 1_756_000_000_000,
      },
    ]);
  });

  it('passes the feature refusal through, in the feature own words', async () => {
    const docs = createFakeDocs();
    docs.refuseWith({ code: 'refused', problem: 'this hub has no project by that id' });

    const result = await listing(docs);

    expect(result.isError).toBe(true);
    expect(result.structured).toBeUndefined();
    expect(result.text).toBe('this hub has no project by that id');
  });

  it('refuses an id that is not one, before the feature is asked', async () => {
    const docs = createFakeDocs();

    const result = await listing(docs, { projectId: 'x'.repeat(201) });

    expect(result.isError).toBe(true);
    expect(result.text).toBe('a node id is one to two hundred characters');
    expect(docs.listed).toHaveLength(0);
  });

  it('says it only reads, which is what a client asks a person about', () => {
    expect(docListTool({ docs: createFakeDocs() }).annotations).toEqual({ readOnlyHint: true });
  });
});
