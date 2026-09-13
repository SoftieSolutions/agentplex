import { describe, expect, it } from 'vitest';
import { nodeIdSchema, parseHubFrame, parseTextFrame, type Layout } from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { documentName, projectDocuments } from './doc-rows.js';

/**
 * The document rows, read out of a tree a real hub sent.
 *
 * The layout fixture was captured after a real project create and a real
 * document create (`tests/hub-server/src/capture-client-fixtures.test.ts`), so
 * what these assertions stand on is the node the hub actually writes for a
 * document -- its kind, its parent and the name it carries -- rather than one
 * shaped to match this module.
 */

function layoutFrom(text: string): Layout {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'layout') {
    throw new Error('the fixture is not a layout frame');
  }
  return parsed.value.nodes;
}

const withProject = layoutFrom(hubFrames.layoutWithProject);
const empty = layoutFrom(hubFrames.layout);

describe('the documents under a project', () => {
  it('groups the tree by project, keeping the hub order', () => {
    expect(projectDocuments(withProject)).toEqual([
      {
        projectId: 'hub-4',
        label: 'agentplex (main checkout)',
        docs: [{ nodeId: 'hub-5', name: 'plan.md' }],
      },
    ]);
  });

  it('lists a project with no documents rather than dropping it', () => {
    // The New doc action hangs off a project row, so a project that holds
    // nothing yet is exactly the row somebody needs to find.
    const noDocs = withProject.filter((node) => node.kind !== 'doc');
    expect(projectDocuments(noDocs)).toEqual([
      { projectId: 'hub-4', label: 'agentplex (main checkout)', docs: [] },
    ]);
  });

  it('has nothing to say about a tree with no projects, or no tree at all', () => {
    expect(projectDocuments(empty)).toEqual([]);
    expect(projectDocuments(null)).toEqual([]);
  });

  it('skips a document whose parent is no project this client can place', () => {
    // The row costs itself and not the listing: the project it names is not in
    // this tree, and putting it somewhere invented would be worse than a row
    // this client cannot draw.
    const orphaned = withProject.map((node) =>
      node.kind === 'doc' ? { ...node, parentId: nodeIdSchema.parse('hub-404') } : node,
    );
    expect(projectDocuments(orphaned)).toEqual([
      { projectId: 'hub-4', label: 'agentplex (main checkout)', docs: [] },
    ]);
  });
});

describe('naming one document', () => {
  it('answers with the file name the tree carries', () => {
    expect(documentName(withProject, nodeIdSchema.parse('hub-5'))).toBe('plan.md');
  });

  it('answers null for a node that is not a document, and for no tree', () => {
    expect(documentName(withProject, nodeIdSchema.parse('hub-4'))).toBeNull();
    expect(documentName(withProject, nodeIdSchema.parse('hub-404'))).toBeNull();
    expect(documentName(null, nodeIdSchema.parse('hub-5'))).toBeNull();
  });
});
