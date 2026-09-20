import type { JSX } from 'react';
import { Group, Stack, Text } from './components.js';
import { ToneDot } from './tone-dot.js';
import { colorForTone, type Scheme, type Tone } from './tokens.js';

/**
 * One agent a machine can, or cannot, start: a tone dot, the provider and its
 * version, and the machine's own sentence underneath when something is wrong.
 *
 * It sits here for the reason `ToneDot` does. The settings list and the
 * wizard's machine card had a copy each, identical down to the `dimmed` on the
 * words, and neither could import the other's: the wizard would have dragged
 * the whole settings screen behind a first-run step, and the settings screen
 * would have depended on onboarding to draw its own rows. Two copies of a line
 * whose whole job is to be the same claim in both places is how the two drift
 * -- and the drift nobody notices is the one that matters here, because this
 * line is the only place in the product that says a box will refuse every
 * start before somebody tries one.
 *
 * Drawn on healthy rows as well as broken ones. Which `claude` a machine will
 * actually run is the fact an operator comes to check, and a line that appears
 * only when something is already wrong teaches nobody where to look.
 */
export function ProviderLine({ provider, scheme }: ProviderLineProps): JSX.Element {
  return (
    <Stack gap={0}>
      <Group gap={6} align="center">
        <ToneDot tone={provider.tone} scheme={scheme} />
        <Text size="xs" ff="monospace" c="dimmed">
          {provider.words}
        </Text>
      </Group>
      {provider.problem !== null && (
        <Text size="xs" style={{ color: colorForTone(provider.tone, scheme) }}>
          {provider.problem}
        </Text>
      )}
    </Stack>
  );
}

export interface ProviderLineProps {
  readonly provider: ProviderRowView;
  readonly scheme: Scheme;
}

/**
 * One provider's readiness as this line draws it.
 *
 * It lives beside the component rather than beside the projection that builds
 * it because every screen that holds one of these holds it to draw it, and a
 * projection is free to change what it reads off the wire without changing
 * what a line is.
 */
export interface ProviderRowView {
  readonly name: string;
  readonly tone: Tone;
  /** The provider and what it is, as one short line: `claude 2.1.259`. */
  readonly words: string;
  /** The machine's own sentence about what is wrong, or `null`. */
  readonly problem: string | null;
}
