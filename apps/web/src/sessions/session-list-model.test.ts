import { describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame, type MachineState } from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import {
  acknowledgementHolds,
  ageLabel,
  chipCounts,
  connectionNotice,
  listSessions,
  matchesSearch,
  NO_FILTERS,
  orderByActivity,
  partitionNeedsYou,
  providerOptions,
  storeOptions,
  toneForStatus,
  visibleSessions,
  wantsAttention,
  type SessionListItem,
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
/**
 * The same fleet after a person spoke to it: one permission prompt
 * acknowledged, one input prompt muted. Captured from a real hub, like every
 * other state here.
 */
const attended = stateFrom(hubFrames.machineStateAttended);
const empty = stateFrom(hubFrames.machineState);

/** One named item out of a state, or a failure that says which one was missing. */
function item(state: MachineState, name: string): SessionListItem {
  const found = listSessions(state).find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`the fixture has no session called ${name}`);
  return found;
}

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

describe('an acknowledgement', () => {
  /** A provider's clock, which is the only clock either argument comes off. */
  const WROTE_AT = 1_755_999_820_000;

  it('holds while the session has not been written to since', () => {
    // Equal is the common case, not a tie-break: the hub recorded exactly this
    // reading, and nothing has been written since.
    expect(acknowledgementHolds(WROTE_AT, WROTE_AT)).toBe(true);
  });

  it('is spent by a second prompt, which is the whole reason it is a timestamp', () => {
    // A boolean set at the first prompt would still be saying yes here, and
    // the agent sitting at the second one would never be mentioned again. One
    // millisecond is enough, because both numbers come off one clock -- there
    // is no skew to leave room for.
    expect(acknowledgementHolds(WROTE_AT, WROTE_AT + 1)).toBe(false);
  });

  it('holds for a reading older than the acknowledgement, which a late scan can produce', () => {
    // Two servers on one volume, or a scan that arrived out of order. The
    // session has not said anything new, so neither has this.
    expect(acknowledgementHolds(WROTE_AT, WROTE_AT - 1_000)).toBe(true);
  });

  it('is absent rather than false for a session nobody has acknowledged', () => {
    expect(acknowledgementHolds(null, WROTE_AT)).toBe(false);
  });

  it('reads off the captured row: the acknowledged prompt is seen, the others are not', () => {
    const acknowledged = item(attended, 'migrate-db-v9');
    expect(acknowledged.acknowledged).toBe(true);
    // The row the hub really sent: what it recorded is the session's own
    // `updatedAt`, not the moment the click landed, so the comparison this
    // model makes is between two readings of one provider's clock.
    const row = attended.stores
      .flatMap((store) => store.sessions)
      .find((candidate) => candidate.descriptor.sessionId === 'session-migrate-db');
    expect(row?.acknowledgedThrough).toBe(row?.descriptor.updatedAt);
    // The fact is untouched. It still wants a human and it is still in the
    // needs-you half of the list; what has changed is that it is not asking.
    expect(acknowledged.needsYou).toBe(true);
    expect(wantsAttention(acknowledged)).toBe(false);

    expect(item(attended, 'fix-auth-refresh').acknowledged).toBe(false);
  });
});

describe('a mute', () => {
  it('keeps the badge and the place, and only stops the asking', () => {
    const muted = item(attended, 'docs-sweep');
    expect(muted.muted).toBe(true);
    // Everything a person could act on is still true of it.
    expect(muted.status).toBe('awaiting-input');
    expect(muted.needsYou).toBe(true);
    expect(muted.tone).toBe('needs-you');
    // And it is still in the needs-you half of the list, in its own place.
    expect([...names(attended).slice(0, 2)].sort()).toEqual(['docs-sweep', 'migrate-db-v9']);
    expect(wantsAttention(muted)).toBe(false);
  });

  it('is absent from a session nobody muted', () => {
    expect(item(attended, 'spike-wasm').muted).toBe(false);
  });

  it('leaves the chip counts alone: a muted session is still in its state', () => {
    expect(chipCounts(listSessions(attended))).toEqual(chipCounts(listSessions(populated)));
  });
});

describe('what is worth interrupting somebody for', () => {
  it('is a session that wants a human, unacknowledged and unmuted', () => {
    const asking = listSessions(populated)
      .filter(wantsAttention)
      .map((entry) => entry.name);
    expect([...asking].sort()).toEqual(['docs-sweep', 'migrate-db-v9']);

    // The same fleet, after one was acknowledged and the other muted. Both
    // rows are still there, still needs-you, and neither is asking any more.
    expect(listSessions(attended).filter(wantsAttention)).toEqual([]);
    expect(listSessions(attended).filter((entry) => entry.needsYou)).toHaveLength(2);
  });

  it('never includes a session on a machine nobody can reach', () => {
    // A badge you cannot clear by looking is worse than no badge, which is the
    // rule `needsYou` already carries; this is the half that must not undo it.
    // `docs-sweep` is on the machine that went away and is asking for nobody;
    // the prompt on the machine that stayed is still asking, which is what
    // keeps this from passing for the wrong reason.
    expect(item(stale, 'docs-sweep').status).toBe('awaiting-input');
    expect(item(stale, 'docs-sweep').reachable).toBe(false);
    expect(item(stale, 'migrate-db-v9').acknowledged).toBe(false);
    expect(
      listSessions(stale)
        .filter(wantsAttention)
        .map((entry) => entry.name),
    ).toEqual(['migrate-db-v9']);
  });
});
