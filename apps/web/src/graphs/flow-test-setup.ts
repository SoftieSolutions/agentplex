/**
 * What jsdom lacks and React Flow measures with: the four stand-ins its own
 * testing guide names, installed once per suite that mounts the canvas.
 *
 * React Flow sizes its viewport with a `ResizeObserver`, reads the pan and
 * zoom back off a CSS transform through `DOMMatrixReadOnly`, measures every
 * node by `offsetWidth`/`offsetHeight`, and lays an edge label out by its
 * `getBBox`. jsdom has none of the four, and without them the canvas mounts
 * an empty viewport and never draws a node. Nothing here asserts on a
 * measurement; the stand-ins exist so the tree is drawn at all.
 */

class FakeResizeObserver {
  private readonly callback: ResizeObserverCallback;
  private readonly watched = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element): void {
    this.watched.add(target);
    // A size, reported once and asynchronously the way a browser reports one,
    // and only while the target is still observed: the library reads the node
    // the entry names, and a report after the canvas unmounted names nothing.
    // The entry carries a `contentRect` because this version's pan-and-zoom
    // reads its extent off one, which the library's own guide predates.
    setTimeout(() => {
      if (!this.watched.has(target)) return;
      const entry = { target, contentRect: target.getBoundingClientRect() };
      this.callback([entry as ResizeObserverEntry], this);
    }, 0);
  }

  unobserve(target: Element): void {
    this.watched.delete(target);
  }

  disconnect(): void {
    this.watched.clear();
  }
}

class FakeDOMMatrixReadOnly {
  readonly m22: number;

  constructor(transform?: string) {
    const scale = transform === undefined ? undefined : /scale\(([1-9.]+)\)/.exec(transform)?.[1];
    this.m22 = scale === undefined ? 1 : Number(scale);
  }
}

export function installFlowMocks(): void {
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  globalThis.DOMMatrixReadOnly = FakeDOMMatrixReadOnly as unknown as typeof DOMMatrixReadOnly;
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: {
      configurable: true,
      get(this: HTMLElement): number {
        return parseFloat(this.style.height) || 1;
      },
    },
    offsetWidth: {
      configurable: true,
      get(this: HTMLElement): number {
        return parseFloat(this.style.width) || 1;
      },
    },
  });
  (SVGElement.prototype as SVGElement & { getBBox(): DOMRect }).getBBox = () =>
    ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;
}
