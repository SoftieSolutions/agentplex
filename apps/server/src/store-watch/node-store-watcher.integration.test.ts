import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, systemTimers } from '@agentplex/node-shared';
import type { ServerToHubFrame, StoreId } from '@agentplex/protocol';
import type { GrantId } from '@agentplex/providers';
import { createHubAudience, type HubMember } from '../hub/hub-audience.js';
import { createFakeSessionController } from '../sessions/fake-session-controller.js';
import { nodeStoreWatcher } from './node-store-watcher.js';
import { watchStores, type StoreWatchMode, type StoreWatchers } from './store-watch.js';

/**
 * The seam against the runtime that answers it.
 *
 * `store-watch.test.ts` says what an event is worth; this says that writing a
 * file into a store produces one, through the real `fs.watch` and all the way
 * to a hub. The claim worth pinning is the one the module comment makes and a
 * fake cannot check: that the watch is recursive, so a transcript written into
 * a directory that did not exist when the watch was established is seen.
 *
 * The window is short here because the subject is the filesystem rather than
 * the debounce, and real timers are used for the same reason: every part of
 * this that a fake could stand in for is already tested with one.
 */

const logger = createLogger('error', () => {});
const STORE_ID = 'store-under-test' as StoreId;
const DEBOUNCE_MS = 50;

/**
 * Which mechanism this platform gives, asked once, of the shipped seam.
 *
 * Recursive `fs.watch` was run on macOS and Linux on Node 24 and works on both,
 * so the suite below is expected to run wherever agentplex is developed or
 * checked. It is asked rather than assumed because the alternative to a stated
 * skip is a suite that fails on a platform that never promised this.
 */
const mode: StoreWatchMode = await probeMode();

async function probeMode(): Promise<StoreWatchMode> {
  const directory = await mkdtemp(join(tmpdir(), 'agentplex-watch-probe-'));
  const watch = nodeStoreWatcher.watch(directory, { onChange: () => {}, onError: () => {} });
  watch.close();
  await rm(directory, { recursive: true, force: true });
  return watch.mode;
}

let store: string;
let watchers: StoreWatchers | undefined;

beforeEach(async () => {
  store = await mkdtemp(join(tmpdir(), 'agentplex-store-watch-'));
});

afterEach(async () => {
  watchers?.stop();
  watchers = undefined;
  await rm(store, { recursive: true, force: true });
});

/** A hub on the end of the real fan-out, which resolves when it is told something. */
function hub() {
  const sent: ServerToHubFrame[] = [];
  let arrived: (() => void) | null = null;
  const member: HubMember = {
    connectionId: 'connection-under-test',
    grantId: 'grant-under-test' as GrantId,
    send: (frame) => {
      sent.push(frame);
      arrived?.();
    },
    takeStartTags: () => [],
    close: () => {},
  };
  return {
    member,
    get sent(): readonly ServerToHubFrame[] {
      return sent;
    },
    /** Settles on the first frame, or lets the suite's timeout say it never came. */
    next(): Promise<ServerToHubFrame> {
      return new Promise<ServerToHubFrame>((resolve) => {
        const first = sent[0];
        if (first !== undefined) {
          resolve(first);
          return;
        }
        arrived = () => {
          const frame = sent[0];
          if (frame !== undefined) resolve(frame);
        };
      });
    },
  };
}

describe(`nodeStoreWatcher, which gets a ${mode} watch on this platform`, () => {
  it.skipIf(mode !== 'recursive')(
    'reports a transcript written under a store to a connected hub',
    async () => {
      const sessions = createFakeSessionController({
        reports: [{ storeId: STORE_ID, sessions: [], holding: [] }],
      });
      const audience = createHubAudience({ sessions, logger });
      const connected = hub();
      audience.join(connected.member);
      watchers = watchStores({
        stores: [{ storeId: STORE_ID, path: store }],
        watcher: nodeStoreWatcher,
        audience,
        timers: systemTimers,
        logger,
        debounceMs: DEBOUNCE_MS,
      });

      // A directory that did not exist when the watch was established, and a
      // transcript inside it: this is the shape a provider writes, and a watch
      // that was not recursive would see the directory and none of the writes.
      const project = join(store, 'projects', '-Users-dev-agentplex');
      await mkdir(project, { recursive: true });
      await writeFile(
        join(project, 'e3a1c7d2-0f52-4b8e-9a1d-7c6b5e4f3a20.jsonl'),
        `${JSON.stringify({ type: 'user', sessionId: 'e3a1c7d2', cwd: '/Users/dev/agentplex' })}\n`,
        'utf8',
      );

      expect(await connected.next()).toMatchObject({
        type: 'store-report',
        storeId: STORE_ID,
      });
      // The store this watch was established for, and not some other. That a
      // burst is one report is proven against events a test fires in
      // `store-watch.test.ts`; what this file adds is that the events are real,
      // and counting them here would be asserting on how a kernel coalesces.
      expect(sessions.scans[0]).toBe(STORE_ID);
    },
  );

  it.skipIf(mode === 'recursive')(
    'falls back to polling where the platform refuses a recursive watch',
    () => {
      // The skipped half of the pair above, so a platform without a recursive
      // watch says which mechanism it got rather than reporting a suite that
      // quietly ran nothing.
      expect(mode).toBe('polling');
    },
  );
});
