import { describe, expect, it } from 'vitest';
import {
  sessionIdSchema,
  storeIdSchema,
  type ServerRegistrationId,
  type SessionDescriptor,
  type SessionProcess,
} from '@agentplex/protocol';
import { chooseReportedSession, type ReportedSession } from './session-selection.js';

/**
 * Which of two servers' readings of the same session wins.
 *
 * Every case here is one volume mounted twice: the descriptors describe the
 * same session, and they disagree only because the two servers looked at
 * different moments and only one of them can see a process.
 */

const START = 1_756_000_000_000;

function descriptor(overrides: Partial<SessionDescriptor> = {}): SessionDescriptor {
  return {
    storeId: storeIdSchema.parse('store-work'),
    sessionId: sessionIdSchema.parse('session-1'),
    provider: 'claude',
    status: 'idle',
    process: 'none',
    updatedAt: START,
    cwd: '/srv/work',
    branch: null,
    title: null,
    uncommitted: null,
    ...overrides,
  };
}

function reported(
  registration: string,
  reachable: boolean,
  overrides: Partial<SessionDescriptor> = {},
  reportedAt = START,
): ReportedSession {
  return {
    registrationId: registration as ServerRegistrationId,
    descriptor: descriptor(overrides),
    reportedAt,
    reachable,
  };
}

describe('chooseReportedSession', () => {
  it('takes the only reading there is', () => {
    const only = reported('registration-a', true);
    expect(chooseReportedSession([only])).toBe(only);
  });

  it('prefers a reachable server over one the hub cannot reach', () => {
    // The stale server's reading is newer, and it is still the worse answer:
    // it is a reading of a volume through a machine nobody can ask anything.
    const stale = reported('registration-a', false, { updatedAt: START + 5_000 });
    const live = reported('registration-b', true, { updatedAt: START });

    expect(chooseReportedSession([stale, live])).toBe(live);
  });

  it('prefers the later reading of the transcript', () => {
    const behind = reported('registration-a', true, { updatedAt: START });
    const ahead = reported('registration-b', true, { updatedAt: START + 5_000 });

    expect(chooseReportedSession([behind, ahead])).toBe(ahead);
    expect(chooseReportedSession([ahead, behind])).toBe(ahead);
  });

  it('prefers the server that can see the process when the readings are level', () => {
    // Only the server running the session can say `running`; the other one is
    // reporting the absence of a process it was never going to find. Both
    // say `idle`: the process is alive at a prompt, which is the case a
    // status could never tell apart.
    const watcher = reported('registration-a', true, { process: 'none' });
    const holder = reported('registration-b', true, { process: 'running' });

    expect(chooseReportedSession([watcher, holder])).toBe(holder);
    expect(chooseReportedSession([holder, watcher])).toBe(holder);
  });

  it('does not let a stale `working` outrank a later reading', () => {
    // The process exited and the other server has read past that. Preferring
    // the holder here would put a spinner on a session that has finished.
    const holder = reported('registration-a', true, {
      status: 'working',
      process: 'running',
      updatedAt: START,
    });
    const later = reported('registration-b', true, {
      status: 'idle',
      process: 'none',
      updatedAt: START + 1_000,
    });

    expect(chooseReportedSession([holder, later])).toBe(later);
  });

  it('breaks a genuine tie the same way every time', () => {
    const a = reported('registration-a', true);
    const b = reported('registration-b', true);

    expect(chooseReportedSession([a, b]).registrationId).toBe('registration-a');
    expect(chooseReportedSession([b, a]).registrationId).toBe('registration-a');
  });

  it('takes a row whole, never a field from each', () => {
    // The losing reading has a title and a cwd the winner does not. A merge
    // would produce a row no server ever reported.
    const named = reported('registration-a', true, {
      title: 'refactor the parser',
      cwd: '/srv/work',
      updatedAt: START,
    });
    const winner = reported('registration-b', true, {
      title: null,
      cwd: null,
      updatedAt: START + 1_000,
    });

    const chosen = chooseReportedSession([named, winner]);
    expect(chosen.descriptor).toBe(winner.descriptor);
    expect(chosen.descriptor.title).toBeNull();
    expect(chosen.descriptor.cwd).toBeNull();
  });

  it('refuses to choose from nothing rather than answering with a gap', () => {
    expect(() => chooseReportedSession([])).toThrow(/no readings/);
  });
});

describe('process ranking', () => {
  /** Every answer a server can give about a process, except a sighting of one. */
  const withoutAProcess: readonly SessionProcess[] = ['none', 'unknown'];

  it('treats only a running process as evidence of one on that server, not a working status', () => {
    // `working` is a reading of the transcript, which every server holding
    // the volume can make, and a session can be idle at a prompt with its
    // process alive. Only `running` is a server saying it saw the process.
    for (const process of withoutAProcess) {
      const watcher = reported('registration-a', true, { status: 'working', process });
      const holder = reported('registration-b', true, { status: 'idle', process: 'running' });

      expect(chooseReportedSession([watcher, holder]).registrationId).toBe('registration-b');
      expect(chooseReportedSession([holder, watcher]).registrationId).toBe('registration-b');
    }
  });
});
