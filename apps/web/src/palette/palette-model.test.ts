import { describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame, type MachineState } from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import {
  listSessions,
  matchesSearch,
  NO_FILTERS,
  visibleSessions,
  type SessionListItem,
} from '../sessions/session-list-model.js';
import { sessionHash } from '../terminal/session-route.js';
import {
  firstResult,
  lastResult,
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
