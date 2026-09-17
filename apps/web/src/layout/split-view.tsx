import { useRef, useState, type JSX, type PointerEvent, type ReactNode } from 'react';
import type { SessionRef } from '@agentplex/protocol';
import { DocPane } from '../docs/doc-pane.js';
import { NO_FILTERS, visibleSessions } from '../sessions/session-list-model.js';
import { destinationHash } from '../shell/destinations.js';
import { NextActionLink } from '../shell/next-action.js';
import type { HubStore } from '../store/hub-store.js';
import { useHubSnapshot } from '../store/use-hub-store.js';
import { SessionPane } from '../terminal/session-pane.js';
import { sessionHash } from '../terminal/session-route.js';
import { Group, Stack, Text, UnstyledButton } from '../ui/components.js';
import { ToneDot } from '../ui/tone-dot.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { RATIO_BOUNDS, type LayoutTree, type PaneLeaf, type PanePath, type Split } from './tree.js';

/**
 * The tree on screen: splits become flex rows and columns, ratios become flex
 * shares, and each divider is a pointer-drag surface.
 *
 * A drag previews locally and commits once, on release. The preview is this
 * component's state because a divider mid-drag is this tab's hand on this
 * screen — sixty ratio updates a second are not sixty structural edits, and
 * the tree (and through it the debounced save) hears exactly one, when the
 * hand lets go.
 *
 * Chrome is deliberately minimal, per the mockup's visual language: hairline
 * token-colored dividers, and focus marked by a border in the accent — the
 * one distinction the layout is allowed to draw attention with.
 */

export function pathKey(path: PanePath): string {
  return JSON.stringify(path);
}

const DIVIDER_PX = 5;

export interface PaneViewDependencies {
  readonly hub: HubStore;
  readonly scheme: Scheme;
  readonly focus: PanePath;
  onCommitRatio(path: PanePath, ratio: number): void;
  onFocusPane(path: PanePath): void;
  /**
   * Puts a session in the pane at `path`: what the empty pane's picker calls.
   *
   * The path is passed rather than left to the focus, although a click in a
   * pane focuses it first. Two reasons: the picker is a control that says
   * which pane it belongs to, and a focus change that happened to arrive out
   * of order would put the session somewhere else entirely -- which is a bug
   * whose symptom is a session opening in the pane next door.
   */
  onShowSession(path: PanePath, session: SessionRef): void;
  /** Where each pane's element lands, so a focus move can focus the DOM too. */
  registerPane(key: string, element: HTMLDivElement | null): void;
}

export interface NodeViewProps {
  readonly node: LayoutTree;
  readonly path: PanePath;
  readonly view: PaneViewDependencies;
}

export function NodeView({ node, path, view }: NodeViewProps): JSX.Element {
  return node.kind === 'pane' ? (
    <PaneView leaf={node} path={path} view={view} />
  ) : (
    <SplitNodeView split={node} path={path} view={view} />
  );
}

function clampRatio(ratio: number): number {
  return Math.min(RATIO_BOUNDS.max, Math.max(RATIO_BOUNDS.min, ratio));
}

