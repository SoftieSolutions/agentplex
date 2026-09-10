import { describe, expect, it } from 'vitest';
import { parseHubFrame, parseTextFrame, type MachineState } from '@agentplex/protocol';
import { hubFrames } from '../store/hub-frames.fixture.js';
import { serverRows } from './server-rows.js';

/** Reads a captured machine-state frame the way the store does. */
function stateFrom(text: string): MachineState {
  const parsed = parseTextFrame(parseHubFrame, text);
  if (!parsed.ok) throw new Error(parsed.reason);
  if (parsed.value.type !== 'machine-state') throw new Error(`captured a ${parsed.value.type}`);
  return parsed.value.state;
}

describe('the paired-server rows', () => {
  it('is empty before the first machine state arrives', () => {
    expect(serverRows(null)).toEqual([]);
  });

  it('is empty for a hub with no pairings', () => {
    expect(serverRows(stateFrom(hubFrames.machineState))).toEqual([]);
  });

  it('projects a captured stale pairing into a row with its problem in words', () => {
    const rows = serverRows(stateFrom(hubFrames.machineStateWithServer));
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(row.registrationId).toBe('pairing-1');
    expect(row.label).toBe('gpu-box-01');
    // Never connected, so the machine has not yet said what it calls itself.
    expect(row.serverId).toBeNull();
    // Unreachable is shown as blocked — something a person may need to act
    // on — with the hub's own words beside it, not a bare red dot.
    expect(row.tone).toBe('blocked');
    expect(row.phase).toBe('unreachable');
    expect(row.problem).toBe('connection refused');
    expect(row.stores).toEqual([]);
  });

  it('shows a connected server as running and a dialling one as idle', () => {
    // The captured row, re-read through the same parser with only the phase
    // fields varied: the projection under test is phase -> tone, and the hub
    // publishes each phase at its own moment.
    const captured = stateFrom(hubFrames.machineStateWithServer);
    const staleRow = captured.servers[0];
    expect(staleRow).toBeDefined();
    if (staleRow === undefined) return;

    const connected = serverRows({
      ...captured,
      servers: [
        {
          ...staleRow,
          phase: 'connected',
          connectedSince: 1_756_000_000_000,
          staleSince: null,
          staleReason: null,
          problem: null,
        },
      ],
    });
    expect(connected[0]?.tone).toBe('running');
    expect(connected[0]?.phase).toBe('connected');
    expect(connected[0]?.problem).toBeNull();

    const connecting = serverRows({
      ...captured,
      servers: [{ ...staleRow, phase: 'connecting', staleSince: null, staleReason: null }],
    });
    expect(connecting[0]?.tone).toBe('idle');
    expect(connecting[0]?.phase).toBe('connecting');
  });

  it('draws a provider that cannot be started, with the machine reason beside it', () => {
    // The captured fleet has a box whose codex is not installed. This is the
    // fact that used to arrive as a session that appeared and vanished; here it
    // is a line on the screen a person goes to when something is not working.
    const rows = serverRows(stateFrom(hubFrames.machineStatePopulated));
    const gpu = rows.find((row) => row.label === 'gpu-box-01');
    expect(gpu).toBeDefined();
    if (gpu === undefined) return;

    expect(gpu.providers).toEqual([
      { name: 'claude', tone: 'running', words: 'claude 9.9.9', problem: null },
      {
        name: 'codex',
        tone: 'blocked',
        words: 'codex missing',
        problem: 'no directory this server searches holds codex',
      },
    ]);
  });

  it('shows a provider that resolved but could not answer as needing a look, not as broken', () => {
    // The binary is there, so sessions still start. Drawing it as blocked would
    // tell somebody to go and fix a machine that is working.
    const captured = stateFrom(hubFrames.machineStateWithServer);
    const row = captured.servers[0];
    expect(row).toBeDefined();
    if (row === undefined) return;

    const [projected] = serverRows({
      ...captured,
      servers: [
        {
          ...row,
          providers: [
            {
              provider: 'claude',
              state: 'unknown',
              version: null,
              directory: '/usr/local/bin',
              problem: 'claude printed no version',
            },
          ],
        },
      ],
    });

    expect(projected?.providers[0]).toMatchObject({ tone: 'needs-you', words: 'claude unknown' });
  });
});
