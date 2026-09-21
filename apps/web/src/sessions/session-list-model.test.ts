import { describe, expect, it } from 'vitest';
import {
  parseHubFrame,
  parseTextFrame,
  type MachineState,
  type PendingApproval,
} from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { destinationHash } from '../shell/destinations.js';
import {
  acknowledgementHolds,
  activeFilterCount,
  ageLabel,
  chipCounts,
  chipOptions,
  clearedFilters,
  connectionNotice,
  effectiveFilters,
  emptyListing,
  hiddenCount,
  listSessions,
  machineOptions,
  matchesSearch,
  needsYouCount,
  NO_FILTERS,
  oldestApproval,
  orderByActivity,
  partitionNeedsYou,
  placeLabel,
  projectOptions,
  providerOptions,
  storeOptions,
  toneForStatus,
  unseenPrompt,
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
const pairedOnly = stateFrom(hubFrames.machineStateWithServer);
/**
 * A fleet with a blocked agent in it: one session, `migrate-db`, holding a
 * request a real `PermissionRequest` hook made, captured off the hub that was
 * told about it.
 */
const asked = stateFrom(hubFrames.machineStateApproval);

/** The captured request itself, for the rules that are about a list of them. */
const capturedApproval: PendingApproval = (() => {
  const [first] = asked.stores.flatMap((store) => store.sessions).flatMap((row) => row.approvals);
  if (first === undefined) throw new Error('the captured state has no pending approval');
  return first;
})();

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

  it('carries the project the hub put on the row, the name and the id together', () => {
    const docs = item(populated, 'docs-sweep');
    expect(docs.project).toBe('universe');
    expect(docs.projectId).toBe('hub-8');
  });

  it('carries no project for a session the tree places in none', () => {
    const fixAuth = item(populated, 'fix-auth-refresh');
    expect(fixAuth.project).toBeNull();
    expect(fixAuth.projectId).toBeNull();
  });

  /**
   * Both providers, because the value arrives from two adapters that read two
   * different records, and a field that only ever carried one of them would
   * pass here while half the fleet showed nothing.
   */
  it("carries the model the provider's own record named", () => {
    expect(item(populated, 'fix-auth-refresh').model).toBe('claude-opus-5');
    expect(item(populated, 'migrate-db-v9').model).toBe('gpt-5.6-terra');
  });

  /**
   * `null`, not `undefined`: the wire leaves the key off, and every other
   * absent fact on this item is a `null` a reader has to answer for.
   */
  it('carries no model for a session whose record named none', () => {
    expect(item(populated, 'spike-wasm').model).toBeNull();
  });
});

describe('the place line', () => {
  it('names the project when the session is in one', () => {
    expect(placeLabel(item(populated, 'docs-sweep'))).toBe('universe · gpu-box-01');
  });

  it('keeps the store it named before when the session is in no project', () => {
    expect(placeLabel(item(populated, 'fix-auth-refresh'))).toBe('store-agentplex · mbp-robert');
  });
});

describe('the request on a card', () => {
  it('carries the open request as the four things a card draws, and nothing else', () => {
    // The proposal is the agent's claim about what it wants to run, as text.
    // `suggestions` is deliberately not here: what the card offers is Allow
    // and Deny, and a remembered rule is a different decision on a different
    // screen -- an exact match is what keeps it from arriving by accident.
    expect(item(asked, 'migrate-db').approval).toEqual({
      approvalId: 'approval-1',
      tool: 'Bash',
      proposal:
        'command: prisma migrate deploy --schema ./db\ndescription: Apply pending Prisma migrations',
      requestedAt: 1_756_000_000_000,
    });
  });

  it('is null on every session of a fleet with nothing open', () => {
    // Present and empty on the wire, so this is the ordinary case and not a
    // gap: six sessions, two of them waiting on a human, none of them asking.
    const items = listSessions(populated);
    expect(items).toHaveLength(6);
    expect(items.map((entry) => entry.approval)).toEqual(items.map(() => null));
  });

  it('is null for a codex session, which has no hook to ask through', () => {
    const codex = listSessions(populated).filter((entry) => entry.provider === 'codex');
    expect(codex.length).toBeGreaterThan(0);
    expect(codex.every((entry) => entry.approval === null)).toBe(true);
  });

  it('is not a second source of status: the words and the partition are untouched', () => {
    // `awaiting-permission` is read off the provider's own record of the
    // session. A list that also decided a status could disagree with the
    // transcript the moment a hook and a scan land in the wrong order.
    const blocked = item(asked, 'migrate-db');
    expect(blocked.status).toBe('awaiting-permission');
    expect(blocked.summary).toBe('/Users/robert/code/agentplex');
    expect(blocked.needsYou).toBe(true);
  });
});

