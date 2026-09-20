import { describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame, type MachineState } from '@agentplex/protocol';
import { ONBOARDING_HASH } from '../onboarding/onboarding-route.js';
import { hubFrames } from '../store/hub-frames.fixture.js';
import {
  ageLabel,
  chipCounts,
  connectionNotice,
  emptyListNotice,
  listSessions,
  matchesSearch,
  nextAction,
  NO_FILTERS,
  orderByActivity,
  partitionNeedsYou,
  providerOptions,
  storeOptions,
  toneForStatus,
  visibleSessions,
} from './session-list-model.js';

/**
 * Every state here is a captured machine-state frame a real hub assembled
 * from real store reports (see hub-frames.fixture.ts): a fleet of two
 * machines and two stores, the same fleet with one machine gone, and a
 * single-machine single-provider fleet for the one-option rule.
 */

function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the fixture is not a machine-state frame');
  }
  return parsed.value.state;
}

const populated = stateFrom(hubFrames.machineStatePopulated);
const stale = stateFrom(hubFrames.machineStateStale);
const single = stateFrom(hubFrames.machineStateSingle);
const empty = stateFrom(hubFrames.machineState);
const withServer = stateFrom(hubFrames.machineStateWithServer);

function names(state: MachineState): readonly string[] {
  return visibleSessions(state, NO_FILTERS).map((item) => item.name);
}

describe('flattening', () => {
  it("lists every store's sessions once, named and labelled", () => {
    const items = listSessions(populated);
    expect(items).toHaveLength(6);
    const fixAuth = items.find((item) => item.name === 'fix-auth-refresh');
    expect(fixAuth?.machine).toBe('mbp-robert');
    expect(fixAuth?.summary).toBe('/Users/robert/code/agentplex');
  });

  it('falls back to the session id when the provider names no title', () => {
    const unnamed = listSessions(populated).find((item) => item.status === 'unknown');
    expect(unnamed?.name).toBe('session-train-lora');
  });

  it('labels an unheld session with the machine whose reading it is', () => {
    const docs = listSessions(populated).find((item) => item.name === 'docs-sweep');
    expect(docs?.machine).toBe('gpu-box-01');
  });

  it("says a cwd-less session's status in words instead of a blank line", () => {
    const spike = listSessions(populated).find((item) => item.name === 'spike-wasm');
    expect(spike?.summary).toBe('idle');
  });
});

describe('tones', () => {
  it('maps the loud pair to the accent and keeps unknown quiet', () => {
    expect(toneForStatus('working')).toBe('running');
    expect(toneForStatus('awaiting-permission')).toBe('needs-you');
    expect(toneForStatus('awaiting-input')).toBe('needs-you');
    expect(toneForStatus('idle')).toBe('idle');
    expect(toneForStatus('unknown')).toBe('idle');
  });
});

describe('the partition', () => {
  it('puts needs-you first, activity-ordered inside both halves', () => {
    expect(names(populated)).toEqual([
      // Wants a human, newest activity first.
      'migrate-db-v9',
      'docs-sweep',
      // Everything else, newest activity first.
      'fix-auth-refresh',
      'bench-tokenizer',
      'session-train-lora',
      'spike-wasm',
    ]);
  });

  it('is a stable partition, not a sort: the halves keep their given order', () => {
    const ordered = orderByActivity(listSessions(populated));
    const partitioned = partitionNeedsYou(ordered);
    const needsYou = partitioned.filter((item) => item.needsYou);
    const rest = partitioned.filter((item) => !item.needsYou);
    expect(partitioned).toEqual([...needsYou, ...rest]);
    expect(needsYou).toEqual(ordered.filter((item) => item.needsYou));
    expect(rest).toEqual(ordered.filter((item) => !item.needsYou));
  });

  it('takes an unreachable session out of the attention half, not the list', () => {
    // The gpu box went away, so docs-sweep still wants input but nobody can
    // presently give it any: it drops back to its activity slot, labelled.
    expect(names(stale)).toEqual([
      'migrate-db-v9',
      'docs-sweep',
      'fix-auth-refresh',
      'bench-tokenizer',
      'session-train-lora',
      'spike-wasm',
    ]);
    const docs = visibleSessions(stale, NO_FILTERS).find((item) => item.name === 'docs-sweep');
    expect(docs?.needsYou).toBe(false);
    expect(docs?.reachable).toBe(false);
  });
});

