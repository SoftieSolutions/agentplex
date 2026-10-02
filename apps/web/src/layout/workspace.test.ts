import { describe, expect, it } from 'vitest';
import { CATALOGUE_MAX_OPEN_PROJECTS, nodeIdSchema, sessionRefSchema } from '@agentplex/protocol';
import { DEFAULT_TREE, serializePaneLayout, sessionPane, type LayoutTree } from './tree.js';
import { MAX_REMEMBERED_COLLAPSES, parseWorkspace, serializeWorkspace } from './workspace.js';

const SESSION = sessionRefSchema.parse({ storeId: 'store-work', sessionId: 'session-1' });
const ARRANGED: LayoutTree = {
  kind: 'split',
  direction: 'row',
  ratio: 0.4,
  first: sessionPane(SESSION),
  second: { kind: 'pane', content: { type: 'empty' } },
};
const FOLDER = nodeIdSchema.parse('hub-5');
const PROJECT = nodeIdSchema.parse('hub-4');

describe('the blob both arrangements share', () => {
  it('round-trips the panes and what is collapsed', () => {
    const text = serializeWorkspace({
      panes: ARRANGED,
      collapsed: [FOLDER, PROJECT],
      expanded: [],
      rest: {},
    });
    expect(parseWorkspace(text)).toEqual({
      panes: ARRANGED,
      collapsed: [FOLDER, PROJECT],
      expanded: [],
      rest: {},
    });
  });

  it('writes exactly what the build before the section wrote when nothing is collapsed', () => {
    // The section is an addition and not a rewrite: a tab that has collapsed
    // nothing saves the bytes it always saved, so no stored blob changed.
    expect(serializeWorkspace({ panes: ARRANGED, collapsed: [], expanded: [], rest: {} })).toBe(
      serializePaneLayout(ARRANGED),
    );
  });

  it('reads a blob from the build before the section as a tab that collapsed nothing', () => {
    expect(parseWorkspace(serializePaneLayout(ARRANGED))).toEqual({
      panes: ARRANGED,
      collapsed: [],
      expanded: [],
      rest: {},
    });
  });

  it('is the default layout and no collapses when the characters are not a blob at all', () => {
    for (const text of [null, 'weather', '[1,2,3]', '{"v":"one"}']) {
      expect(parseWorkspace(text)).toEqual({
        panes: DEFAULT_TREE,
        collapsed: [],
        expanded: [],
        rest: {},
      });
    }
  });
});

describe('degrading a section it cannot read', () => {
  it('drops an id that is not one and keeps the rest of the list', () => {
    const text = JSON.stringify({
      v: 1,
      root: { kind: 'pane', content: { type: 'empty' } },
      catalogue: { v: 1, collapsed: [FOLDER, 42, '', PROJECT] },
    });
    expect(parseWorkspace(text).collapsed).toEqual([FOLDER, PROJECT]);
  });

  it('keeps a newer section verbatim rather than laundering it away', () => {
    const stranger = { v: 2, closed: ['hub-9'] };
    const text = JSON.stringify({
      v: 1,
      root: { kind: 'pane', content: { type: 'empty' } },
      catalogue: stranger,
      somethingElse: { kept: true },
    });
    const workspace = parseWorkspace(text);
    // Unreadable here, so nothing is claimed about what is collapsed -- and
    // the section itself is written back exactly as it arrived.
    expect(workspace.collapsed).toEqual([]);
    expect(JSON.parse(serializeWorkspace(workspace))).toMatchObject({
      catalogue: stranger,
      somethingElse: { kept: true },
    });
  });

  it('lets this build say what is collapsed over a section it could not read', () => {
    const text = JSON.stringify({
      v: 1,
      root: { kind: 'pane', content: { type: 'empty' } },
      catalogue: { v: 2, closed: ['hub-9'] },
    });
    const workspace = { ...parseWorkspace(text), collapsed: [FOLDER] };
    expect(parseWorkspace(serializeWorkspace(workspace)).collapsed).toEqual([FOLDER]);
  });

  it('never lets a stranger section overwrite the panes', () => {
    // `v` and `root` are the envelope's, whatever a section calls itself.
    const workspace = {
      panes: ARRANGED,
      collapsed: [],
      expanded: [],
      rest: { v: 99, root: { kind: 'pane', content: { type: 'empty' } } },
    };
    expect(parseWorkspace(serializeWorkspace(workspace)).panes).toEqual(ARRANGED);
  });
});

