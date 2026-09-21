import { useState, useSyncExternalStore, type JSX } from 'react';
import type { FrameId } from '@agentplex/protocol';
import type { HubStore } from '../store/hub-store.js';
import { useHubSnapshot } from '../store/use-hub-store.js';
import { Button, Group, Stack, Text, Title, useComputedColorScheme } from '../ui/components.js';
import { colorForTone } from '../ui/tokens.js';
import { Section } from './settings-section.js';
import type { PushBrowserState, PushOperations } from './push-operations.js';
import {
  applicationServerKey,
  pushControlView,
  pushFollowUp,
  PUSH_SHARING_WORDS,
  type PushAction,
} from './push-model.js';

/**
 * Turning notifications on for this browser, and off again.
 *
 * Three facts decide what is drawn and none of them is React's: what this
 * browser can do (the operations seam), whether this hub has a key pair (the
 * welcome, through the store), and whether a frame this control sent has been
 * answered. `push-model.ts` turns the three into one view; this file is the
 * elements over it and the two click handlers.
 *
 * There is no `useEffect` here on purpose. The browser's own state is read
 * through an external store, which React subscribes to at commit time and
 * which re-reads when a control mounts -- so a permission changed in another
 * tab or in the browser's settings is picked up by opening this screen again.
 * Permission is requested in the click handler and nowhere else: a prompt
 * fired by an effect is a prompt nobody asked for, and the dismissal it earns
 * is permanent.
 */

export interface PushControlProps {
  readonly store: HubStore;
  readonly push: PushOperations;
}

interface PushWatch {
  subscribe(listener: () => void): () => void;
  /** What was last read, or `null` before the first read has come back. */
  getSnapshot(): PushBrowserState | null;
  /** Ask the browser again -- after a prompt, or after a subscription moved. */
  refresh(): void;
}

/**
 * The browser's own state, as something `useSyncExternalStore` can read.
 *
 * It exists because the answer is asynchronous and the question is not a side
 * effect: "is this browser subscribed" is a fact about the browser, and the
 * hook for reading an outside fact is this one. The read happens when a
 * component subscribes -- which is also every remount -- so the screen is
 * re-read rather than trusted from the last time somebody opened it.
 *
 * The snapshot is one object that changes identity only when a read comes
 * back, which is the contract the hook needs.
 */
