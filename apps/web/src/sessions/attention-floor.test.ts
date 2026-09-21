import { describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame, type MachineState } from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import {
  chipCounts,
  listSessions,
  NO_FILTERS,
  orderByActivity,
  partitionNeedsYou,
  visibleSessions,
} from './session-list-model.js';
import {
  attentionFloorCount,
  fleetAttentionCount,
  needsYouWords,
  titleFor,
} from './attention-floor.js';

/**
 * The same captured hub frames the list model is tested against: a fleet where
 * two sessions are asking, the same fleet after one was acknowledged and the
 * other muted, the same fleet with one machine gone, and a fleet where nothing
 * is asking at all.
 */
function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok || parsed.value.type !== 'machine-state') {
    throw new Error('the fixture is not a machine-state frame');
  }
  return parsed.value.state;
}

const populated = stateFrom(hubFrames.machineStatePopulated);
const attended = stateFrom(hubFrames.machineStateAttended);
const stale = stateFrom(hubFrames.machineStateStale);
const single = stateFrom(hubFrames.machineStateSingle);
const empty = stateFrom(hubFrames.machineState);

describe('the attention floor count', () => {
  it('counts the sessions that are asking for somebody', () => {
    const items = listSessions(populated);

    expect(items.filter((entry) => entry.needsYou)).toHaveLength(2);
    expect(attentionFloorCount(items)).toBe(2);
  });

  it('leaves out the acknowledged and the muted, which `needsYou` alone would keep', () => {
    // The same fleet after a person spoke to it: one prompt acknowledged, one
    // muted. Both rows are still needs-you and still in the needs-you half of
    // the list; neither is asking, so the floor is quiet.
    const items = listSessions(attended);

    expect(items.filter((entry) => entry.needsYou)).toHaveLength(2);
    expect(attentionFloorCount(items)).toBe(0);
  });

  it('leaves out a session on a machine nobody can reach', () => {
    // A number you cannot bring down by attending to it is a number people
    // learn to ignore: the prompt on the machine that dropped is asking for
    // nobody, and the one on the machine that stayed is still asking, which is
    // what keeps this from passing for the wrong reason. The chip is a facet
    // and still promises two rows; the floor claims one.
    const items = listSessions(stale);

    expect(chipCounts(items).find((entry) => entry.chip === 'needs-you')?.count).toBe(2);
    expect(attentionFloorCount(items)).toBe(1);
  });

  it('never counts a run that finished: a completion is not a question', () => {
    // This fleet holds one session in flight and one that ended and is sitting
    // idle. Neither wants anything, and an idle session is exactly the thing
    // whose presence in the title would make the title worth less.
    const items = listSessions(single);

    expect([...items].map((entry) => entry.status).sort()).toEqual(['idle', 'working']);
    expect(attentionFloorCount(items)).toBe(0);
  });

  it('is zero for a fleet with nothing in it', () => {
    expect(attentionFloorCount(listSessions(empty))).toBe(0);
  });

  it('counts the items it is handed, so a caller may narrow them first', () => {
    // Whether the bell speaks for the whole fleet or for one machine is the
    // caller's decision, not this function's: hand it a narrowed list and it
    // answers about that list.
    const onlyGpuBox = visibleSessions(populated, {
      ...NO_FILTERS,
      server: 'registration-gpu-box-01',
    });

    expect(attentionFloorCount(onlyGpuBox)).toBe(1);
    expect(attentionFloorCount(listSessions(populated))).toBe(2);
  });
});

describe('the floor’s count for a whole fleet', () => {
  it('counts every machine, because the surfaces that ask have no selector on them', () => {
    // The tab strip and the bell both ask this, and they have to come back
    // with one number: a bell that silently spoke for the machine somebody
    // picked in the sidebar would disagree with the title beside it.
    expect(fleetAttentionCount(populated)).toBe(2);
    expect(fleetAttentionCount(attended)).toBe(0);
  });

  it('is zero before the hub has answered with a fleet at all', () => {
    // `null` is "not answered yet" and not "nothing is asking": the surfaces
    // stay quiet rather than publishing a zero nothing supports.
    expect(fleetAttentionCount(null)).toBe(0);
  });
});

describe('the words the count is spoken in', () => {
  it('agrees in number with what it is counting', () => {
    expect(needsYouWords(1)).toBe('1 session needs you');
    expect(needsYouWords(2)).toBe('2 sessions need you');
  });

  it('says the quiet case in words rather than as a zero', () => {
    // "0 sessions need you" is a sentence nobody says. A bell is labelled at
    // every count, so the empty case needs wording of its own.
    expect(needsYouWords(0)).toBe('Nothing needs you');
  });
});

describe('the document title', () => {
  it('is the bare product name when nothing is asking', () => {
    expect(titleFor(0)).toBe('agentplex');
  });

  it('leads with the count when something is', () => {
    expect(titleFor(1)).toBe('(1) agentplex');
    expect(titleFor(2)).toBe('(2) agentplex');
  });

  it('says the same thing the count does, end to end', () => {
    expect(titleFor(attentionFloorCount(listSessions(populated)))).toBe('(2) agentplex');
    expect(titleFor(attentionFloorCount(listSessions(attended)))).toBe('agentplex');
  });
});

describe('the ordering the list already has', () => {
  it('puts the needs-you sessions first, activity order kept inside each half', () => {
    // Nothing here is new work: the floor rides on the partition the list model
    // already applies, so the row a bell sends somebody to is at the top of the
    // list when they arrive.
    const ordered = partitionNeedsYou(orderByActivity(listSessions(populated)));

    expect(ordered.map((entry) => entry.name)).toEqual([
      'migrate-db-v9',
      'docs-sweep',
      'fix-auth-refresh',
      'bench-tokenizer',
      'session-train-lora',
      'spike-wasm',
    ]);
    expect(ordered.slice(0, 2).every((entry) => entry.needsYou)).toBe(true);
  });
});