describe('the bound on what is remembered', () => {
  it('keeps the newest and forgets the stalest, on the way out and back in', () => {
    const many = Array.from({ length: MAX_REMEMBERED_COLLAPSES + 10 }, (_, index) =>
      nodeIdSchema.parse(`hub-${String(index)}`),
    );
    const text = serializeWorkspace({
      panes: DEFAULT_TREE,
      collapsed: many,
      expanded: [],
      rest: {},
    });
    const kept = parseWorkspace(text).collapsed;
    expect(kept).toHaveLength(MAX_REMEMBERED_COLLAPSES);
    expect(kept.at(-1)).toBe(many.at(-1));
    expect(kept).not.toContain(many[0]);
  });
});

/**
 * The projects section: which projects this user has opened.
 *
 * The opposite of the catalogue section, deliberately, and the tests below
 * hold each half of that rule to the same degradations the collapses meet.
 */
describe('the projects that are open', () => {
  const HOME = nodeIdSchema.parse('home');

  it('round-trips under its own key, beside what is collapsed', () => {
    const text = serializeWorkspace({
      panes: ARRANGED,
      collapsed: [FOLDER],
      expanded: [PROJECT, HOME],
      rest: {},
    });
    expect(JSON.parse(text)).toMatchObject({ projects: { v: 1, expanded: [PROJECT, HOME] } });
    expect(parseWorkspace(text)).toEqual({
      panes: ARRANGED,
      collapsed: [FOLDER],
      expanded: [PROJECT, HOME],
      rest: {},
    });
  });

  it('reads a blob with no projects section as nothing open', () => {
    const text = serializeWorkspace({
      panes: ARRANGED,
      collapsed: [FOLDER],
      expanded: [],
      rest: {},
    });
    expect(JSON.parse(text)).not.toHaveProperty('projects');
    expect(parseWorkspace(text).expanded).toEqual([]);
  });

  it('keeps a section at a version it does not know verbatim, and reads it as nothing open', () => {
    const stranger = { v: 2, opened: ['hub-9'] };
    const text = JSON.stringify({
      v: 1,
      root: { kind: 'pane', content: { type: 'empty' } },
      projects: stranger,
    });
    const workspace = parseWorkspace(text);
    expect(workspace.expanded).toEqual([]);
    expect(workspace.rest).toEqual({ projects: stranger });
    expect(JSON.parse(serializeWorkspace(workspace))).toMatchObject({ projects: stranger });
  });

  it('drops an entry that is not an id and keeps the rest of the list', () => {
    const text = JSON.stringify({
      v: 1,
      root: { kind: 'pane', content: { type: 'empty' } },
      projects: { v: 1, expanded: [PROJECT, 7, '', null, HOME, PROJECT] },
    });
    const workspace = parseWorkspace(text);
    expect(workspace.expanded).toEqual([PROJECT, HOME]);
    expect(workspace.rest).toEqual({});
  });

  it('is bounded by what a query may name, dropping the oldest first', () => {
    const many = Array.from({ length: CATALOGUE_MAX_OPEN_PROJECTS + 3 }, (_, index) =>
      nodeIdSchema.parse(`project-${String(index)}`),
    );
    const text = serializeWorkspace({
      panes: DEFAULT_TREE,
      collapsed: [],
      expanded: many,
      rest: {},
    });
    const kept = parseWorkspace(text).expanded;
    expect(kept).toHaveLength(CATALOGUE_MAX_OPEN_PROJECTS);
    expect(kept.at(-1)).toBe(many.at(-1));
    expect(kept).not.toContain(many[0]);

    const stored = JSON.stringify({
      v: 1,
      root: { kind: 'pane', content: { type: 'empty' } },
      projects: { v: 1, expanded: many },
    });
    expect(parseWorkspace(stored).expanded).toEqual(many.slice(-CATALOGUE_MAX_OPEN_PROJECTS));
  });
});
