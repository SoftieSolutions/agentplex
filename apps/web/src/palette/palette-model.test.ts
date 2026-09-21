import { describe, expect, it } from 'vitest';
import {
  nodeKindSchema,
  parseHubFrame,
  parseTextFrame,
  type MachineState,
  type NodeKind,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import {
  listSessions,
  matchesSearch,
  NO_FILTERS,
  visibleSessions,
  type SessionListItem,
} from '../sessions/session-list-model.js';
import { sessionHash } from '../terminal/session-route.js';
import { DOC_KIND, SESSION_KIND } from '../tree/node-kinds.js';
import { catalogueResults } from './palette-search.js';
import {
  firstResult,
  headingFor,
  lastResult,
  mergeResults,
  nextResult,
  paletteListing,
  PALETTE_RESULT_LIMIT,
  previousResult,
  sessionResults,
  type PaletteResult,
} from './palette-model.js';

/**
 * The fleet here is a captured machine-state frame a real hub assembled from
 * real store reports (hub-frames.fixture.ts): two machines, two stores, six
 * sessions, two of which want a human.
 */

function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the fixture is not a machine-state frame');
  }
  return parsed.value.state;
}

const populated = stateFrom(hubFrames.machineStatePopulated);
const sessions = listSessions(populated);

function item(name: string): SessionListItem {
  const found = sessions.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`the fixture has no session called ${name}`);
  return found;
}

function labels(results: readonly PaletteResult[]): readonly string[] {
  return results.map((result) => result.label);
}

describe('the resting list', () => {
  it('answers an empty query with the needs-you sessions first, then the rest by activity', () => {
    expect(labels(sessionResults(sessions, ''))).toEqual([
      'migrate-db-v9',
      'docs-sweep',
      'fix-auth-refresh',
      'bench-tokenizer',
      'session-train-lora',
      'spike-wasm',
    ]);
  });

  it('treats a query of nothing but whitespace as no query at all', () => {
    expect(labels(sessionResults(sessions, '   '))).toEqual(labels(sessionResults(sessions, '')));
  });
});

describe('matching', () => {
  it('admits exactly what the session list’s own filter admits', () => {
    for (const query of ['universe', 'GPU-BOX-01', 'db', 'awaiting', 'nothing-matches-this']) {
      const byModel = new Set(sessionResults(sessions, query).map((result) => result.label));
      const byFilter = sessions.filter((candidate) => matchesSearch(candidate, query));
      expect([...byModel].sort()).toEqual([...new Set(byFilter.map((each) => each.name))].sort());
    }
  });

  it('finds a session by a field no name carries, because the matcher is the shared one', () => {
    // `store-universe` is a storeId and appears in no session name.
    expect(labels(sessionResults(sessions, 'store-universe'))).toEqual([
      'docs-sweep',
      'bench-tokenizer',
      'session-train-lora',
    ]);
  });

  it('keeps the resting order inside a query’s answer', () => {
    expect(labels(sessionResults(sessions, 'agentplex'))).toEqual([
      'migrate-db-v9',
      'fix-auth-refresh',
      'spike-wasm',
    ]);
  });
});

describe('a result', () => {
  it('names its kind and carries the label, the second line and the href', () => {
    const [top] = sessionResults(sessions, 'migrate-db');
    expect(top).toEqual({
      id: 'session:["store-agentplex","session-migrate-db"]',
      kind: 'session',
      label: 'migrate-db-v9',
      detail: 'store-agentplex · mbp-robert · awaiting permission',
      href: '#/session/store-agentplex/session-migrate-db',
    });
  });

  it('takes the href from sessionHash rather than composing a second address', () => {
    for (const result of sessionResults(sessions, '')) {
      expect(result.href).toBe(sessionHash(item(result.label).ref));
    }
  });

  it('namespaces its id by kind, so another kind’s result cannot collide', () => {
    const ids = sessionResults(sessions, '').map((result) => result.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith('session:'))).toBe(true);
  });
});