function createPushWatch(operations: PushOperations): PushWatch {
  const listeners = new Set<() => void>();
  let state: PushBrowserState | null = null;
  let reading = false;
  /** A read asked for while one was in flight: the answer would be stale. */
  let again = false;

  function read(): void {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    void operations.read().then(
      (next) => {
        reading = false;
        state = next;
        for (const listener of listeners) listener();
        if (again) {
          again = false;
          read();
        }
      },
      () => {
        // `read` answers rather than throwing; a rejection is a broken
        // implementation, and the honest thing to show is the nothing that
        // is already on the screen.
        reading = false;
        again = false;
      },
    );
  }

  return {
    subscribe(listener: () => void): () => void {
      const first = listeners.size === 0;
      listeners.add(listener);
      if (first) read();
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot(): PushBrowserState | null {
      return state;
    },
    refresh: read,
  };
}

/**
 * One watch per operations object, for the reason `pairingFor` has one per
 * store: the browser is a singleton and a watch rebuilt on every render would
 * re-read on every render.
 */
const watches = new WeakMap<PushOperations, PushWatch>();

function watchFor(operations: PushOperations): PushWatch {
  const existing = watches.get(operations);
  if (existing !== undefined) return existing;
  const built = createPushWatch(operations);
  watches.set(operations, built);
  return built;
}

/** The frame this control is waiting on, and what it was asked to do. */
interface SentFrame {
  readonly id: FrameId;
  readonly action: PushAction;
}

export function PushControl({ store, push }: PushControlProps): JSX.Element | null {
  const scheme = useComputedColorScheme('dark');
  const snapshot = useHubSnapshot(store);
  const watch = watchFor(push);
  const browser = useSyncExternalStore(watch.subscribe, watch.getSnapshot, watch.getSnapshot);
  /** The frame awaiting an answer, or `null` while none is. */
  const [sent, setSent] = useState<SentFrame | null>(null);
  /** What went wrong on this side -- the browser, or the store's own "no". */
  const [trouble, setTrouble] = useState<string | null>(null);

  // Before the first read has come back this control knows nothing, and the
  // one thing it must not do is guess. A browser without push draws nothing
  // at all, so a placeholder would be a flash of a section that should never
  // have been there.
  if (browser === null) return null;

  const followUp = pushFollowUp(sent?.id ?? null, snapshot.lastPush, snapshot.lastRefusal);
  // What the browser and hub are agreed on. A frame in flight shows the state
  // from before the press rather than the one being asked for: nothing has
  // happened yet, and a label that changed on the press would be claiming the
  // hub answered.
  const subscribed =
    followUp.kind === 'done'
      ? followUp.subscribed
      : followUp.kind === 'waiting' && sent !== null
        ? sent.action === 'unsubscribe'
        : browser.subscription !== null;

  const view = pushControlView({
    supported: browser.supported,
    permission: browser.permission,
    subscribed,
    hubKey: snapshot.pushPublicKey,
    waiting: followUp.kind === 'waiting',
    refused: followUp.kind === 'refused',
  });
  if (view.kind === 'silent') return null;

  function turnOn(hubKey: string): void {
    setTrouble(null);
    void (async () => {
      const permission = await push.requestPermission();
      // The answer is now a fact about this browser, and the view for a
      // blocked one is a different view. Re-reading is how it arrives: there
      // is no event for it and no effect watching for one.
      watch.refresh();
      if (permission !== 'granted') {
        // No words of our own: the view for a blocked browser already says
        // what changes it, and a "default" answer means the prompt was
        // dismissed, which the person just did on purpose.
        setSent(null);
        return;
      }
      const key = applicationServerKey(hubKey);
      if (key === null) {
        setTrouble('This hub sent a key this browser cannot use, so nothing was subscribed.');
        return;
      }
      const minted = await push.subscribe(key);
      // Whatever the browser did with that, it is what the browser holds now.
      // The label does not move on it: while a frame is in flight the view is
      // the one from before the press.
      watch.refresh();
      if (!minted.ok) {
        setTrouble(minted.reason);
        return;
      }
      const outcome = store.sendCommand({
        type: 'push-subscribe',
        subscription: minted.subscription,
      });
      if (!outcome.accepted) {
        setTrouble(
          `${outcome.reason}. This browser holds a subscription the hub has not been told about; ` +
            'pressing Turn on again sends it.',
        );
        return;
      }
      setSent({ id: outcome.id, action: 'subscribe' });
    })();
  }

  function turnOff(): void {
    setTrouble(null);
    void (async () => {
      const dropped = await push.unsubscribe();
      watch.refresh();
      if (!dropped.ok) setTrouble(dropped.reason);
      if (dropped.endpoint === null) {
        setSent(null);
        return;
      }
      // The endpoint is what the hub stores, so it is told to stop sending
      // there whether or not the browser managed its own half. The half that
      // failed is above, in words.
      const outcome = store.sendCommand({ type: 'push-unsubscribe', endpoint: dropped.endpoint });
      if (!outcome.accepted) {
        setTrouble(outcome.reason);
        return;
      }
      setSent({ id: outcome.id, action: 'unsubscribe' });
    })();
  }

  const hubKey = snapshot.pushPublicKey;
  const status =
    trouble ??
    (followUp.kind === 'refused'
      ? followUp.words
      : followUp.kind === 'done'
        ? followUp.subscribed
          ? 'The hub recorded this browser; it will be told when a session needs someone.'
          : 'The hub has forgotten this browser.'
        : browser.problem);
  const alarming = trouble !== null || followUp.kind === 'refused' || browser.problem !== null;

  return (
    <Section scheme={scheme}>
      <Stack gap="sm">
        <Title order={4}>Notifications</Title>
        <Text size="sm" c="dimmed">
          {view.words}
        </Text>
        <Text size="sm" c="dimmed">
          {PUSH_SHARING_WORDS}
        </Text>
        {view.kind === 'offer' && (
          <Group gap="sm">
            <Button
              variant={view.action === 'unsubscribe' ? 'default' : 'filled'}
              loading={view.busy}
              onClick={() => {
                if (view.action === 'unsubscribe') {
                  turnOff();
                } else if (hubKey !== null) {
                  turnOn(hubKey);
                }
              }}
            >
              {view.label}
            </Button>
          </Group>
        )}
        {/* Mounted before it has anything to say, so that the sentence a
            press produces is an update to a region a screen reader is
            already on rather than a new one it has to be told about. */}
        <Text
          size="sm"
          role="status"
          style={alarming ? { color: colorForTone('blocked', scheme) } : undefined}
        >
          {status ?? ''}
        </Text>
      </Stack>
    </Section>
  );
}
