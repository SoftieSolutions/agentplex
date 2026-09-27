// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeStorage } from '../auth/fake-storage.js';
import { MockTag } from '../ui/mock-tag.js';
import { createMockSwitch, type MockSwitch } from './mock-switch.js';
import { MockModeProvider, useMockMode } from './use-mock-mode.js';

/**
 * The switch as a screen sees it: a harness consumer draws one real value and,
 * only while the switch is on, a sample value wearing the tag -- which is the
 * shape every mocked feature takes.
 */

declare global {
  // React's own name for the act flag.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const SAMPLE = 'sample: 3 graphs running';

function Harness(): JSX.Element {
  const mock = useMockMode();
  return (
    <p data-harness="">
      real: 1 session
      {mock && (
        <span>
          {SAMPLE}
          <MockTag scheme="dark" />
        </span>
      )}
    </p>
  );
}

describe('useMockMode', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  function draw(element: JSX.Element): void {
    act(() => {
      root = createRoot(container);
      root.render(element);
    });
  }

  function provided(mock: MockSwitch): JSX.Element {
    return (
      <MockModeProvider mock={mock}>
        <Harness />
      </MockModeProvider>
    );
  }

  it('draws no sample and no tag while the switch is off', () => {
    draw(provided(createMockSwitch({ storage: () => fakeStorage(), search: () => '' })));
    expect(container.textContent).toContain('real: 1 session');
    expect(container.textContent).not.toContain(SAMPLE);
    expect(container.querySelector('[data-mock-tag]')).toBeNull();
  });

  it('draws the sample with a tag beside it while the switch is on', () => {
    draw(provided(createMockSwitch({ storage: () => fakeStorage(), search: () => '?mock=1' })));
    const sample = [...container.querySelectorAll('span')].find(
      (span) => span.textContent?.startsWith(SAMPLE) === true,
    );
    expect(sample?.querySelector('[data-mock-tag]')?.textContent).toBe('Mock');
  });

  it('follows the switch both ways without remounting the consumer', () => {
    const mock = createMockSwitch({ storage: () => fakeStorage(), search: () => '' });
    draw(provided(mock));
    const before = container.querySelector('[data-harness]');

    act(() => {
      mock.set(true);
    });
    expect(container.textContent).toContain(SAMPLE);
    expect(container.querySelector('[data-mock-tag]')).not.toBeNull();

    act(() => {
      mock.set(false);
    });
    expect(container.textContent).not.toContain(SAMPLE);
    expect(container.querySelector('[data-mock-tag]')).toBeNull();
    expect(container.querySelector('[data-harness]')).toBe(before);
  });

  it('reads off with no provider above it, so a screen drawn alone invents nothing', () => {
    draw(<Harness />);
    expect(container.textContent).not.toContain(SAMPLE);
  });
});
