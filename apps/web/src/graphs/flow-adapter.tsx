import { useState, type CSSProperties, type JSX } from 'react';
import {
  applyNodeChanges,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type NodeTypes,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  graphNodeIdSchema,
  type GraphDocument,
  type GraphNodeId,
  type GraphNodeKind,
  type ServerRegistrationId,
} from '@agentplex/protocol';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { KIND_WORDS, moveNode, nodeSubtitle, zoomLabel, type GraphEdit } from './graph-model.js';

/**
 * The one file that speaks React Flow.
 *
 * Everything the library needs comes in as a `GraphDocument` and everything
 * it reports goes out as a callback naming a node of that document, so the
 * screen, the store and the inspector know nothing of a flow node or an edge
 * id -- and `eslint.config.js` refuses an `@xyflow` import anywhere else,
 * for the reason Mantine has one directory. Two functions are the seam and
 * are tested as such: `toFlow` turns a document into what the library draws,
 * `fromFlowChange` turns what the library reports into an edit of the
 * document, dropping everything that is not the document's business.
 *
 * ## Controlled nodes, and where the drag lives
 *
 * The library is given its nodes and told of every change (`onNodesChange`),
 * which is how the document stays the truth: a drag moves the flow node on
 * screen frame by frame, and only the drop (`onNodeDragStop`) reaches the
 * document, as one `moveNode`. The frames in between live in this file's own
 * state, derived from the document again whenever the document changes --
 * the derivation happens during render, by React's own rule for state that
 * follows a prop, and never in an effect. What the derivation keeps from the
 * old nodes is the library's measurements: the size a node was measured at
 * arrives as a change too, and an edge is drawn from that size, so dropping
 * it would draw edges to nothing.
 *
 * ## Hues
 *
 * The stylesheet is the library's, the colours are not: every `--xy-*`
 * variable the canvas reads is set here from `tokens.ts` roles, so the
 * canvas follows the scheme and no hue lives in this file.
 */

/** What a card carries beyond its position: the words drawn on it. */
export interface CardData extends Record<string, unknown> {
  readonly kind: GraphNodeKind;
  readonly label: string;
  /** The third line: `nodeSubtitle`'s answer. */
  readonly subtitle: string;
  readonly scheme: Scheme;
}

export type CardNode = Node<CardData, 'card'>;
export type FlowNodeChange = NodeChange<CardNode>;

export interface Flow {
  readonly nodes: CardNode[];
  readonly edges: Edge[];
}

/** Every node as a card, every edge and route as an edge, the selection marked. */
export function toFlow(
  document: GraphDocument,
  selection: GraphNodeId | null,
  labels: ReadonlyMap<ServerRegistrationId, string>,
  scheme: Scheme = 'dark',
): Flow {
  const nodes: CardNode[] = document.nodes.map((node) => ({
    id: node.id,
    type: 'card',
    position: { x: node.position.x, y: node.position.y },
    selected: node.id === selection,
    data: {
      kind: node.kind,
      label: node.label,
      subtitle: nodeSubtitle(node, labels),
      scheme,
    },
  }));

  const arrow = { type: MarkerType.ArrowClosed, width: 14, height: 14 } as const;
  const edges: Edge[] = document.edges.map((edge) => ({
    id: `edge:${edge.from}>${edge.to}`,
    source: edge.from,
    target: edge.to,
    markerEnd: arrow,
  }));
  for (const node of document.nodes) {
    if (node.kind !== 'router') continue;
    node.routes.forEach((route, index) => {
      edges.push({
        id: `route:${node.id}:${String(index)}`,
        source: node.id,
        target: route.to,
        label: route.condition,
        markerEnd: arrow,
      });
    });
    if (node.otherwise !== null) {
      edges.push({
        id: `otherwise:${node.id}`,
        source: node.id,
        target: node.otherwise,
        label: 'otherwise',
        markerEnd: arrow,
      });
    }
  }
  return { nodes, edges };
}

/**
 * A change the library reported, as an edit of the document, or `null` for
 * one that is none of the document's business.
 *
 * Only a finished move is: selection is the store's, a node's measured size
 * is the library's, and a removal is asked of the model by name rather than
 * arriving as a keystroke the library interpreted. A move still mid-drag is
 * dropped too, because the document takes the drop and not the frames.
 */
export function fromFlowChange(change: FlowNodeChange, document: GraphDocument): GraphEdit | null {
  if (change.type !== 'position') return null;
  if (change.position === undefined || change.dragging === true) return null;
  const id = graphNodeIdSchema.safeParse(change.id);
  if (!id.success) return { ok: false, problem: `${change.id} is not a graph node id` };
  return moveNode(document, id.data, change.position);
}

