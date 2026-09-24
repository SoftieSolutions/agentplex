import { useMemo, useState, useSyncExternalStore, type JSX } from 'react';
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
import { addNode, connect, KIND_WORDS, KINDS, type NodeSeed } from './graph-model.js';
import { createGraphStore } from './graph-store.js';
import { NodeInspector, type InspectorMachine } from './node-inspector.js';
import { RunHistory } from './run-history.js';
import { isRunOpen, lastOutputFor, runningNode } from './run-model.js';
import { RunStrip } from './run-strip.js';
import { SimulatePanel } from './simulate-panel.js';
import { sampleInput } from './simulate-model.js';
import { ApprovalControls } from '../sessions/approval-controls.js';
import type { SessionProject } from '../sessions/approval-policy-model.js';
import { approvalsOldestFirst } from '../sessions/session-list-model.js';

/** A HUMAN node's request is handed no project: a standing rule is about a tool call, and this is not one. */
const NO_PROJECT: SessionProject = { kind: 'unplaced' };

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
 * Run runs the newest published version, so it is enabled exactly when one
 * exists, no run of the graph is in flight, and the hub has answered where
 * the graph's run stands -- asked on open and on every reconnection, because
 * a run somebody started from another tab, or that this tab started just as
 * its socket went, is a run and not a reason for a second. The input it sends is the
 * empty object: the mock has no input form for a run.
 *
 * ## Simulate
 *
 * Simulate is Run's peer, not a mode of it, and it needs no published
 * version: it asks what a run of the saved draft would do. Pressing it opens
 * the panel under the strip and sends the sample the draft's routes read at
 * once, so the first press answers something; the panel's box is where
 * another input is tried. It is held while the draft has unsaved edits,
 * because the hub walks the draft it holds and a path of a document the
 * person is not looking at would be a path of the wrong graph. Whether the
 * panel is open is the one piece of screen state here, and it is a view
 * choice rather than a fact any store owns.
 *
 * ## The run
 *
 * The strip under the header and the running tone on a card both read one
 * `GraphRunState`, the graph's newest as the hub last sent it. The state
 * arrives whole on every change, so nothing here keeps a step of its own:
 * `run-model.ts` derives the sentence, the node in flight and the inspector's
 * LAST OUTPUT from the same frame each render. While the connection is being
 * remade the store marks the run stale, and the strip and the cards draw it
 * at rest rather than live.
 *
 * ## The history, and a run picked from it
 *
 * The graph's runs are listed newest first under the inspector, and a row
 * picked there is what the strip and LAST OUTPUT read -- `shownRun`, which
 * is the newest until somebody picks. Run, Cancel and the running card stay
 * about the newest run: reading an old run is looking at history, and a
 * button that cancelled whichever run happened to be on the strip would be
 * a button that means two things. A SUB-GRAPH step's child is offered by the
 * inspector as a link to the child graph's screen, where that run is listed
 * under its own number.
 *
 * ## A run waiting on a person
 *
 * A run parked at a HUMAN node is a request the hub raised for itself, and
 * it rides the machine state beside the stores rather than the run state --
 * the run state says `waiting`, and the request is what a person answers.
 * The screen finds the request for its own run in that list and draws the
 * same Allow and Deny a session's request gets, under the strip: one pair of
 * buttons for every request in this app, whatever it is about. A graph is
 * filed under a project, but a standing rule is a project's decision about a
 * tool call and a HUMAN node is not one, so the pair is handed no project
 * and offers no rule.
 *
 * ## What is derived once per source, not once per frame
 *
 * The hub snapshot moves on every frame the hub sends, and the screen reads
 * it, so the screen renders on every frame. The fleet facts the canvas and
 * the inspector take are derived from one field of it, `machineState`, and
 * are memoised on that field: derived per render, the labels map would be a
 * new object each frame, the canvas would take that as a change of its
 * inputs and derive its nodes again, and a frame arriving mid-drag would put
 * the dragged card back where the document has it.
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
  // A view choice, not data: whether the simulate panel is drawn.
  const [simulateOpen, setSimulateOpen] = useState(false);
  const state = useSyncExternalStore(graph.subscribe, graph.getSnapshot);
  const snapshot = useHubSnapshot(hub);
  const layout = useHubLayout(hub);

  const machineState = snapshot.machineState;
  const fleet = useMemo(() => fleetFacts(machineState), [machineState]);
  const heading = graphHeading(layout, nodeId, state.name);
  const seed: NodeSeed = { storeId: fleet.stores[0] ?? null, graph: otherGraph(layout, nodeId) };
  const border = `1px solid ${colorForRole('border', scheme)}`;
  const muted = colorForRole('textMuted', scheme);
  const document = state.document;
  const selected = document?.nodes.find((node) => node.id === state.selection) ?? null;
  const running = runningNode(state.run, state.runStale);
  const simulateBlocked = state.dirty
    ? 'Save the draft first: a simulation walks the draft the hub holds'
    : null;
  const canRun =
    document !== null &&
    state.published.length > 0 &&
    !state.starting &&
    !state.readingRun &&
    (state.run === null || !isRunOpen(state.run.status));
  // The request this screen's run is waiting on, if it is. A find over a list
  // that is almost always empty, off the state the screen already subscribes
  // to; nothing is remembered, so a request that ends leaves on the next frame.
  // None for a stale run: the person may have answered while the socket was
  // down, and the pair returns once the read says the run still waits.
  const waitingOn =
    state.run === null || state.runStale || state.run.status !== 'waiting'
      ? null
      : (machineState?.graphRunApprovals.find(
          (waiting) => waiting.approval.subject.runId === state.run?.runId,
        ) ?? null);

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
            aria-pressed={simulateOpen}
            disabled={document === null || (!simulateOpen && simulateBlocked !== null)}
            title={simulateBlocked ?? undefined}
            onClick={() => {
              if (simulateOpen || document === null) {
                setSimulateOpen(false);
                return;
              }
              setSimulateOpen(true);
              graph.simulate(sampleInput(document));
            }}
          >
            Simulate
          </Button>
          <Button
            size="xs"
            disabled={!canRun}
            title={
              state.published.length === 0 && document !== null
                ? 'Publish a version first: a run is of a published version, never the draft'
                : undefined
            }
            onClick={() => graph.run({})}
          >
            Run
          </Button>
        </Group>
      </Group>
      {state.shownRun === null ? null : (
        <RunStrip
          run={state.shownRun}
          scheme={scheme}
          cancelling={state.cancelling}
          // Stale is about the run the strip names: the newest's read, or a
          // held pick's re-open, out after a drop.
          stale={state.shownRunStale}
          onCancel={() => graph.cancelRun()}
        />
      )}
      {simulateOpen && document !== null ? (
        <SimulatePanel
          document={document}
          simulation={state.simulation}
          simulating={state.simulating}
          blocked={simulateBlocked}
          scheme={scheme}
          onSimulate={(input) => graph.simulate(input)}
          onClose={() => setSimulateOpen(false)}
        />
      ) : null}
      {waitingOn === null ? null : (
        <Box
          data-run-approval={waitingOn.approval.approvalId}
          px={18}
          py={12}
          style={{ borderBottom: border }}
        >
          <ApprovalControls
            approval={approvalsOldestFirst([waitingOn.approval])[0] ?? null}
            // The node, because that is what varies between two runs of one
            // graph waiting at once, and what the bell's row named.
            name={waitingOn.nodeLabel}
            project={NO_PROJECT}
            store={hub}
            scheme={scheme}
          />
        </Box>
      )}
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
              running={running}
              onSelect={(id) => graph.select(id)}
              onEdit={(edit) => graph.edit(edit)}
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
              // Keyed on the node so the inspector's own drafts are the node's
              // and never carry from one selection to the next.
              key={selected?.id ?? 'none'}
              node={selected}
              document={document}
              machines={fleet.machines}
              stores={fleet.stores}
              scheme={scheme}
              lastOutput={selected === null ? null : lastOutputFor(state.shownRun, selected.id)}
              onEdit={(edit) => graph.edit(edit)}
            />
          )}
          <Box
            style={{
              borderTop: border,
              maxHeight: 200,
              overflowY: 'auto',
              flexShrink: 0,
            }}
          >
            <RunHistory
              runs={state.history}
              selected={state.selectedRun}
              scheme={scheme}
              onSelect={(runId) => graph.selectRun(runId)}
            />
          </Box>
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
