import type { Clock, IdGenerator } from '@agentplex/node-shared';
import { createPtySupervisor } from '@agentplex/pty';
import { createFakePtyFactory, type FakePtyFactory } from '@agentplex/pty/testing';
import { createTerminalManager, type TerminalManager } from './terminal-manager.js';

/**
 * The terminals a test drives, over the one fake pty.
 *
 * The manager and the supervisor are the shipped code; only the pty is the
 * fake, because a unit test cannot fork one. That is the point of building it
 * here rather than writing a stand-in for the manager: what the code above it
 * has to get right is what it does with a terminal that exists, one whose
 * process has ended, and one nobody is watching, and every one of those is a
 * state the real manager reaches when the fake pty is driven into it.
 *
 * Assembled once and shared, rather than copied into every suite that needs
 * one, because the supervisor takes a clock, an id source and an environment
 * and a second assembly of it drifts from the first.
 */
export interface FakeTerminals {
  readonly terminals: TerminalManager;
  /** The pty underneath, so a test can emit output, exit, or read what was written. */
  readonly factory: FakePtyFactory;
}

export interface FakeTerminalsOptions {
  /** Small enough to make the scrollback drop something, when that is the point. */
  readonly scrollbackBytes?: number;
  readonly cap?: number;
}

/** A clock that does not move: only the eviction rules care, and they set their own. */
const fixedClock: Clock = { now: () => 1_756_000_000_000 };

function countingIds(): IdGenerator {
  let next = 0;
  return { newId: () => `run-${(next += 1)}` };
}

export function createFakeTerminals(options: FakeTerminalsOptions = {}): FakeTerminals {
  const factory = createFakePtyFactory();
  const supervisor = createPtySupervisor({
    pty: factory,
    clock: fixedClock,
    ids: countingIds(),
    environment: {},
    // Omitted rather than passed as undefined: the workspace is on
    // `exactOptionalPropertyTypes`, so only an absent property takes the default.
    ...(options.scrollbackBytes === undefined ? {} : { scrollbackBytes: options.scrollbackBytes }),
  });
  const terminals = createTerminalManager({
    supervisor,
    clock: fixedClock,
    ...(options.cap === undefined ? {} : { cap: options.cap }),
  });
  return { terminals, factory };
}