/** The card's width, as mockup 6d draws them. */
const CARD_WIDTH = 170;

const MONO = "'Fira Code', var(--mantine-font-family-monospace, monospace)";

/**
 * One node on the canvas: the kind in small capitals, the label, and the
 * third line. The handles are what a connection is dragged between, on the
 * left and the right because the layout reads left to right.
 */
function CardNodeView({ id, data, selected }: NodeProps<CardNode>): JSX.Element {
  const scheme = data.scheme;
  const edge = selected ? colorForRole('accent', scheme) : colorForRole('borderStrong', scheme);
  const style: CSSProperties = {
    width: CARD_WIDTH,
    background: colorForRole('surface', scheme),
    border: `1px solid ${edge}`,
    borderRadius: 10,
    padding: '10px 12px',
    color: colorForRole('text', scheme),
    fontSize: 13,
    boxShadow: selected ? `0 0 0 4px color-mix(in srgb, ${edge} 15%, transparent)` : undefined,
  };
  return (
    <div data-node-card={id} data-kind={data.kind} style={style}>
      <Handle type="target" position={Position.Left} />
      <div
        style={{
          fontFamily: MONO,
          fontSize: 9,
          fontWeight: 600,
          letterSpacing: '.08em',
          color: selected ? colorForRole('accent', scheme) : colorForRole('textMuted', scheme),
        }}
      >
        {KIND_WORDS[data.kind]}
      </div>
      <div style={{ fontWeight: 700, marginTop: 2 }}>{data.label}</div>
      <div style={{ fontSize: 11, color: colorForRole('textMuted', scheme) }}>{data.subtitle}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/** Outside the component, as the library asks: a new object per render is a remount of every node. */
const NODE_TYPES = { card: CardNodeView } satisfies NodeTypes;

/** The library's variables, answered from the tokens' roles for the scheme. */
function flowVariables(scheme: Scheme): CSSProperties {
  const variables: Record<`--${string}`, string> = {
    '--xy-background-color': colorForRole('background', scheme),
    '--xy-edge-stroke': colorForRole('textFaint', scheme),
    '--xy-edge-stroke-selected': colorForRole('accent', scheme),
    '--xy-edge-label-background-color': colorForRole('surface', scheme),
    '--xy-edge-label-color': colorForRole('textMuted', scheme),
    '--xy-handle-background-color': colorForRole('textMuted', scheme),
    '--xy-handle-border-color': colorForRole('surface', scheme),
    '--xy-node-background-color': colorForRole('surface', scheme),
    '--xy-node-border': `1px solid ${colorForRole('borderStrong', scheme)}`,
    '--xy-node-color': colorForRole('text', scheme),
    '--xy-node-boxshadow-selected': 'none',
    '--xy-attribution-background-color': colorForRole('surface', scheme),
    '--xy-selection-background-color': `color-mix(in srgb, ${colorForRole('accent', scheme)} 10%, transparent)`,
    '--xy-selection-border': `1px solid ${colorForRole('accent', scheme)}`,
  };
  return variables as CSSProperties;
}

export interface ZoomActions {
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
}

interface ZoomBarProps {
  readonly scheme: Scheme;
}

/**
 * The control mockup 6d puts in the corner: minus, the percentage, plus, fit.
 * Drawn from the viewport the library holds, so the figure is the zoom that
 * is actually applied and not one this file remembered.
 */
function ZoomBar({ scheme }: ZoomBarProps): JSX.Element {
  const { zoom } = useViewport();
  const flow = useReactFlow();
  const actions: ZoomActions = {
    zoomIn: () => void flow.zoomIn(),
    zoomOut: () => void flow.zoomOut(),
    fit: () => void flow.fitView({ padding: 0.2 }),
  };
  const button: CSSProperties = {
    padding: '4px 8px',
    background: 'transparent',
    border: 'none',
    color: colorForRole('textMuted', scheme),
    font: `500 11px ${MONO}`,
    cursor: 'pointer',
  };
  return (
    <Panel position="bottom-right">
      <div
        data-zoom-bar
        style={{
          display: 'flex',
          gap: 2,
          background: colorForRole('surface', scheme),
          border: `1px solid ${colorForRole('border', scheme)}`,
          borderRadius: 8,
          padding: 4,
        }}
      >
        <button
          type="button"
          data-zoom="out"
          aria-label="Zoom out"
          style={button}
          onClick={actions.zoomOut}
        >
          −
        </button>
        <span
          data-zoom-label
          style={{ ...button, color: colorForRole('text', scheme), cursor: 'default' }}
        >
          {zoomLabel(zoom)}
        </span>
        <button
          type="button"
          data-zoom="in"
          aria-label="Zoom in"
          style={button}
          onClick={actions.zoomIn}
        >
          +
        </button>
        <button
          type="button"
          data-zoom="fit"
          aria-label="Fit the graph"
          style={button}
          onClick={actions.fit}
        >
          fit
        </button>
      </div>
    </Panel>
  );
}

export interface GraphCanvasProps {
  readonly document: GraphDocument;
  readonly selection: GraphNodeId | null;
  /** Each pinned machine's label, for the card's third line. */
  readonly labels: ReadonlyMap<ServerRegistrationId, string>;
  readonly scheme: Scheme;
  /**
   * Whether nodes drag and the canvas pans. Off in a test, where there is no
   * pointer and the library's drag handling has nothing to bind to.
   */
  readonly interactive?: boolean;
  readonly onSelect: (id: GraphNodeId | null) => void;
  readonly onMove: (id: GraphNodeId, position: { x: number; y: number }) => void;
  readonly onConnect: (from: GraphNodeId, to: GraphNodeId) => void;
}

interface Held {
  readonly document: GraphDocument;
  readonly selection: GraphNodeId | null;
  readonly labels: ReadonlyMap<ServerRegistrationId, string>;
  readonly scheme: Scheme;
  readonly nodes: CardNode[];
}

/**
 * The nodes for a document, keeping what the library measured of the nodes
 * it already had. Position and selection come from the document and the
 * store: they are the truth this file follows, not the state it keeps.
 */
function derive(
  document: GraphDocument,
  selection: GraphNodeId | null,
  labels: ReadonlyMap<ServerRegistrationId, string>,
  scheme: Scheme,
  previous: readonly CardNode[],
): CardNode[] {
  const measured = new Map(previous.map((node) => [node.id, node]));
  return toFlow(document, selection, labels, scheme).nodes.map((node) => {
    const before = measured.get(node.id);
    if (before === undefined) return node;
    const kept: CardNode = { ...node };
    if (before.measured !== undefined) kept.measured = before.measured;
    if (before.width !== undefined) kept.width = before.width;
    if (before.height !== undefined) kept.height = before.height;
    return kept;
  });
}

function firstSelected(params: OnSelectionChangeParams): GraphNodeId | null {
  const first = params.nodes[0];
  if (first === undefined) return null;
  const parsed = graphNodeIdSchema.safeParse(first.id);
  return parsed.success ? parsed.data : null;
}

export function GraphCanvas(props: GraphCanvasProps): JSX.Element {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

function Canvas({
  document,
  selection,
  labels,
  scheme,
  interactive = true,
  onSelect,
  onMove,
  onConnect,
}: GraphCanvasProps): JSX.Element {
  const [held, setHeld] = useState<Held>(() => ({
    document,
    selection,
    labels,
    scheme,
    nodes: toFlow(document, selection, labels, scheme).nodes,
  }));

  // State that follows a prop, adjusted during render by React's own rule for
  // it: when the document, the selection or the words on the cards change, the
  // nodes are derived again and the render continues with the new ones.
  let nodes = held.nodes;
  if (
    held.document !== document ||
    held.selection !== selection ||
    held.labels !== labels ||
    held.scheme !== scheme
  ) {
    nodes = derive(document, selection, labels, scheme, held.nodes);
    setHeld({ document, selection, labels, scheme, nodes });
  }

  const edges = toFlow(document, selection, labels, scheme).edges;

  function onNodesChange(changes: FlowNodeChange[]): void {
    setHeld((current) => ({ ...current, nodes: applyNodeChanges(changes, current.nodes) }));
  }

  function onNodeDragStop(_event: unknown, node: CardNode): void {
    const parsed = graphNodeIdSchema.safeParse(node.id);
    if (parsed.success) onMove(parsed.data, node.position);
  }

  function onConnection(connection: Connection): void {
    const from = graphNodeIdSchema.safeParse(connection.source);
    const to = graphNodeIdSchema.safeParse(connection.target);
    if (from.success && to.success) onConnect(from.data, to.data);
  }

  return (
    <div
      data-graph-canvas
      style={{ width: '100%', height: '100%', minHeight: 0, ...flowVariables(scheme) }}
    >
      <ReactFlow<CardNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onSelectionChange={(params) => onSelect(firstSelected(params))}
        onConnect={onConnection}
        nodesDraggable={interactive}
        panOnDrag={interactive}
        nodesConnectable={interactive}
        zoomOnScroll={interactive}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.25}
        maxZoom={2}
        colorMode={scheme}
        proOptions={{ hideAttribution: false }}
      >
        <ZoomBar scheme={scheme} />
      </ReactFlow>
    </div>
  );
}