describe("search, the table's one filter", () => {
  it('narrows by name, case-insensitively', () => {
    expect(
      visibleSessions(populated, { ...NO_FILTERS, search: 'MIGRATE' }).map((i) => i.name),
    ).toEqual(['migrate-db-v9']);
  });

  it('narrows by machine label', () => {
    const found = visibleSessions(populated, { ...NO_FILTERS, search: 'gpu-box' });
    expect(found.map((item) => item.machine)).toEqual(['gpu-box-01', 'gpu-box-01', 'gpu-box-01']);
  });

  it('treats whitespace as no filter', () => {
    const item = listSessions(populated)[0];
    if (item === undefined) throw new Error('no items');
    expect(matchesSearch(item, '   ')).toBe(true);
  });
});

describe('chips', () => {
  it('offers a chip per state that exists, loudest first, with counts', () => {
    expect(chipCounts(listSessions(populated))).toEqual([
      { chip: 'needs-you', label: 'Needs you', count: 2 },
      { chip: 'running', label: 'Running', count: 2 },
      { chip: 'idle', label: 'Idle', count: 1 },
      { chip: 'unknown', label: 'Unknown', count: 1 },
    ]);
  });

  it('offers no chip row when every session is in one state', () => {
    const codexOnly = listSessions(populated).filter((item) => item.provider === 'codex');
    expect(chipCounts(codexOnly)).toEqual([]);
  });

  it('offers no chip row for an empty fleet', () => {
    expect(chipCounts(listSessions(empty))).toEqual([]);
  });

  it('filters by the pressed chip', () => {
    expect(
      visibleSessions(populated, { ...NO_FILTERS, chip: 'running' }).map((i) => i.name),
    ).toEqual(['fix-auth-refresh', 'bench-tokenizer']);
  });
});

describe('narrowings before the table', () => {
  it('offers the stores when there are two', () => {
    expect(storeOptions(populated)).toEqual(['store-agentplex', 'store-universe']);
  });

  it('offers no store control for one store: one option is not drawn', () => {
    expect(storeOptions(single)).toEqual([]);
    expect(storeOptions(empty)).toEqual([]);
  });

  it('offers the providers when there are two', () => {
    expect(providerOptions(listSessions(populated))).toEqual(['claude', 'codex']);
  });

  it('offers no provider control for one provider', () => {
    expect(providerOptions(listSessions(single))).toEqual([]);
  });

  it('narrows by store and provider together', () => {
    const narrowed = visibleSessions(populated, {
      ...NO_FILTERS,
      storeId: 'store-universe',
      provider: 'claude',
    });
    expect(narrowed.map((item) => item.name)).toEqual(['bench-tokenizer', 'session-train-lora']);
  });

  it('narrows to the machine the selector picked, by the reading it is', () => {
    // The same fact the catalogue query narrows by -- the server the chosen
    // reading came from -- so the cards and the panel beside them answer the
    // same question the same way.
    const narrowed = visibleSessions(populated, {
      ...NO_FILTERS,
      server: 'registration-gpu-box-01',
    });
    expect(narrowed.map((item) => item.name)).toEqual([
      'docs-sweep',
      'bench-tokenizer',
      'session-train-lora',
    ]);
  });

  it("carries the reading's server on every item, holder or not", () => {
    const items = listSessions(populated);
    // fix-auth-refresh is held by the machine that read it; spike-wasm is held
    // by nobody at all. Both narrow by the machine whose reading they are.
    expect(new Set(items.map((item) => item.server))).toEqual(
      new Set(['registration-mbp-robert', 'registration-gpu-box-01']),
    );
  });

  it('shows nothing rather than everything for a machine the fleet dropped', () => {
    // The catalogue query is narrowed to it at the same moment, and the hub
    // answers that with no rows. A card list that widened on its own would
    // disagree with the panel beside it.
    expect(visibleSessions(populated, { ...NO_FILTERS, server: 'registration-unpaired' })).toEqual(
      [],
    );
  });
});

