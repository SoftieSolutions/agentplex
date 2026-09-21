// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { activitySchema, type Activity, type ActivityKind } from '@agentplex/protocol';
import { MantineProvider } from '../ui/components.js';
import { cssVariablesResolver, theme } from '../ui/theme.js';
import { ActivityWidget } from './activity-widget.js';

/**
 * Both forms of every kind, drawn directly.
 *
 * Directly, because four of the six kinds are emitted by no adapter today --
 * the captured transcripts redact the tool input an edit, a test run or a
 * narration would come from, and no provider writes an approval to disk
 * (AGX-263 re-captures fixtures with tool inputs). A suite that only drew what
 * a fixture happens to carry would leave those four untested until the day
 * they arrive, which is the day nobody wants to find out what they look like.
 *
 * Every activity is parsed through `activitySchema` rather than typed in, so
 * these are shapes the wire actually accepts and not shapes this file wishes
 * for.
 */

declare global {
  // React's own name for the act flag.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/** Mantine consults the media query for its colour scheme; jsdom has none. */
function installMatchMedia(): void {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

function parsed(raw: unknown): Activity {
  const result = activitySchema.safeParse(raw);
  if (!result.success)
    throw new Error(`the fixture activity did not parse: ${result.error.message}`);
  return result.data;
}

/** One of each kind, as small as the schema allows it to be. */
const ONE_OF_EACH: Record<ActivityKind, Activity> = {
  command: parsed({ kind: 'command', text: 'pnpm test auth', exitStatus: 1 }),
  edit: parsed({ kind: 'edit', path: 'src/auth/refresh.ts', added: 18, removed: 4 }),
  tests: parsed({ kind: 'tests', passed: 212, failed: 2 }),
  narration: parsed({ kind: 'narration', text: 'adding a regression test for the tab race' }),
  approval: parsed({ kind: 'approval', text: 'run git push' }),
  plain: parsed({ kind: 'plain', text: 'waiting on the sandbox' }),
};

const KINDS = Object.keys(ONE_OF_EACH) as readonly ActivityKind[];

describe('an activity widget', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    installMatchMedia();
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  function draw(activity: Activity, form: 'collapsed' | 'full'): HTMLElement {
    act(() => {
      root = createRoot(container);
      root.render(
        <MantineProvider
          theme={theme}
          cssVariablesResolver={cssVariablesResolver}
          defaultColorScheme="dark"
        >
          <ActivityWidget activity={activity} form={form} scheme="dark" />
        </MantineProvider>,
      );
    });
    // The provider injects its variables as a style element of its own, so the
    // widget is looked up by its element rather than taken off the top.
    const drawn = container.querySelector('p');
    if (drawn === null) throw new Error('the widget drew nothing');
    return drawn;
  }

  it('draws every kind in both forms, and never an empty line', () => {
    for (const kind of KINDS) {
      for (const form of ['collapsed', 'full'] as const) {
        const drawn = draw(ONE_OF_EACH[kind], form);
        expect(drawn.textContent?.trim(), `${kind} drew nothing in its ${form} form`).not.toBe('');
      }
    }
  });

  it('quotes a command and says its exit status in words', () => {
    expect(draw(ONE_OF_EACH.command, 'collapsed').textContent).toBe(
      'pnpm test auth failed with exit status 1',
    );
  });

  it('says an edit as the path and its counts', () => {
    expect(draw(ONE_OF_EACH.edit, 'collapsed').textContent).toBe(
      'editing src/auth/refresh.ts 18 added, 4 removed',
    );
  });

  it('says a test run as its counts', () => {
    expect(draw(ONE_OF_EACH.tests, 'collapsed').textContent).toBe('212 passed, 2 failed');
  });

  it('gives the three text kinds their own text and nothing else', () => {
    expect(draw(ONE_OF_EACH.narration, 'collapsed').textContent).toBe(
      'adding a regression test for the tab race',
    );
    expect(draw(ONE_OF_EACH.approval, 'collapsed').textContent).toBe('run git push');
    expect(draw(ONE_OF_EACH.plain, 'collapsed').textContent).toBe('waiting on the sandbox');
  });

  /**
   * The same truncation the name, the place line and the small print on a card
   * already use, asserted by the same attribute their own suites assert: a
   * list whose facts were cut two different ways would be a list where one of
   * them stopped being cut.
   */
  it('truncates the collapsed form with an ellipsis and keeps it on one line', () => {
    for (const kind of KINDS) {
      const drawn = draw(ONE_OF_EACH[kind], 'collapsed');
      expect(drawn.getAttribute('data-truncate'), `${kind} collapsed`).toBe('end');
      expect(drawn.style.whiteSpace, `${kind} collapsed`).not.toBe('pre-wrap');
    }
  });

  it('wraps the full form instead of cutting it', () => {
    for (const kind of KINDS) {
      const drawn = draw(ONE_OF_EACH[kind], 'full');
      expect(drawn.getAttribute('data-truncate'), `${kind} full`).toBeNull();
      expect(drawn.style.whiteSpace, `${kind} full`).toBe('pre-wrap');
      expect(drawn.style.overflowWrap, `${kind} full`).toBe('anywhere');
    }
  });

  it('draws a command and a path left to right, whatever is around them', () => {
    for (const kind of ['command', 'edit'] as const) {
      for (const form of ['collapsed', 'full'] as const) {
        const quoted = draw(ONE_OF_EACH[kind], form).querySelector('[dir="ltr"]');
        expect(quoted, `${kind} in its ${form} form drew no left-to-right run`).not.toBeNull();
        expect(quoted?.textContent).toBe(
          kind === 'command' ? 'pnpm test auth' : 'src/auth/refresh.ts',
        );
      }
    }
  });

  it('claims nothing about the words this app wrote: they carry no dir of their own', () => {
    expect(draw(ONE_OF_EACH.narration, 'collapsed').querySelector('[dir="ltr"]')).toBeNull();
  });

  it('renders a provider string as text and never as markup', () => {
    const drawn = draw(parsed({ kind: 'plain', text: '<b>bold</b> & <script>x</script>' }), 'full');
    expect(drawn.querySelector('b')).toBeNull();
    expect(drawn.querySelector('script')).toBeNull();
    expect(drawn.textContent).toBe('<b>bold</b> & <script>x</script>');
  });
});
