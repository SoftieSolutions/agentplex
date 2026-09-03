/**
 * Every hue the client uses, named once. No color literal appears anywhere
 * else in the app: components speak in semantic tones, the manifest and the
 * icon generator import these names, and lint keeps the component library
 * behind src/ui/. Changing a hue is an edit to this file alone.
 */
export const hues = {
  /** App background. Also the manifest's theme and background color. */
  midnight: '#101113',
  /** Raised surface: cards, panes, headers. */
  slate: '#1a1b1e',
  /** Primary text on dark surfaces. */
  fog: '#c9cacd',
  /** Muted text, borders, anything idle. */
  ash: '#5c5f66',
  /** Interactive accent. */
  signal: '#4dabf7',
  /** A session running normally. */
  lichen: '#40c057',
  /** A session waiting on a human. */
  amber: '#fab005',
  /** A session that failed. */
  ember: '#fa5252',
} as const;

export type HueName = keyof typeof hues;

/**
 * Status is a semantic tone, not a color. Components ask for a tone; only
 * this file knows which hue answers.
 */
export type Tone = 'idle' | 'running' | 'attention' | 'error';

export const toneHues = {
  idle: 'ash',
  running: 'lichen',
  attention: 'amber',
  error: 'ember',
} as const satisfies Record<Tone, HueName>;

export function colorForTone(tone: Tone): string {
  return hues[toneHues[tone]];
}
