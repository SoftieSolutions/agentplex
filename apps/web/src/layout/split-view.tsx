import { useRef, useState, type JSX, type PointerEvent } from 'react';
import type { HubStore } from '../store/hub-store.js';
import { SessionPane } from '../terminal/session-pane.js';
import { sessionHash } from '../terminal/session-route.js';
import { Stack, Text } from '../ui/components.js';
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
      <PaneContentView leaf={leaf} view={view} />
    </div>
  );
}

function PaneContentView({
  leaf,
  view,
}: {
  readonly leaf: PaneLeaf;
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
    case 'empty':
      return (
        <Placeholder scheme={view.scheme} title="No session here yet">
          Open a session address, or close this pane with Ctrl+Shift+X.
        </Placeholder>
      );
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

function Placeholder({
  scheme,
  title,
  children,
}: {
  readonly scheme: Scheme;
  readonly title: string;
  readonly children: string;
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