describe('the listing', () => {
  it('bounds what it hands the dialog and says how many matched', () => {
    const results = sessionResults(sessions, '');
    const listing = paletteListing(results, 3);
    expect(labels(listing.results)).toEqual(['migrate-db-v9', 'docs-sweep', 'fix-auth-refresh']);
    expect(listing.total).toBe(6);
  });

  it('leaves a short list alone under the default bound', () => {
    const listing = paletteListing(sessionResults(sessions, ''));
    expect(listing.results.length).toBe(6);
    expect(listing.total).toBe(6);
    expect(PALETTE_RESULT_LIMIT).toBeGreaterThan(1);
  });

  it('keeps the order it is given, so a caller decides which kind leads', () => {
    // Two groups concatenated by the caller, the way AGX-140 will put the
    // hub-answered kinds beside the client-held ones. The listing re-orders
    // nothing: `docs-sweep` is the later session of the two by activity and
    // still comes first here, because it was handed over first.
    const merged = paletteListing([
      ...sessionResults(sessions, 'docs-sweep'),
      ...sessionResults(sessions, 'migrate-db'),
    ]);
    expect(labels(merged.results)).toEqual(['docs-sweep', 'migrate-db-v9']);
  });
});

describe('the two halves, merged', () => {
  /**
   * The hub-answered half, out of a page a real hub sent: one session -- which
   * the client also holds -- and one document.
   */
  function hubAnswered(): readonly PaletteResult[] {
    const parsed = parseTextFrame(parseHubFrame, hubFrames.cataloguePage);
    if (!parsed.ok || parsed.value.type !== 'catalogue-page') {
      throw new Error('the fixture is not a catalogue page');
    }
    return catalogueResults(parsed.value.items);
  }

  it('holds a session found in both halves once, keeping the client-held row', () => {
    const client = sessionResults(sessions, 'spike');
    const hub = hubAnswered();
    expect(hub.map((result) => result.id)).toContain(client[0]?.id);

    const merged = mergeResults(client, hub);

    expect(merged.filter((result) => result.id === client[0]?.id)).toHaveLength(1);
    // The client-held row wins because it says more: it names the machine the
    // session is on, which a `groupBy: 'none'` page carries no group to read.
    expect(merged[0]?.detail).toBe(client[0]?.detail);
    expect(merged[0]?.detail).toContain('mbp-robert');
  });

  it('keeps a hub-answered row the client holds nothing for', () => {
    const merged = mergeResults(sessionResults(sessions, 'spike'), hubAnswered());
    expect(labels(merged)).toEqual(['spike-wasm', 'plan.md']);
  });

  it('is the client-held half when the hub has answered nothing', () => {
    const client = sessionResults(sessions, '');
    expect(mergeResults(client, [])).toEqual(client);
  });
});

