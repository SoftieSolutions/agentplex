import type { JSX } from 'react';
import { colorForTone, type Scheme, type Tone } from './tokens.js';

/**
 * The mockup's status dot: 7px, round, colored by tone and nothing else.
 *
 * It sits here rather than in any one screen that draws it. The settings
 * screen and the pairing panel had a copy each, and the panel could not import
 * the screen's: the wizard draws the panel too, so that import would drag the
 * whole settings screen behind a first-run step for ten lines of markup. The
 * chrome's connection line is a third caller, and the pane picker a fourth.
 * Beside `colorForTone` is the one place all of them can reach, and it is
 * where the dot belongs anyway — it is that function plus a circle.
 *
 * Marked `aria-hidden`: the tone is a second rendering of words that are
 * always beside it, and a screen reader announcing an unlabelled dot before
 * them adds nothing. Every caller says in words what the dot says in colour,
 * which is the rule that makes hiding it safe.
 */
export function ToneDot({ tone, scheme, live = false }: ToneDotProps): JSX.Element {
  return (
    <>
      {live && <PulseRule />}
      <span
        aria-hidden
        className={live ? PULSE : undefined}
        // Presence is the fact, so a test asks `hasAttribute` rather than
        // parsing a class list, and nothing draws off it.
        data-live={live ? '' : undefined}
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: colorForTone(tone, scheme),
          flex: 'none',
        }}
      />
    </>
  );
}

export interface ToneDotProps {
  readonly tone: Tone;
  readonly scheme: Scheme;
  /**
   * Whether this dot stands for something happening right now, in which case
   * it breathes rather than sits there.
   *
   * Off by default, and deliberately not derived from the tone: `running` is
   * the tone of a session that is working and also of a copy that succeeded,
   * and a chip that pulsed for the second one would be animating a fact that
   * has already finished. The caller knows which it has.
   */
  readonly live?: boolean;
}

/** The class the animation is named by, and the one name it has. */
const PULSE = 'agx-pulse';

/**
 * The keyframes behind a live dot, published once however many dots ask.
 *
 * A rule and not an inline `animation`, for the media query underneath it: an
 * inline style is the last word in the cascade, so a dot that animated itself
 * could not be told to stop by `prefers-reduced-motion` without `!important`.
 * An indicator that pulses forever is exactly what that preference is set to
 * silence, and the colour says the same thing standing still.
 *
 * `href` and `precedence` are what make this one rule rather than one per dot:
 * React hoists such a style into the head and keeps a single copy keyed by the
 * href, so a list of twelve working sessions emits it once. It lives here
 * beside the only thing that uses it rather than in a stylesheet the app does
 * not otherwise have -- every other rule in this client is drawn by a
 * component, and this one is drawn by this component.
 */
function PulseRule(): JSX.Element {
  return (
    <style href={PULSE} precedence="low">
      {`@keyframes ${PULSE}{0%,100%{opacity:1}50%{opacity:.35}}` +
        `.${PULSE}{animation:${PULSE} 1.4s ease-in-out infinite}` +
        `@media(prefers-reduced-motion:reduce){.${PULSE}{animation:none}}`}
    </style>
  );
}
