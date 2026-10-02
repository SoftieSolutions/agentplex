import {
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { Box } from '../ui/components.js';
import { colorForRole, type Scheme } from '../ui/tokens.js';
import { withSafeArea } from './safe-area.js';
import { subscribeToWidth } from './shell-form.js';
import { SIDEBAR_DEFAULT, SIDEBAR_MIN, sidebarMaxFor, type SidebarWidth } from './sidebar-width.js';

/**
 * The wide shell's sidebar column, and the edge that widens it.
 *
 * The column is drawn at the width chosen on this device, capped by what the
 * window can spare. That cap is `sidebarMaxFor`'s rule and nowhere else's: the
 * frame only takes the smaller of the two, so a window narrowed past the
 * chosen width draws a narrower column without writing anything, and widening
 * it again draws the chosen width back.
 *
 * No effects. The window and the stored width are both external stores, read
 * through `useSyncExternalStore`; the window's subscription is the one the
 * shell's form is read off. The only local state is the drag in flight and
 * whether the handle has focus, and a drag writes once, at the release -- the
 * same split the pane divider makes (src/layout/split-view.tsx), where only
 * the release is a change worth keeping.
 *
 * The sidebar arrives as children rather than being built here, so a preview
 * re-rendering this frame on every pointer move does not re-render the
 * sidebar inside it.
 */

/** How far one arrow key moves the edge, in CSS pixels. */
const KEY_STEP = 16;

/** The widest the sidebar may be drawn in the window as it is now. */
function readSidebarMax(): number {
  return sidebarMaxFor(window.innerWidth);
}

export interface SidebarFrameProps {
  /** Where the chosen width is kept: this device's, or a test's. */
  readonly store: SidebarWidth;
  readonly scheme: Scheme;
  /** The sidebar itself. */
  readonly children: ReactNode;
}

export function SidebarFrame({ store, scheme, children }: SidebarFrameProps): JSX.Element {
  const max = useSyncExternalStore(subscribeToWidth, readSidebarMax);
  const stored = useSyncExternalStore(store.subscribe, store.read);
  // The edge mid-drag, or null while nobody is holding it. Local on purpose:
  // only the release is written.
  const [preview, setPreview] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const aside = useRef<HTMLElement | null>(null);
  // What is drawn, and what the keyboard steps from: never wider than the
  // window allows, whatever was stored.
  const width = Math.min(preview ?? stored, max);

  // In the body because it reads the column this component drew and the
  // maximum this render read.
  function widthAt(event: PointerEvent<HTMLDivElement>): number {
    // Mantine sets border-box everywhere, so the distance from the column's
    // left edge to the pointer is the width to draw, inset and border included.
    const left = aside.current?.getBoundingClientRect().left ?? 0;
    return Math.min(max, Math.max(SIDEBAR_MIN, Math.round(event.clientX - left)));
  }

  function dragStart(event: PointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function dragMove(event: PointerEvent<HTMLDivElement>): void {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    setPreview(widthAt(event));
  }

  function dragEnd(event: PointerEvent<HTMLDivElement>): void {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    // A press that never moved is a click, or half a double click, and not a
    // drag: committing where it landed would nudge the width.
    const moved = preview !== null;
    setPreview(null);
    if (moved) store.set(widthAt(event));
  }

  function dragCancel(): void {
    setPreview(null);
  }

  function step(event: KeyboardEvent<HTMLDivElement>): void {
    const next = keyedWidth(event.key, width, max);
    if (next === null) return;
    event.preventDefault();
    store.set(next);
  }

  return (
    <Box
      component="aside"
      ref={aside}
      style={{
        position: 'relative',
        // In pixels rather than as Mantine's `w`, which scales a number into
        // rem: the width is measured off a pointer in CSS pixels and stored as
        // one, so it is drawn as one.
        width,
        flexShrink: 0,
        minWidth: 0,
        borderRight: `1px solid ${colorForRole('border', scheme)}`,
        // A notched phone in landscape is wider than the breakpoint, so this
        // chrome is what it draws, and this is its left outer edge; the
        // content region insets the right one.
        paddingLeft: withSafeArea(0, 'left'),
      }}
    >
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={max}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={dragStart}
        onPointerMove={dragMove}
        onPointerUp={dragEnd}
        onPointerCancel={dragCancel}
        onKeyDown={step}
        onDoubleClick={() => store.set(SIDEBAR_DEFAULT)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          // Straddling the border rather than inside the column, so the
          // sidebar's own scrollbar at its right edge stays reachable.
          position: 'absolute',
          top: 0,
          bottom: 0,
          right: -3,
          width: 5,
          zIndex: 1,
          cursor: 'col-resize',
          touchAction: 'none',
          background: preview !== null || focused ? colorForRole('accent', scheme) : 'transparent',
          outline: 'none',
        }}
      />
    </Box>
  );
}

/**
 * Where a key moves the edge from the drawn width, or null for a key that is
 * not the handle's. The arrows step, Home and End go to the bounds, and the
 * widest is whatever this window allows rather than the stored cap. A step
 * left past the narrowest is the store's to clamp.
 */
function keyedWidth(key: string, width: number, max: number): number | null {
  switch (key) {
    case 'ArrowRight':
      return Math.min(width + KEY_STEP, max);
    case 'ArrowLeft':
      return width - KEY_STEP;
    case 'Home':
      return SIDEBAR_MIN;
    case 'End':
      return max;
    default:
      return null;
  }
}
