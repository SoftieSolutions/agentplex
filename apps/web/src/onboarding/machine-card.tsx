import type { JSX, ReactNode } from 'react';
import { assertNever } from '@agentplex/protocol';
import { ageLabel } from '../sessions/session-list-model.js';
import { Group, Paper, Stack, Text } from '../ui/components.js';
import { ProviderLine } from '../ui/provider-line.js';
import { ToneDot } from '../ui/tone-dot.js';
import { colorForRole, colorForTone, type Scheme, type Tone } from '../ui/tokens.js';
import type { PairProgress } from './pair-progress-model.js';

/**
 * The last thing the wizard says: what became of the machine somebody just
 * paired.
 *
 * The shape is the approved mockup's connected card (turn 7f) -- a bordered
 * card, a tone dot, the machine's name in bold, a muted monospace detail line,
 * then a sentence -- with what the mock put on that detail line taken out. It
 * read `macOS 15.6 · daemon 2.0.3`, and neither fact is on any frame the hub
 * sends: the server reports its stores and what it can start, never what it is
 * running on or which build it is. A first-run reader has no way to check
 * either, which makes this the worst screen in the product to invent one on.
 * What goes there instead is the address this hub dials and how long the
 * connection it now holds has been up, both of which the hub published.
 *
 * Every state is drawn from the progress it is handed and nothing else; there
 * is no state in this file, so a card that has gone stale is a card whose rows
 * have gone stale, which is a problem with one home rather than two. The
 * unhappy states are the reason it is a card at all: a tick would have to be
 * drawn before the dial lands, and a spinner would have to be drawn forever
 * once it fails.
 */

export interface MachineCardProps {
  readonly progress: PairProgress;
  readonly scheme: Scheme;
  /**
   * The clock the connection age is measured against, injected so a test that
   * draws a captured frame gets the same words every time it runs. The default
   * is the real one: this card is drawn per render off rows that arrive per
   * frame, so reading the clock here is reading it as often as anything on
   * screen can change anyway.
   */
  readonly now?: number | undefined;
}

export function MachineCard({ progress, scheme, now = Date.now() }: MachineCardProps): JSX.Element {
  switch (progress.kind) {
    case 'recorded':
      /* No card. The pairing reply carried an id and the state that includes
         the row is a separate broadcast, so there is no machine to draw yet --
         a card with a name and an address on it would be this screen showing
         somebody something the hub has not said. */
      return (
        <Text fz={14} lh={1.6} c={colorForRole('textSecondary', scheme)}>
          Pairing recorded; the hub dials it from here.
        </Text>
      );
    case 'dialling':
      return (
        <CardFrame tone="idle" scheme={scheme} headline={`${progress.label} dialling`}>
          <DetailLine scheme={scheme} text={progress.address} />
          <Sentence scheme={scheme}>
            This hub is reaching for that address now. Nothing has answered yet, so there is nothing
            to say about the machine itself.
          </Sentence>
        </CardFrame>
      );
    case 'online':
      /* The tone comes off the progress and is not chosen here. Two rows read
         as online -- a machine that is connected and one that is draining --
         and a constant in this line drew the second one as healthy under words
         that said it was shutting down. */
      return (
        <CardFrame
          tone={progress.tone}
          scheme={scheme}
          headline={`${progress.label} ${progress.words}`}
        >
          <DetailLine
            scheme={scheme}
            text={detailFor(progress.address, progress.connectedSince, now)}
          />
          <Sentence scheme={scheme}>
            The machine answered. What it reported it has, and what it reported it can start, is
            below.
          </Sentence>
          <Stack gap={4}>
            <Text size="xs" ff="monospace" c="dimmed">
              {storeWords(progress.stores)}
            </Text>
            {progress.providers.length === 0 ? (
              <Text size="xs" ff="monospace" c="dimmed">
                no agents reported
              </Text>
            ) : (
              progress.providers.map((provider) => (
                <ProviderLine key={provider.name} provider={provider} scheme={scheme} />
              ))
            )}
          </Stack>
        </CardFrame>
      );
    case 'unreachable':
      /* The headline is the row's words, not the state's name: a machine that
         announced a shutdown and then closed reads `shut down`, which is the
         whole return on having been warned. `blocked` is the tone of this
         state rather than a second reading of the row -- every row that gets
         here is one. */
      return (
        <CardFrame tone="blocked" scheme={scheme} headline={`${progress.label} ${progress.words}`}>
          <DetailLine scheme={scheme} text={progress.address} />
          {progress.problem !== null && (
            <Text fz={13} lh={1.6} style={{ color: colorForTone('blocked', scheme) }}>
              {progress.problem}
            </Text>
          )}
          {/* No spinner, deliberately. The dial failed and the hub is not
              mid-anything; a spinner here would leave somebody watching a
              screen that is never going to change, which is exactly the
              failure this card was added to stop. */}
          <Sentence scheme={scheme}>{progress.nextAction}</Sentence>
        </CardFrame>
      );
    default:
      return assertNever(progress, 'pair progress');
  }
}

