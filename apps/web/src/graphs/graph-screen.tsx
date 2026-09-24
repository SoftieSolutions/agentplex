import { useState, useSyncExternalStore, type JSX } from 'react';
import type {
  GraphNodeKind,
  Layout,
  MachineState,
  NodeId,
  ServerRegistrationId,
  StoreId,
} from '@agentplex/protocol';
import { machineSelector } from '../machines/machine-selector-model.js';
import type { HubStore } from '../store/hub-store.js';
import { useHubLayout, useHubSnapshot } from '../store/use-hub-store.js';
import { GRAPH_KIND, PROJECT_KIND } from '../tree/node-kinds.js';
import { Box, Button, Group, Menu, Stack, Text, useComputedColorScheme } from '../ui/components.js';
import { colorForRole, colorForTone, type Scheme } from '../ui/tokens.js';
import { GraphCanvas } from './flow-adapter.js';
import { addNode, connect, KIND_WORDS, KINDS, moveNode, type NodeSeed } from './graph-model.js';
import { createGraphStore } from './graph-store.js';
import { NodeInspector, type InspectorMachine } from './node-inspector.js';

/**
 * The graph screen mockup 6d draws: a header naming the project and the
 * graph with its draft number, the canvas, and the inspector down the right.
 *
 * It is a screen and not a pane -- the shell draws it straight into the
 * content region, for the reason `app-shell.tsx` gives -- and it owns one
 * thing: the graph store, made once per mount and keyed by the shell on the
 * node, so following a link to another graph mounts a fresh screen that asks
 * for its own document. Everything the canvas and the inspector do comes back
 * here as an edit and goes into that store; nothing on the screen writes the
 * document itself.
 *
 * ## The header
 *
 * `<project> / <name>` is read off the tree the shell already subscribes to,
 * because the graph-document frame carries the name and not the project: the
 * project is the graph's parent row and the tree is where rows live. A graph
 * the tree does not list yet -- the layout not answered, or a create the
 * catalogue change has not reached -- draws the name alone rather than a
 * project guessed at.
 *
 * Simulate and Run are drawn because the mock draws them and disabled
 * because nothing is behind them yet: AGX-147 builds the one and AGX-146 the
 * other, and each says so in its title. This is the opposite choice from the
 * New menu, which leaves an unbuilt kind out, and it is made for a different
 * control: a menu row is a promise to make something, while these two are
 * the shape of a header the next two tickets fill in place.
 */

export interface GraphHeading {
  readonly project: string | null;
  readonly name: string | null;
}