describe('choosing among open requests', () => {
  it('has nothing to choose from an empty list', () => {
    expect(oldestApproval([])).toBeNull();
  });

  it('takes the oldest by requestedAt, not the order the row happens to list', () => {
    // The oldest is the one whose hook has been blocking longest and is
    // nearest its own timeout, so it is the one worth a person's tap first.
    const newer: PendingApproval = {
      ...capturedApproval,
      requestedAt: capturedApproval.requestedAt + 60_000,
    };
    expect(oldestApproval([newer, capturedApproval])?.requestedAt).toBe(
      capturedApproval.requestedAt,
    );
    expect(oldestApproval([capturedApproval, newer])?.requestedAt).toBe(
      capturedApproval.requestedAt,
    );
  });

  it('keeps the hub order when two were heard in the same millisecond', () => {
    const second: PendingApproval = { ...capturedApproval, tool: 'Edit' };
    expect(oldestApproval([capturedApproval, second])?.tool).toBe(capturedApproval.tool);
    expect(oldestApproval([second, capturedApproval])?.tool).toBe('Edit');
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

  it('narrows by project name, which the row now carries', () => {
    // The fixture's one project is called after the store it sits over, so a
    // search for its name cannot tell the two fields apart. One field varied
    // off a captured item can: nothing but the project holds this word.
    const inProject = { ...item(populated, 'docs-sweep'), project: 'cathedral' };
    expect(matchesSearch(inProject, 'CATHED')).toBe(true);
  });

  it('matches nothing on a project name when the session is in no project', () => {
    expect(matchesSearch(item(populated, 'fix-auth-refresh'), 'cathedral')).toBe(false);
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

describe('the needs-you count', () => {
  it('counts the sessions waiting on a human', () => {
    const items = listSessions(populated);
    const chip = chipCounts(items).find((entry) => entry.chip === 'needs-you');

    // Everything in this fleet is reachable, so the badge and the chip agree,
    // which is the ordinary case and the one a reader will assume.
    expect(needsYouCount(items)).toBe(2);
    expect(chip?.count).toBe(2);
  });

  it('leaves out a session nobody can reach, which the chip still counts', () => {
    // The stale fleet: one session awaiting permission on the machine that is
    // up, one awaiting input on the machine that dropped. The chip is a facet
    // and promises two rows to anyone who presses it, so it says two. The
    // badge is a claim on attention and there is one thing attention can do
    // anything about, so it says one -- a badge you cannot bring down by
    // looking is a badge people stop believing.
    const items = listSessions(stale);

    expect(chipCounts(items).find((entry) => entry.chip === 'needs-you')?.count).toBe(2);
    expect(needsYouCount(items)).toBe(1);
  });

  it('counts where there is no chip row to read a count off', () => {
    // The chip row is not drawn when one state is all there is, and the badge
    // still has to say two: it is not read off the row.
    const waiting = listSessions(populated).filter((item) => item.needsYou);

    expect(chipCounts(waiting)).toEqual([]);
    expect(needsYouCount(waiting)).toBe(2);
  });

  it('is zero for a fleet with nothing waiting on anyone', () => {
    expect(needsYouCount(listSessions(empty))).toBe(0);
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

/**
 * The clock the age narrowing is read against. The captured fleet's newest
 * session was written three minutes before it and its oldest two hours before,
 * so every window in these tests is a real distance over captured timestamps.
 */
const NOW = 1_756_000_000_000;

describe('the popover the filter row opens', () => {
  it('offers a machine per machine holding a reading, named and in a stable order', () => {
    // Named by the server the reading came from, which is the field the
    // narrowing is defined over. Ordered by name rather than by the order
    // sessions arrived, so a dropdown does not reshuffle itself every time
    // somebody's agent writes a line.
    expect(machineOptions(populated, listSessions(populated))).toEqual([
      { id: 'registration-gpu-box-01', label: 'gpu-box-01' },
      { id: 'registration-mbp-robert', label: 'mbp-robert' },
    ]);
  });

  it('offers no machine section when every session came off one machine', () => {
    expect(machineOptions(single, listSessions(single))).toEqual([]);
    expect(machineOptions(empty, listSessions(empty))).toEqual([]);
  });

  it('offers the projects the tree places sessions in, in a stable order', () => {
    // The captured fleet puts one store's sessions in `universe` and the
    // other's in no project, so the two-option rule needs a second name: one
    // field varied off captured items, into the shape the hub sends for a
    // session the tree does place.
    const placed = listSessions(populated).map((row) =>
      row.project === null ? { ...row, project: 'agentplex' } : row,
    );
    expect(projectOptions(placed)).toEqual(['agentplex', 'universe']);
  });

  it('offers no project section when the tree places sessions in one project or none', () => {
    expect(projectOptions(listSessions(populated))).toEqual([]);
  });

  it('counts the status pills under the other narrowings, the clock included', () => {
    // Two hours is outside the hour, and the only idle session is two hours
    // old: the Idle pill is not drawn, because a pill promising a row that
    // pressing it does not yield is worse than an absent pill.
    expect(chipOptions(populated, { ...NO_FILTERS, updatedWithin: '1h' }, NOW)).toEqual([
      { chip: 'needs-you', label: 'Needs you', count: 2 },
      { chip: 'running', label: 'Running', count: 2 },
      { chip: 'unknown', label: 'Unknown', count: 1 },
    ]);
  });

  it('counts the pills over the whole fleet when nothing else narrows', () => {
    expect(chipOptions(populated, NO_FILTERS, NOW)).toEqual(chipCounts(listSessions(populated)));
  });
});

describe("the popover's machine, which is not the selector's", () => {
  it('narrows the list on its own', () => {
    expect(
      visibleSessions(populated, { ...NO_FILTERS, machine: 'registration-mbp-robert' }).map(
        (item) => item.name,
      ),
    ).toEqual(['migrate-db-v9', 'fix-auth-refresh', 'spike-wasm']);
  });

  it('is dropped when the fleet drops it, where the selector keeps narrowing', () => {
    // The asymmetry this ticket turns on. The popover's machine is one of this
    // list's own narrowings and follows the rule every other option follows:
    // an option that is gone narrows nothing. The selector's choice is the
    // same fact the catalogue query is narrowed by at that moment, so it keeps
    // narrowing to nothing rather than letting one pane widen under another.
    const effective = effectiveFilters(populated, {
      ...NO_FILTERS,
      machine: 'registration-unpaired',
      server: 'registration-unpaired',
    });

    expect(effective.machine).toBeNull();
    expect(effective.server).toBe('registration-unpaired');
    expect(visibleSessions(populated, effective)).toEqual([]);
  });
});

describe('the age narrowing', () => {
  it('keeps what was written inside the window', () => {
    expect(
      visibleSessions(populated, { ...NO_FILTERS, updatedWithin: '1h' }, NOW).map(
        (item) => item.name,
      ),
    ).toEqual([
      'migrate-db-v9',
      'docs-sweep',
      'fix-auth-refresh',
      'bench-tokenizer',
      'session-train-lora',
    ]);
  });

  it('counts the edge of the window as inside it', () => {
    // session-train-lora was written exactly an hour before NOW. A window
    // somebody picked to see the last hour that drops the session on the hour
    // is a window that reads as broken from the row it just removed.
    expect(NOW - item(populated, 'session-train-lora').updatedAt).toBe(3_600_000);
    expect(
      visibleSessions(populated, { ...NO_FILTERS, updatedWithin: '1h' }, NOW).map(
        (item) => item.name,
      ),
    ).toContain('session-train-lora');
  });

  it('narrows nothing when every session is inside the window', () => {
    expect(visibleSessions(populated, { ...NO_FILTERS, updatedWithin: '24h' }, NOW)).toHaveLength(
      6,
    );
    expect(visibleSessions(populated, { ...NO_FILTERS, updatedWithin: '7d' }, NOW)).toHaveLength(6);
  });
});

describe('a choice whose option has vanished', () => {
  it('keeps every choice the state still offers', () => {
    const filters = {
      ...NO_FILTERS,
      storeId: 'store-universe',
      provider: 'claude',
      machine: 'registration-gpu-box-01',
      chip: 'running' as const,
    };
    expect(effectiveFilters(populated, filters)).toEqual(filters);
  });

  it('drops a store and a provider the state no longer offers', () => {
    const effective = effectiveFilters(single, {
      ...NO_FILTERS,
      storeId: 'store-universe',
      provider: 'codex',
    });
    expect(effective.storeId).toBeNull();
    expect(effective.provider).toBeNull();
  });

  it('drops a project the tree places nothing in', () => {
    expect(effectiveFilters(populated, { ...NO_FILTERS, project: 'cathedral' }).project).toBeNull();
  });

  it('drops a status pill the surviving sessions are not in', () => {
    // Nothing in the universe store is idle, so the Idle pill is not drawn
    // there and a choice of it cannot go on narrowing invisibly.
    expect(
      effectiveFilters(populated, { ...NO_FILTERS, storeId: 'store-universe', chip: 'idle' }).chip,
    ).toBeNull();
  });

  it('drops a status pill the age narrowing took away, and keeps one it left', () => {
    const within = { ...NO_FILTERS, chip: 'idle' as const, updatedWithin: '1h' as const };
    expect(effectiveFilters(populated, within, NOW).chip).toBeNull();
    expect(effectiveFilters(populated, { ...within, updatedWithin: '24h' }, NOW).chip).toBe('idle');
  });
});

describe('the badge and the line under the row', () => {
  it('counts nothing while nothing is narrowed', () => {
    expect(activeFilterCount(NO_FILTERS)).toBe(0);
    expect(hiddenCount(populated, NO_FILTERS, NOW)).toBe(0);
  });

  it('counts a machine and a status as two', () => {
    expect(
      activeFilterCount({
        ...NO_FILTERS,
        machine: 'registration-mbp-robert',
        chip: 'needs-you',
      }),
    ).toBe(2);
  });

  it('counts each popover narrowing once', () => {
    expect(
      activeFilterCount({
        search: 'db',
        chip: 'running',
        storeId: 'store-universe',
        provider: 'claude',
        machine: 'registration-gpu-box-01',
        project: 'universe',
        updatedWithin: '24h',
        server: 'registration-gpu-box-01',
      }),
    ).toBe(6);
  });

  it('counts neither the typed search nor the fleet the selector is on', () => {
    // The search says what it is doing in the box it is typed into, and the
    // fleet selection is the selector's own control with its own label. A
    // badge on the popover button that counted either would send somebody
    // opening the popover looking for a narrowing that is not in it.
    expect(activeFilterCount({ ...NO_FILTERS, search: 'db' })).toBe(0);
    expect(activeFilterCount({ ...NO_FILTERS, server: 'registration-gpu-box-01' })).toBe(0);
  });

  it('says how many sessions the narrowings are keeping out of sight', () => {
    expect(hiddenCount(populated, { ...NO_FILTERS, chip: 'running' }, NOW)).toBe(4);
    expect(hiddenCount(populated, { ...NO_FILTERS, updatedWithin: '1h' }, NOW)).toBe(1);
    expect(hiddenCount(populated, { ...NO_FILTERS, search: 'migrate' }, NOW)).toBe(5);
  });

  it('counts nothing hidden by the fleet the selector is on', () => {
    // The fleet selection is not one of this list's narrowings, so the
    // sessions on other machines are not rows this row is hiding: a line
    // reading "0 filters - 3 hidden" beside an untouched popover is the screen
    // blaming itself for the selector's choice.
    expect(hiddenCount(populated, { ...NO_FILTERS, server: 'registration-gpu-box-01' }, NOW)).toBe(
      0,
    );
    expect(
      hiddenCount(
        populated,
        { ...NO_FILTERS, server: 'registration-gpu-box-01', chip: 'needs-you' },
        NOW,
      ),
    ).toBe(2);
  });
});

describe('clearing', () => {
  it('drops every narrowing and the search at once, and leaves the fleet alone', () => {
    const cleared = clearedFilters({
      search: 'db',
      chip: 'running',
      storeId: 'store-universe',
      provider: 'claude',
      machine: 'registration-gpu-box-01',
      project: 'universe',
      updatedWithin: '1h',
      server: 'registration-gpu-box-01',
    });

    expect(cleared).toEqual({ ...NO_FILTERS, server: 'registration-gpu-box-01' });
    expect(activeFilterCount(cleared)).toBe(0);
    expect(hiddenCount(populated, cleared, NOW)).toBe(0);
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

describe('an unseen prompt, which is what the accent and the waiting clock follow', () => {
  it('is a session wanting a human that nobody has said they have seen', () => {
    const unseen = listSessions(populated)
      .filter(unseenPrompt)
      .map((entry) => entry.name);
    expect([...unseen].sort()).toEqual(['docs-sweep', 'migrate-db-v9']);
  });

  it('is spent by the acknowledgement, which is what makes saying seen worth doing', () => {
    expect(unseenPrompt(item(attended, 'migrate-db-v9'))).toBe(false);
  });

  it('survives a mute, where wanting attention does not', () => {
    // The one place the two rules part. Muting silences the alert and not the
    // fact, so the muted row keeps its accent and still says how long it has
    // been waiting -- and only the bell, the title and the push go quiet.
    const muted = item(attended, 'docs-sweep');
    expect(muted.muted).toBe(true);
    expect(unseenPrompt(muted)).toBe(true);
    expect(wantsAttention(muted)).toBe(false);
  });

  it('is absent from a session nobody is waiting on', () => {
    expect(unseenPrompt(item(populated, 'fix-auth-refresh'))).toBe(false);
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

/**
 * The empty list, which until AGX-119 said one sentence to four different
 * situations. Every case below is a different person stuck at a different
 * place, and the words are what tell them which one they are in.
 */
describe('an empty list, and what resolves it', () => {
  it('names the narrowing when there are sessions the narrowing is hiding', () => {
    const listing = emptyListing(populated, true, 'wide');

    expect(listing.words).toBe('no session matches the current narrowing');
    // The control that undoes it is the narrowing directly above the list.
    expect(listing.action).toBeNull();
  });

  it('names pairing, and points at Settings, when no server is paired', () => {
    const listing = emptyListing(empty, false, 'wide');

    expect(listing.words).toContain('No server is paired');
    expect(listing.words).toContain('reports the stores');
    expect(listing.action).toEqual({
      label: 'Pair one in Settings',
      hash: destinationHash('settings'),
    });
  });

  it('names the starter that is actually drawn at this width', () => {
    // Both forms have one, and they are two different controls with two
    // different names: the wide form's is the chrome's New menu, and below
    // that width the chrome's round button is what starts one. A single
    // wording would send half the readers hunting for a button that is not
    // there -- and the screen's own New session button, which this used to
    // name, is not drawn in either form any more.
    expect(emptyListing(populated, false, 'wide').words).toContain('New in the top bar starts one');
    expect(emptyListing(populated, false, 'phone').words).toContain(
      'the Start a session button starts one',
    );
  });

  it('blames the connection, not the store, for a server the hub has never reached', () => {
    // `machineStateWithServer` is that state as a hub really sent it: one
    // pairing, phase `stale`, `staleReason` unreachable, `lastConnectedAt`
    // null, and "connection refused" in the hub's own words. "reports no
    // store" would credit a machine that has never said anything with having
    // said something, which is the over-claim.
    const listing = emptyListing(pairedOnly, false, 'wide');

    expect(listing.words).toContain('gpu-box-01');
    expect(listing.words).toContain('has never connected');
    expect(listing.words).not.toContain('reports no store');
    // And the one screen that can help: the row there carries the phase, the
    // address that was typed, and the hub's sentence about what went wrong.
    expect(listing.action).toEqual({
      label: 'See why in Settings',
      hash: destinationHash('settings'),
    });
  });
});