/**
 * The address, and how long the connection now held has been up.
 *
 * The age is words rather than an instant because an instant is a timestamp
 * somebody has to subtract in their head, and it is computed here rather than
 * in the projection because this is where the clock that ticks lives. It says
 * `connected` again after the headline already has: the headline is the state,
 * and `connected 4m` is how long that state has held -- the difference between
 * a machine that is up and one that is flapping, which is the whole reason the
 * hub stamps the instant at all.
 */
function detailFor(address: string, connectedSince: number | null, now: number): string {
  if (connectedSince === null) return address;
  return `${address} · connected ${ageLabel(now, connectedSince)}`;
}

/** The stores that machine had mounted, or the fact that it had none. */
function storeWords(stores: readonly string[]): string {
  if (stores.length === 0) return 'no stores mounted';
  return `${String(stores.length)} ${stores.length === 1 ? 'store' : 'stores'}: ${stores.join(', ')}`;
}

interface CardFrameProps {
  readonly tone: Tone;
  readonly scheme: Scheme;
  readonly headline: string;
  readonly children: ReactNode;
}

/**
 * The card itself: the border, the dot, and the bold line the mockup leads
 * with.
 *
 * The border takes the tone's hue rather than the neutral one every other
 * surface uses, because this card is the wizard's verdict and the verdict is
 * the thing to see from across the room. It is `colorForTone` and never a
 * literal, so the light scheme gets the light scheme's hue.
 */
function CardFrame({ tone, scheme, headline, children }: CardFrameProps): JSX.Element {
  return (
    <Paper
      withBorder
      radius="md"
      p="md"
      maw={520}
      style={{
        background: colorForRole('surfaceAlt', scheme),
        borderColor: colorForTone(tone, scheme),
      }}
    >
      <Stack gap={10}>
        <Group gap={10} align="center" wrap="nowrap">
          <ToneDot tone={tone} scheme={scheme} />
          <Text fz={15} fw={700} c={colorForRole('text', scheme)}>
            {headline}
          </Text>
        </Group>
        {children}
      </Stack>
    </Paper>
  );
}

/** The mockup's muted monospace line under the name: facts, not prose. */
function DetailLine({
  scheme,
  text,
}: {
  readonly scheme: Scheme;
  readonly text: string;
}): JSX.Element {
  return (
    <Text size="xs" ff="monospace" c={colorForRole('textMuted', scheme)}>
      {text}
    </Text>
  );
}

/** The mockup's sentence under the detail line: prose, not facts. */
function Sentence({
  scheme,
  children,
}: {
  readonly scheme: Scheme;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <Text fz={13} lh={1.6} c={colorForRole('textSecondary', scheme)}>
      {children}
    </Text>
  );
}