describe('grouping by kind', () => {
  const doc: PaletteResult = {
    id: 'doc:hub-6',
    kind: DOC_KIND,
    label: 'spike-wasm',
    detail: 'Document',
    href: '#/doc/hub-6',
  };

  it('names each kind in the words the app uses for it', () => {
    expect(headingFor(SESSION_KIND)).toBe('Sessions');
    expect(headingFor(DOC_KIND)).toBe('Documents');
  });

  it('labels a kind this build has never heard of with the kind itself', () => {
    // A kind is a row in the hub's table, so a later one arrives without a
    // release here: it is drawn under its own name rather than dropped or
    // labelled with a guess. `node-kinds.ts` argues why that is possible.
    const graph: NodeKind = nodeKindSchema.parse('graph');
    expect(headingFor(graph)).toBe('graph');
  });

  it('gathers each kind under one heading, in the order the kinds first appear', () => {
    const listing = paletteListing(mergeResults(sessionResults(sessions, ''), [doc]));

    expect(listing.groups.map((group) => group.heading)).toEqual(['Sessions', 'Documents']);
    expect(listing.groups[0]?.results).toHaveLength(6);
    expect(listing.groups[1]?.results.map((result) => result.id)).toEqual(['doc:hub-6']);
  });

  it('tells a session and a document of one name apart by the group they are under', () => {
    const session = sessionResults(sessions, 'spike')[0];
    const listing = paletteListing(mergeResults(session === undefined ? [] : [session], [doc]));

    expect(session?.label).toBe(doc.label);
    expect(listing.groups.map((group) => [group.heading, group.results[0]?.href])).toEqual([
      ['Sessions', '#/session/store-agentplex/session-spike-wasm'],
      ['Documents', '#/doc/hub-6'],
    ]);
  });

  it('draws the rows in group order, which is the order the arrows move in', () => {
    // Interleaved on the way in: a listing whose rows and whose groups
    // disagreed would move the selection to a row further up the dialog.
    const [first, second] = sessionResults(sessions, '');
    const interleaved = [first, doc, second].filter(
      (result): result is PaletteResult => result !== undefined,
    );
    const listing = paletteListing(interleaved);

    expect(listing.results.map((result) => result.id)).toEqual(
      listing.groups.flatMap((group) => group.results.map((result) => result.id)),
    );
    expect(listing.results[1]?.id).toBe(second?.id);
  });

  it('bounds the rows after grouping them, so the groups hold what is drawn', () => {
    const listing = paletteListing(mergeResults(sessionResults(sessions, ''), [doc]), 2);

    expect(listing.results).toHaveLength(2);
    expect(listing.groups.map((group) => group.heading)).toEqual(['Sessions']);
    expect(listing.total).toBe(7);
  });
});

describe('separateness from the session list’s filter', () => {
  it('sees a session the list’s narrowing has hidden', () => {
    const narrowed = visibleSessions(populated, { ...NO_FILTERS, chip: 'needs-you' });
    expect(narrowed.map((each) => each.name)).not.toContain('spike-wasm');
    expect(labels(sessionResults(sessions, 'spike'))).toEqual(['spike-wasm']);
  });

  it('ignores the search the list is narrowed by, because it is handed the whole fleet', () => {
    const narrowed = visibleSessions(populated, { ...NO_FILTERS, search: 'universe' });
    expect(narrowed.map((each) => each.name)).not.toContain('fix-auth-refresh');
    expect(labels(sessionResults(listSessions(populated), 'fix-auth'))).toEqual([
      'fix-auth-refresh',
    ]);
  });
});

describe('keyboard movement', () => {
  const results = sessionResults(sessions, '');
  const ids = results.map((result) => result.id);
  const firstId = ids[0] ?? '';
  const lastId = ids[ids.length - 1] ?? '';

  it('starts and ends on the ends', () => {
    expect(firstResult(results)).toBe(firstId);
    expect(lastResult(results)).toBe(lastId);
  });

  it('steps one at a time', () => {
    expect(nextResult(results, firstId)).toBe(ids[1]);
    expect(previousResult(results, ids[1] ?? '')).toBe(firstId);
  });

  it('wraps at both ends, because the arrows on a short list are a ring', () => {
    expect(nextResult(results, lastId)).toBe(firstId);
    expect(previousResult(results, firstId)).toBe(lastId);
  });

  it('answers a selection the list no longer holds with the first result', () => {
    for (const move of [nextResult, previousResult]) {
      expect(move(results, 'session:["gone","gone"]')).toBe(firstId);
    }
  });

  it('answers an empty list with nothing at all, in every direction', () => {
    expect(firstResult([])).toBeNull();
    expect(lastResult([])).toBeNull();
    expect(nextResult([], firstId)).toBeNull();
    expect(previousResult([], firstId)).toBeNull();
  });

  it('treats a list of one as a ring of one', () => {
    const one = sessionResults(sessions, 'spike');
    const onlyId = one[0]?.id ?? '';
    expect(nextResult(one, onlyId)).toBe(onlyId);
    expect(previousResult(one, onlyId)).toBe(onlyId);
  });
});
