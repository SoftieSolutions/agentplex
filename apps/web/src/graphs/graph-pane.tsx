import { useState, useSyncExternalStore, type JSX } from 'react';
import type { FrameId, NodeId } from '@agentplex/protocol';
import type { ConnectionPhase, GraphDocumentView, HubStore } from '../store/hub-store.js';
import { Box, Stack, Text, useComputedColorScheme } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';

/**
 * What a graph address opens until the canvas lands: the name, which draft
 * this is, and what has been published.
 *
 * A placeholder on purpose, and a small one. AGX-145 replaces this file with
 * the canvas, the inspector and a store of its own; what this ticket owes the
 * address is that following it shows the graph the hub has rather than an
 * empty region, and that the words it uses for a version are the ones the
 * canvas header will keep: `v7 · draft`.
 *
 * ## How it asks
 *
 * Through a per-pane external store rather than an effect, the way the
 * document pane does: the first subscriber is what sends `graph-open`, and the
 * answer is read off the hub's snapshot by node. By node and not by frame,
 * because a graph is a screen and there is one of it per node -- so a remount
 * finds the document already held and asks again only if it is not.
 *
 * It asks again when the connection comes back, the way the document editor
 * does. The draft is the hub's and another client may have saved it while
 * this one was away, so the copy on screen is one this pane can no longer
 * vouch for; it stays up until the answer replaces it rather than blinking to
 * a placeholder. AGX-145's store inherits this rule with the rest.
 */

const MONO = { fontFamily: 'var(--mantine-font-family-monospace)' } as const;

export interface GraphPaneWords {
  /** `v7 · draft` */
  readonly version: string;
  /** `v1, v2 published`, or that nothing is. */
  readonly published: string;
  /** `3 nodes · 2 edges` */
  readonly shape: string;
}

/** The three lines the pane draws, as a function of the answer so a test can read them. */
export function graphPaneWords(view: GraphDocumentView): GraphPaneWords {
  const versions = view.published.map((row) => `v${String(row.version)}`);
  return {
    version: `v${String(view.draftVersion)} · draft`,
    published: versions.length === 0 ? 'nothing published yet' : `${versions.join(', ')} published`,
    shape: `${String(view.document.nodes.length)} nodes · ${String(view.document.edges.length)} edges`,
  };
}

interface GraphPaneState {
  readonly view: GraphDocumentView | null;
  /** The hub's sentence for a refused open, or `null`. */
  readonly problem: string | null;
}

const WAITING: GraphPaneState = { view: null, problem: null };

/**
 * One graph's open, as an external store: asks on the first subscriber and
 * projects the hub's snapshot into what this pane draws. The snapshot is
 * replaced only when a field changes, which is what `useSyncExternalStore`
 * needs to settle.
 */
function createGraphOpener(hub: HubStore, nodeId: NodeId) {
  const listeners = new Set<() => void>();
  let state: GraphPaneState = WAITING;
  let openFrame: FrameId | null = null;
  let detach: (() => void) | null = null;
  /** The phase at the last notification, so a reconnection is an edge. */
  let phaseBefore: ConnectionPhase = 'idle';
  /**
   * Whether the last ask is still in the store's queue. A pane mounted before
   * the first welcome asks into the queue, and the queue goes out on the
   * connection that arrives -- so that first edge carries the ask already and
   * a second one would be the same question twice.
   */
  let queued = false;

  function ask(): void {
    const outcome = hub.sendCommand({ type: 'graph-open', nodeId });
    if (outcome.accepted) {
      openFrame = outcome.id;
      queued = outcome.delivery === 'queued';
    } else {
      state = { view: state.view, problem: outcome.reason };
    }
  }

  function project(): void {
    const snapshot = hub.getSnapshot();
    const returned = snapshot.phase === 'connected' && phaseBefore !== 'connected';
    phaseBefore = snapshot.phase;
    if (returned && openFrame !== null) {
      if (queued) queued = false;
      else ask();
    }

    const answer = snapshot.lastGraphDocument;
    const view = answer !== null && answer.nodeId === nodeId ? answer : state.view;
    const refusal = snapshot.lastRefusal;
    const problem =
      refusal !== null && openFrame !== null && refusal.replyTo === openFrame
        ? refusal.message
        : state.problem;
    if (view === state.view && problem === state.problem) return;
    state = { view, problem };
    for (const listener of [...listeners]) listener();
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (listeners.size === 1) {
        phaseBefore = hub.getSnapshot().phase;
        detach = hub.subscribe(project);
        ask();
        project();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          detach?.();
          detach = null;
        }
      };
    },
    getSnapshot(): GraphPaneState {
      return state;
    },
  };
}

export interface GraphPaneProps {
  readonly nodeId: NodeId;
  /** The page's one hub store, handed down by the shell that mounts this. */
  readonly store: HubStore;
}

export function GraphPane({ nodeId, store: hub }: GraphPaneProps): JSX.Element {
  const scheme: Scheme = useComputedColorScheme('dark');
  // A pane-lifetime collaborator, not render data: one opener per mounted
  // pane. The shell keys the pane on the node, so another graph gets a fresh one.
  const [opener] = useState(() => createGraphOpener(hub, nodeId));
  const { view, problem } = useSyncExternalStore(opener.subscribe, opener.getSnapshot);
  const border = `1px solid ${colorForRole('border', scheme)}`;
  const muted = colorForRole('textMuted', scheme);

  if (view === null) {
    return (
      <Box p={18} data-graph-pane={nodeId}>
        <Text fz={13} c={muted}>
          {problem ?? 'opening the graph'}
        </Text>
      </Box>
    );
  }

  const words = graphPaneWords(view);
  return (
    <Stack gap={0} style={{ height: '100%' }} data-graph-pane={nodeId}>
      <Box px={18} py={10} style={{ borderBottom: border, display: 'flex', gap: 10 }}>
        <Text fw={700} fz={15} style={{ whiteSpace: 'nowrap' }}>
          {view.name}
        </Text>
        <Text
          fz={10}
          fw={500}
          px={6}
          style={{ ...MONO, border, borderRadius: 4, alignSelf: 'center' }}
        >
          {words.version}
        </Text>
        <Text fz={10} fw={500} style={{ ...MONO, color: muted, alignSelf: 'center' }}>
          {words.published}
        </Text>
      </Box>
      <Box p={18}>
        <Text fz={13} c={muted}>
          {words.shape}
        </Text>
        {problem === null ? null : (
          <Text fz={13} c={muted}>
            {problem}
          </Text>
        )}
      </Box>
    </Stack>
  );
}
