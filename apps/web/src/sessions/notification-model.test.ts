import { describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame, type MachineState } from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { sessionHash } from '../terminal/session-route.js';
import { acknowledgeCommand } from './attention-model.js';
import { listSessions, type SessionListItem } from './session-list-model.js';
import { markAllRead, notificationList } from './notification-model.js';

/**
 * The list the bell opens, against states a real hub produced: which sessions
 * land in which section, what a row is allowed to say, and what Mark all read
 * hands back.
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
const empty = stateFrom(hubFrames.machineState);

/** The moment the fixtures were reported, so the ages are the real elapsed ones. */
const NOW = 1_756_000_000_000;

function named(items: readonly SessionListItem[], name: string): SessionListItem {
  const found = items.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`the fixture has no session called ${name}`);
  return found;
}

describe('the two sections', () => {
  it('puts every session that is still asking in the first one', () => {
    const list = notificationList(listSessions(populated), NOW);

    expect(list.needsYou.map((row) => row.item.name)).toEqual(['migrate-db-v9', 'docs-sweep']);
    expect(list.earlier).toEqual([]);
  });

  it('moves a session to the second one once somebody has said they saw it', () => {
    // The same fleet after a person spoke to it. `EARLIER` holds the
    // acknowledged needs-you rows and nothing else: a pull request opened and
    // a machine gone offline are things this client has no way to know, and an
    // event the app cannot observe is absent rather than invented.
    const list = notificationList(listSessions(attended), NOW);

    expect(list.needsYou).toEqual([]);
    expect(list.earlier.map((row) => row.item.name)).toEqual(['migrate-db-v9']);
  });

  it('leaves a muted session out of both', () => {
    // Muting is the standing answer "keep showing it and stop making noise
    // about it", and this list is the noise.
    const list = notificationList(listSessions(attended), NOW);
    const rows = [...list.needsYou, ...list.earlier];

    expect(listSessions(attended).filter((item) => item.muted)).toHaveLength(1);
    expect(rows.map((row) => row.item.name)).not.toContain('docs-sweep');
  });

  it('fills both sections at once, each from the state it belongs to', () => {
    // Two asking sessions is all any captured fleet holds, and the same fleet
    // cannot hold one session twice -- so the both-sections-at-once case is
    // assembled from the two real states: the machine nobody has answered
    // taken from the fleet before anyone spoke to it, and the acknowledged one
    // from the fleet after.
    const asking = listSessions(populated).filter((item) => item.storeId === 'store-universe');
    const seen = listSessions(attended).filter((item) => item.storeId === 'store-agentplex');
    const list = notificationList([...asking, ...seen], NOW);

    expect(list.needsYou.map((row) => row.item.name)).toEqual(['docs-sweep']);
    expect(list.earlier.map((row) => row.item.name)).toEqual(['migrate-db-v9']);
  });

  it('holds nothing at all for a fleet with no sessions in it', () => {
    const list = notificationList(listSessions(empty), NOW);

    expect(list.needsYou).toEqual([]);
    expect(list.earlier).toEqual([]);
  });

  it('draws the sessions that spoke most recently first', () => {
    const list = notificationList([...listSessions(populated)].reverse(), NOW);

    expect(list.needsYou.map((row) => row.item.name)).toEqual(['migrate-db-v9', 'docs-sweep']);
  });
});

describe('what a row says', () => {
  const list = notificationList(listSessions(populated), NOW);
  const row = list.needsYou[0];

  it('names the session and the state it is in, and claims nothing else', () => {
    // The mock's rows name a command, a pull request number and a benchmark
    // delta. No state carries any of them, so the sentence is the name and the
    // status words, which are the two things the row genuinely knows.
    expect(row?.sentence).toBe('migrate-db-v9 is awaiting permission');
    expect(row?.sentence).not.toContain('prisma');
  });

  it('places it on the second line: where it lives, which machine, how long', () => {
    expect(row?.place).toBe('store-agentplex · mbp-robert · 3m');
  });

  it('addresses the same session the card does, through the same helper', () => {
    const item = named(listSessions(populated), 'migrate-db-v9');

    expect(row?.href).toBe(sessionHash(item.ref));
  });

  it('carries the session tone rather than a tone of its own', () => {
    expect(row?.tone).toBe('needs-you');
  });
});

describe('mark all read', () => {
  it('acknowledges every session the section lists, and mutes nothing', () => {
    const items = listSessions(populated);
    const list = notificationList(items, NOW);

    const commands = markAllRead(list.needsYou);

    expect(commands).toEqual([
      acknowledgeCommand(named(items, 'migrate-db-v9')),
      acknowledgeCommand(named(items, 'docs-sweep')),
    ]);
    expect(commands.every((command) => command.type === 'session-acknowledge')).toBe(true);
  });

  it('leaves a muted session muted: bulk acknowledging is not a way to unmute', () => {
    const list = notificationList(listSessions(attended), NOW);

    const commands = [...markAllRead(list.needsYou), ...markAllRead(list.earlier)];

    expect(commands).toEqual([]);
    expect(listSessions(attended).find((item) => item.name === 'docs-sweep')?.muted).toBe(true);
  });

  it('restamps nothing that has already been seen', () => {
    const list = notificationList(listSessions(attended), NOW);

    expect(list.earlier).toHaveLength(1);
    expect(markAllRead(list.earlier)).toEqual([]);
  });
});