function SplitNodeView({
  split,
  path,
  view,
}: {
  readonly split: Split;
  readonly path: PanePath;
  readonly view: PaneViewDependencies;
}): JSX.Element {
  const container = useRef<HTMLDivElement | null>(null);
  // The divider mid-drag, or null while nobody is holding it. Local on
  // purpose: only the release is a structural change.
  const [preview, setPreview] = useState<number | null>(null);
  const row = split.direction === 'row';
  const ratio = preview ?? split.ratio;

  function ratioAt(event: PointerEvent<HTMLDivElement>): number | null {
    const rect = container.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0 || rect.height === 0) return null;
    return clampRatio(
      row ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height,
    );
  }

  function dragStart(event: PointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function dragMove(event: PointerEvent<HTMLDivElement>): void {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    setPreview(ratioAt(event));
  }

  function dragEnd(event: PointerEvent<HTMLDivElement>): void {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    setPreview(null);
    const landed = ratioAt(event);
    if (landed !== null) view.onCommitRatio(path, landed);
  }

  function dragCancel(): void {
    setPreview(null);
  }

  return (
    <div
      ref={container}
      style={{
        display: 'flex',
        flexDirection: row ? 'row' : 'column',
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <div style={{ flex: `${ratio} 1 0px`, minWidth: 0, minHeight: 0 }}>
        <NodeView node={split.first} path={[...path, 'first']} view={view} />
      </div>
      <div
        role="separator"
        aria-orientation={row ? 'vertical' : 'horizontal'}
        onPointerDown={dragStart}
        onPointerMove={dragMove}
        onPointerUp={dragEnd}
        onPointerCancel={dragCancel}
        style={{
          flex: 'none',
          ...(row ? { width: DIVIDER_PX } : { height: DIVIDER_PX }),
          cursor: row ? 'col-resize' : 'row-resize',
          touchAction: 'none',
          background: colorForRole('border', view.scheme),
        }}
      />
      <div style={{ flex: `${1 - ratio} 1 0px`, minWidth: 0, minHeight: 0 }}>
        <NodeView node={split.second} path={[...path, 'second']} view={view} />
      </div>
    </div>
  );
}

function PaneView({
  leaf,
  path,
  view,
}: {
  readonly leaf: PaneLeaf;
  readonly path: PanePath;
  readonly view: PaneViewDependencies;
}): JSX.Element {
  const key = pathKey(path);
  const focused = key === pathKey(view.focus);
  return (
    <div
      ref={(element) => view.registerPane(key, element)}
      tabIndex={-1}
      onPointerDownCapture={() => view.onFocusPane(path)}
      onFocusCapture={() => view.onFocusPane(path)}
      style={{
        width: '100%',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
        outline: 'none',
        // The focused pane and no other wears the accent; every other border
        // on screen is the hairline token.
        border: `1px solid ${colorForRole(focused ? 'accent' : 'border', view.scheme)}`,
      }}
    >
      <PaneContentView leaf={leaf} path={path} view={view} />
    </div>
  );
}

function PaneContentView({
  leaf,
  path,
  view,
}: {
  readonly leaf: PaneLeaf;
  readonly path: PanePath;
  readonly view: PaneViewDependencies;
}): JSX.Element {
  const content = leaf.content;
  switch (content.type) {
    case 'session':
      // Keyed on the session so a pane whose content changes remounts: a
      // terminal feed and emulator belong to one session, never two.
      return (
        <SessionPane
          key={sessionHash(content.session)}
          sessionRef={content.session}
          store={view.hub}
        />
      );
    case 'doc':
      // Keyed on the node for the reason a session pane is keyed on its
      // session: the editor store holding unsaved text belongs to one
      // document, and a pane whose content changed must not carry it over.
      return <DocPane key={content.nodeId} nodeId={content.nodeId} store={view.hub} />;
    case 'empty':
      return <EmptyPaneView path={path} view={view} />;
    case 'unknown':
      // The placeholder costs itself, not the tree, and says why it is one:
      // the pane came from a build that knows a kind this one does not. It is
      // preserved verbatim in every save, so nothing is lost by looking.
      return (
        <Placeholder scheme={view.scheme} title="A newer pane">
          This pane was arranged by a newer client and is kept as saved.
        </Placeholder>
      );
  }
}

/**
 * An empty pane, offering the sessions there are.
 *
 * `tree.ts` reserved this spot -- "no session here yet; later tickets put a
 * picker in it" -- and until AGX-119 what stood in it was a sentence telling
 * somebody to go and type an address. This is that picker, and it is built
 * out of what already exists: the rows are `visibleSessions`, which is the
 * session list's own ordering (needs-you first, then activity), so the pane
 * offers the fleet in the order the list shows it rather than in a second
 * order of its own.
 *
 * The subscription is here rather than in the layout screen on purpose. An
 * empty pane is rare and a session pane is not: putting the hub snapshot at
 * the root would re-render every pane in the tree on every broadcast, when
 * only this one reads it. `useSyncExternalStore` through `useHubSnapshot`, so
 * there is no effect and no second socket.
 */
function EmptyPaneView({
  path,
  view,
}: {
  readonly path: PanePath;
  readonly view: PaneViewDependencies;
}): JSX.Element {
  const snapshot = useHubSnapshot(view.hub);
  const state = snapshot.machineState;
  const sessions = state === null ? [] : visibleSessions(state, NO_FILTERS);

  if (sessions.length === 0) {
    return (
      <Placeholder scheme={view.scheme} title="No session here yet">
        {state === null ? (
          'The hub has not answered with the fleet yet, so there is nothing to offer.'
        ) : (
          <>
            No session exists to put here.{' '}
            <NextActionLink
              action={{
                label: 'Start one from the session list',
                hash: destinationHash('sessions'),
              }}
              scheme={view.scheme}
            />
          </>
        )}
      </Placeholder>
    );
  }

  return (
    <Stack gap={4} p={10} style={{ width: '100%', height: '100%', overflowY: 'auto' }}>
      <Text fz={11} fw={600} style={{ color: colorForRole('textMuted', view.scheme) }}>
        Show a session here
      </Text>
      {sessions.map((item) => (
        <UnstyledButton
          key={item.key}
          onClick={() => view.onShowSession(path, item.ref)}
          style={{
            padding: '6px 8px',
            borderRadius: 6,
            border: `1px solid ${colorForRole('border', view.scheme)}`,
            background: colorForRole('surfaceAlt', view.scheme),
          }}
        >
          <Group gap={8} align="center" wrap="nowrap">
            <ToneDot tone={item.tone} scheme={view.scheme} />
            <Text
              component="span"
              fz={12}
              style={{
                color: colorForRole('text', view.scheme),
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {item.name}
            </Text>
            <Text
              component="span"
              fz={11}
              style={{ color: colorForRole('textFaint', view.scheme), marginLeft: 'auto' }}
            >
              {item.machine}
            </Text>
          </Group>
        </UnstyledButton>
      ))}
      <Text fz={11} style={{ color: colorForRole('textFaint', view.scheme) }}>
        Or close this pane with Ctrl+Shift+X.
      </Text>
    </Stack>
  );
}

function Placeholder({
  scheme,
  title,
  children,
}: {
  readonly scheme: Scheme;
  readonly title: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <Stack align="center" justify="center" gap={4} style={{ width: '100%', height: '100%' }}>
      <Text fz={13} fw={600} style={{ color: colorForRole('textMuted', scheme) }}>
        {title}
      </Text>
      <Text fz={11} style={{ color: colorForRole('textFaint', scheme) }}>
        {children}
      </Text>
    </Stack>
  );
}