describe('ages', () => {
  it('speaks in the largest sensible unit', () => {
    const now = 1_756_000_000_000;
    expect(ageLabel(now, now - 30_000)).toBe('now');
    expect(ageLabel(now, now - 12 * 60_000)).toBe('12m');
    expect(ageLabel(now, now - 3 * 3_600_000)).toBe('3h');
    expect(ageLabel(now, now - 50 * 3_600_000)).toBe('2d');
  });
});

describe('degradation, said in words', () => {
  it('says nothing while connected with a state', () => {
    expect(connectionNotice('connected', null, true)).toBeNull();
  });

  it('labels a state shown across a dead connection as possibly stale', () => {
    expect(connectionNotice('reconnecting', null, true)).toContain('stale');
  });

  it('does not claim staleness before any state has arrived', () => {
    expect(connectionNotice('reconnecting', null, false)).not.toContain('stale');
    expect(connectionNotice('connected', null, false)).toContain('waiting');
  });

  it('relays the problem when retrying is pointless', () => {
    expect(connectionNotice('failed', 'this hub speaks protocol 4, not 5', false)).toBe(
      'this hub speaks protocol 4, not 5',
    );
  });
});

describe('the next action beside a degraded connection', () => {
  const save = { words: 'Save the hub token in Settings', href: '#settings' };
  const check = { words: 'Check the hub token in Settings', href: '#settings' };

  it('asks for a token while no connection is up and none is stored', () => {
    // An empty Bearer is a 401 at the ticket exchange, which is an ordinary
    // connect failure -- so a device with no token never gets past dialling.
    expect(nextAction('idle', false, false)).toEqual(save);
    expect(nextAction('reconnecting', false, false)).toEqual(save);
    expect(nextAction('failed', false, false)).toEqual(save);
  });

  it('asks for the stored token to be checked when nothing has arrived', () => {
    expect(nextAction('reconnecting', false, true)).toEqual(check);
    expect(nextAction('failed', false, true)).toEqual(check);
    expect(nextAction('failed', true, true)).toEqual(check);
  });

  it('does not point at a token this connection has already spent', () => {
    // A fleet is on screen, so the stored token was accepted at least once.
    // Naming it as the thing to check would be a guess at a cause, and the
    // notice beside this already says the state may be stale.
    expect(nextAction('reconnecting', true, true)).toBeNull();
  });

  it('says nothing while the hub is answering or the first dial is in flight', () => {
    expect(nextAction('connected', true, true)).toBeNull();
    expect(nextAction('connected', false, true)).toBeNull();
    expect(nextAction('connecting', false, false)).toBeNull();
    expect(nextAction('idle', false, true)).toBeNull();
  });
});

describe('the empty list', () => {
  it('sends a fleet with no machine in it to the wizard', () => {
    expect(emptyListNotice(empty)).toEqual({
      words: 'no sessions in any store yet',
      action: { words: 'Pair a server', href: ONBOARDING_HASH },
    });
  });

  it('asks for a store once a machine is paired and holds none', () => {
    expect(emptyListNotice(withServer)).toEqual({
      words: 'no sessions in any store yet',
      action: { words: 'Mount a store on a paired server', href: '#settings' },
    });
  });

  it('keeps the words and offers nothing when the stores are simply quiet', () => {
    expect(emptyListNotice(populated)).toEqual({
      words: 'no sessions in any store yet',
      action: null,
    });
  });
});