/** The project the graph sits under, found by walking up the tree, and the graph's name. */
export function graphHeading(
  layout: Layout | null,
  nodeId: NodeId,
  name: string | null,
): GraphHeading {
  if (layout === null) return { project: null, name };
  const byId = new Map(layout.map((node) => [node.id, node]));
  let current = byId.get(nodeId);
  while (current !== undefined) {
    if (current.kind === PROJECT_KIND) return { project: current.name, name };
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return { project: null, name };
}

/** Some other graph in the tree for a SUB-GRAPH to pin, or `null` when this is the only one. */
export function otherGraph(layout: Layout | null, nodeId: NodeId): NodeId | null {
  if (layout === null) return null;
  return layout.find((node) => node.kind === GRAPH_KIND && node.id !== nodeId)?.id ?? null;
}

interface FleetFacts {
  readonly labels: ReadonlyMap<ServerRegistrationId, string>;
  readonly machines: readonly InspectorMachine[];
  readonly stores: readonly StoreId[];
}

/** What the canvas and the inspector need to know of the fleet, read once per snapshot. */
function fleetFacts(state: MachineState | null): FleetFacts {
  const rows = machineSelector(state, null).rows;
  return {
    labels: new Map(rows.map((row) => [row.registrationId, row.label])),
    machines: rows.map((row) => ({
      registrationId: row.registrationId,
      label: row.label,
      words: row.words,
    })),
    stores: (state?.stores ?? []).map((store) => store.storeId),
  };
}

/** Where a new node lands: below the lowest card, at the left, so it is found and not hidden under one. */
function nextPosition(nodes: readonly { position: { x: number; y: number } }[]): {
  x: number;
  y: number;
} {
  const lowest = nodes.reduce((max, node) => Math.max(max, node.position.y), -120);
  return { x: 40, y: lowest + 120 };
}

const MONO = { fontFamily: 'var(--mantine-font-family-monospace)' } as const;

export interface GraphScreenProps {
  readonly nodeId: NodeId;
  /** The page's one hub store, handed down by the shell that mounts this. */
  readonly store: HubStore;
}

export function GraphScreen({ nodeId, store: hub }: GraphScreenProps): JSX.Element {
  const scheme: Scheme = useComputedColorScheme('dark');
  // A screen-lifetime collaborator, not render data: one graph store per
  // mounted screen. The shell keys the screen on the node.
  const [graph] = useState(() => createGraphStore({ hub, nodeId }));
  const state = useSyncExternalStore(graph.subscribe, graph.getSnapshot);
  const snapshot = useHubSnapshot(hub);
  const layout = useHubLayout(hub);

  const fleet = fleetFacts(snapshot.machineState);
  const heading = graphHeading(layout, nodeId, state.name);
  const seed: NodeSeed = { storeId: fleet.stores[0] ?? null, graph: otherGraph(layout, nodeId) };
  const border = `1px solid ${colorForRole('border', scheme)}`;
  const muted = colorForRole('textMuted', scheme);
  const document = state.document;
  const selected = document?.nodes.find((node) => node.id === state.selection) ?? null;

  return (
    <Stack gap={0} data-graph-screen={nodeId} style={{ height: '100%' }}>
      <Group
        data-graph-header
        gap={10}
        px={18}
        py={10}
        wrap="nowrap"
        style={{ borderBottom: border }}
      >
        {heading.project === null ? null : (
          <Text fz={13} c={muted} style={{ whiteSpace: 'nowrap' }}>
            {heading.project} /
          </Text>
        )}
        <Text fw={700} fz={15} style={{ whiteSpace: 'nowrap' }}>
          {heading.name ?? 'graph'}
        </Text>
        {state.draftVersion === null ? null : (
          <Text
            fz={10}
            fw={500}
            px={6}
            style={{
              ...MONO,
              border: `1px solid ${colorForRole('borderStrong', scheme)}`,
              borderRadius: 4,
              whiteSpace: 'nowrap',
            }}
          >
            v{String(state.draftVersion)} · draft
          </Text>
        )}
        {state.dirty ? (
          <Text fz={10} fw={500} c={muted} style={MONO}>
            unsaved
          </Text>
        ) : null}
        {state.problem === null ? null : (
          <Text fz={12} style={{ color: colorForTone('blocked', scheme), minWidth: 0 }} truncate>
            {state.problem}
          </Text>
        )}
        <Group gap={6} ml="auto" wrap="nowrap">
          <AddNodeMenu
            disabled={document === null}
            onPick={(kind) =>
              graph.edit((current) => addNode(current, kind, nextPosition(current.nodes), seed))
            }
          />
          <Button
            variant="default"
            size="xs"
            disabled={!state.dirty || state.saving}
            onClick={() => graph.save()}
          >
            Save
          </Button>
          <Button
            variant="default"
            size="xs"
            disabled={document === null || state.publishing}
            onClick={() => graph.publish()}
          >
            {state.draftVersion === null ? 'Publish' : `Publish v${String(state.draftVersion)}`}
          </Button>
          <Button
            variant="default"
            size="xs"
            disabled
            title="Simulate is not built yet: AGX-147 adds it"
          >
            Simulate
          </Button>
          <Button size="xs" disabled title="Run is not built yet: AGX-146 adds it">
            Run
          </Button>
        </Group>
      </Group>
      <Box style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <Box style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          {document === null ? (
            <Box p={18}>
              <Text fz={13} c={muted}>
                {state.problem ?? 'opening the graph'}
              </Text>
            </Box>
          ) : (
            <GraphCanvas
              document={document}
              selection={state.selection}
              labels={fleet.labels}
              scheme={scheme}
              onSelect={(id) => graph.select(id)}
              onMove={(id, position) => graph.edit((current) => moveNode(current, id, position))}
              onConnect={(from, to) => graph.edit((current) => connect(current, from, to))}
            />
          )}
        </Box>
        <Box
          // A section and not an aside: the page has one aside, the shell's
          // sidebar, and the shell's own suite counts on that being true.
          component="section"
          aria-label="Inspector"
          w={280}
          style={{
            flexShrink: 0,
            borderLeft: border,
            background: colorForRole('surface', scheme),
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
          }}
        >
          {document === null ? null : (
            <NodeInspector
              node={selected}
              document={document}
              machines={fleet.machines}
              stores={fleet.stores}
              scheme={scheme}
              onEdit={(edit) => graph.edit(edit)}
            />
          )}
        </Box>
      </Box>
    </Stack>
  );
}

interface AddNodeMenuProps {
  readonly disabled: boolean;
  readonly onPick: (kind: GraphNodeKind) => void;
}

/** The six kinds, in the model's order, each a row that adds one. */
function AddNodeMenu({ disabled, onPick }: AddNodeMenuProps): JSX.Element {
  return (
    <Menu position="bottom-end" shadow="md" withinPortal>
      <Menu.Target>
        <Button variant="default" size="xs" disabled={disabled}>
          Add node
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {KINDS.map((kind) => (
          <Menu.Item key={kind} data-add-node={kind} onClick={() => onPick(kind)}>
            {KIND_WORDS[kind]}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
