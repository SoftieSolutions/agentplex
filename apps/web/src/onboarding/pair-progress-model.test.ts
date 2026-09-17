import { describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame, type MachineState } from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { serverRows, type ServerRowView } from '../settings/server-rows.js';
import { pairProgress } from './pair-progress-model.js';

/**
 * Every row here is projected from a captured machine-state frame, through the
 * same parser the store uses and the same `serverRows` the settings list draws
 * from. The wizard's last screen is a reading of what the hub published about
 * one registration, so a hand-written row would only prove that the reading
 * can read what its author imagined.
 */
function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok) throw new Error(parsed.reason);
  if (parsed.value.type !== 'machine-state') throw new Error(`captured a ${parsed.value.type}`);
  return parsed.value.state;
}

/** The rows a captured frame projects into, the way the settings screen gets them. */
function rowsFrom(text: string): readonly ServerRowView[] {
  return serverRows(stateFrom(text));
}

/** The one row a fixture carries, so a test can name its id without inventing one. */
function onlyRow(rows: readonly ServerRowView[]): ServerRowView {
  const row = rows[0];
  if (row === undefined) throw new Error('the fixture projected no rows');
  return row;
}

const justPaired = rowsFrom(hubFrames.machineStateJustPaired);
const unreachable = rowsFrom(hubFrames.machineStateWithServer);
const draining = rowsFrom(hubFrames.machineStateDraining);

describe('a registration the rows do not name yet', () => {
  it('is recorded, because the hub has answered without it', () => {
    // The pairing frame came back with an id; the next whole state has not
    // been published, or was published before the hub wrote this row. Either
    // way the honest sentence is that the pairing is on file, not that
    // anything has been dialled.
    const other = onlyRow(unreachable).registrationId;
    expect(pairProgress(justPaired, other)).toEqual({ kind: 'recorded' });
  });

  it('is recorded when the hub has published no servers at all', () => {
    expect(pairProgress([], onlyRow(justPaired).registrationId)).toEqual({ kind: 'recorded' });
  });
});

describe('a registration the hub is still dialling', () => {
  it('is dialling, with the machine the address belongs to', () => {
    // The captured row re-read through the parser with only the phase fields
    // varied: the hub publishes `connecting` at its own moment, and the
    // capture caught this machine at a later one.
    const captured = stateFrom(hubFrames.machineStateWithServer);
    const row = captured.servers[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    const rows = serverRows({
      ...captured,
      servers: [{ ...row, phase: 'connecting', staleSince: null, staleReason: null }],
    });
    expect(onlyRow(rows).phase).toBe('connecting');

    expect(pairProgress(rows, row.registrationId)).toEqual({
      kind: 'dialling',
      label: 'gpu-box-01',
      address: 'wss://gpu-box-01.example:8443',
    });
  });
});

describe('a registration that answered', () => {
  it('is online, with what the machine turned out to be', () => {
    const row = onlyRow(justPaired);
    expect(pairProgress(justPaired, row.registrationId)).toEqual({
      kind: 'online',
      label: 'mbp-robert',
      address: 'wss://mbp-robert.example:8443',
      words: 'connected',
      connectedSince: 1_756_000_000_000,
      stores: ['store-agentplex'],
      providers: [{ name: 'claude', tone: 'running', words: 'claude 9.9.9', problem: null }],
    });
  });

  it('claims nothing about the operating system or the daemon build', () => {
    // Neither is on any frame the hub sends, so neither can be drawn. A line
    // that said "macOS 15, agentplex 1.4" would be the wizard inventing the
    // two facts a first-run reader is most likely to believe.
    const progress = pairProgress(justPaired, onlyRow(justPaired).registrationId);
    expect(Object.keys(progress).sort()).toEqual([
      'address',
      'connectedSince',
      'kind',
      'label',
      'providers',
      'stores',
      'words',
    ]);
  });

  it('needs no intermediate state: the first frame after pairing can already be online', () => {
    // Captured from a hub that dialled the machine inside the same broadcast
    // that recorded the pairing. `connecting` never rendered, and nothing here
    // waits for it to -- a progress model that required the dialling step
    // first would stick on the happy path.
    const rows = rowsFrom(hubFrames.machineStateJustPaired);
    const progress = pairProgress(rows, onlyRow(rows).registrationId);
    expect(progress.kind).toBe('online');
  });

  it('is still online while the machine drains, in the words the row carries', () => {
    // The socket is up and the hub is being answered, so "unreachable" would
    // be wrong. The words carry the shutdown, which is the part worth reading.
    const row = onlyRow(draining);
    expect(pairProgress(draining, row.registrationId)).toMatchObject({
      kind: 'online',
      label: 'mbp-robert',
      words: 'shutting down, 1 session finishing',
    });
  });
});

describe('a registration the hub cannot reach', () => {
  it('says so in the hub words, and what to do about it', () => {
    // The failure this screen exists for. A spinner here would leave somebody
    // watching a wizard that is never going to change, so the row stops and
    // hands over the hub's own sentence plus the two things worth checking.
    const row = onlyRow(unreachable);
    expect(pairProgress(unreachable, row.registrationId)).toEqual({
      kind: 'unreachable',
      label: 'gpu-box-01',
      address: 'wss://gpu-box-01.example:8443',
      problem: 'connection refused',
      nextAction:
        'Check the server is running and its port is reachable from the hub; Settings can unpair it.',
    });
  });
});
