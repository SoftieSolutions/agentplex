/**
 * Every hue the client uses, named once. No color literal appears anywhere
 * else in the app: components speak in semantic tones and roles, the manifest
 * and the icon generator import these names, and lint keeps the component
 * library behind src/ui/. Changing a hue is an edit to this file alone.
 *
 * The palette is the approved mockup direction (design mockups, turn 7): a
 * warm dark scheme as the default and a warm paper light scheme, both with an
 * amber accent. Values are transcribed from the mockup's inline styles; the
 * accent there is oklch(78% 0.16 75), stored here as its sRGB hex because
 * every consumer of this file (the manifest, the PNG icon generator, Mantine
 * color tuples) speaks hex.
 */
export const hues = {
  // Dark scheme, back to front.
  /** Dark app background. Also the manifest's theme and background color. */
  char: '#141311',
  /** Dark floating surface: popovers, menus, dialogs. */
  soot: '#1b1a17',
  /** Dark inset surface: inputs, list chrome, segmented controls. */
  umber: '#1d1c19',
  /** Dark raised surface: the selected item in a menu or list. */
  bark: '#23211c',
  /** Dark strongly raised surface: active segment, avatar circle. */
  walnut: '#2e2b25',
  /** Dark hairline border. */
  seam: '#2a2823',
  /** Dark emphasized border: popovers and anything floating. */
  ridge: '#3a372f',
  /** Dark primary text. */
  bone: '#ece8df',
  /** Dark secondary text. */
  oat: '#c9c4b8',
  /** Dark muted text: placeholders, labels, metadata. */
  stone: '#8a8577',
  /** Dark faint text: the least emphatic copy that must still read. */
  shale: '#6f6a5e',
  /** Dark idle marker: a session with nothing to say. */
  ash: '#4a463f',
  /** Terminal background, darker than any panel so output reads as a well. */
  pitch: '#0f0f0e',
  /** Terminal foreground text. */
  driftwood: '#a7a294',
  /** Dark accent: oklch(78% 0.16 75) from the mockup, converted to sRGB. */
  amber: '#f2a618',
  /** Dark running/success marker. */
  lichen: '#5fd08a',
  /** Dark blocked/error marker. */
  ember: '#e0605a',

  // Light scheme, back to front.
  /** Light app background. */
  parchment: '#f6f4ef',
  /** Light panel background: sidebars, wells. */
  linen: '#f1efe8',
  /** Light card and popover surface. */
  paper: '#ffffff',
  /** Light border. */
  sand: '#e2dfd6',
  /** Light chip and inset surface. */
  dune: '#e9e6dd',
  /** Light primary text. Also the light scheme's terminal surface: the
   * terminal stays dark in both schemes so output never changes character. */
  ink: '#1c1b18',
  /** Light accent: amber deepened to hold contrast on paper. */
  ochre: '#d9950a',
  /** Light link text: the accent darkened further, since ochre itself is too
   * bright for body-copy links on paper. */
  bronze: '#8a5a00',
  /** Light accent wash: the background of a row that needs the user. */
  cream: '#fdf7e8',
  /** Light running/success marker. */
  fir: '#2fa866',
  /** Light blocked/error marker. */
  brick: '#d9463f',
  /** Light idle marker. */
  pumice: '#cfcbc0',
} as const;

export type HueName = keyof typeof hues;

/** The two color schemes. Dark is the default; light must also hold. */
export type Scheme = 'dark' | 'light';

/**
 * What a surface or piece of text is for, independent of scheme. Components
 * and the Mantine theme ask for a role in a scheme; only this file knows
 * which hue answers.
 */
export interface SchemeRoles {
  /** The page itself. */
  background: HueName;
  /** Floating surfaces: popovers, menus, dialogs, cards. */
  surface: HueName;
  /** Inset surfaces: inputs, wells, sidebars. */
  surfaceAlt: HueName;
  /** A surface lifted above its parent: selection, chips. */
  raised: HueName;
  /** Hairline borders. */
  border: HueName;
  /** Borders around floating surfaces. */
  borderStrong: HueName;
  /** Primary text. */
  text: HueName;
  /** Secondary text. */
  textSecondary: HueName;
  /** Muted text: placeholders, labels, metadata. */
  textMuted: HueName;
  /** The least emphatic text that must still read. */
  textFaint: HueName;
  /** The interactive accent. */
  accent: HueName;
  /** Text sitting on the accent. */
  onAccent: HueName;
  /** Link text. */
  link: HueName;
  /** The terminal's surface. Dark in both schemes, by design. */
  terminalBackground: HueName;
  /** The terminal's foreground. */
  terminalText: HueName;
}

export const roles = {
  dark: {
    background: 'char',
    surface: 'soot',
    surfaceAlt: 'umber',
    raised: 'bark',
    border: 'seam',
    borderStrong: 'ridge',
    text: 'bone',
    textSecondary: 'oat',
    textMuted: 'stone',
    textFaint: 'shale',
    accent: 'amber',
    onAccent: 'char',
    link: 'amber',
    terminalBackground: 'pitch',
    terminalText: 'driftwood',
  },
  light: {
    background: 'parchment',
    surface: 'paper',
    surfaceAlt: 'linen',
    raised: 'dune',
    border: 'sand',
    borderStrong: 'sand',
    text: 'ink',
    textSecondary: 'ridge',
    textMuted: 'stone',
    textFaint: 'shale',
    accent: 'ochre',
    onAccent: 'paper',
    link: 'bronze',
    terminalBackground: 'ink',
    terminalText: 'driftwood',
  },
} as const satisfies Record<Scheme, SchemeRoles>;

export type Role = keyof SchemeRoles;

export function colorForRole(role: Role, scheme: Scheme): string {
  return hues[roles[scheme][role]];
}

/**
 * Status is a semantic tone, not a color. Components ask for a tone; only
 * this file knows which hue answers, and the answer depends on the scheme.
 * The vocabulary is the mockup's: a session is running, needs you, blocked,
 * or idle. "Needs you" deliberately shares the accent hue — the thing the app
 * points at is the thing that wants a human.
 */
export type Tone = 'running' | 'needs-you' | 'blocked' | 'idle';

export const toneHues = {
  dark: {
    running: 'lichen',
    'needs-you': 'amber',
    blocked: 'ember',
    idle: 'ash',
  },
  light: {
    running: 'fir',
    'needs-you': 'ochre',
    blocked: 'brick',
    idle: 'pumice',
  },
} as const satisfies Record<Scheme, Record<Tone, HueName>>;

/** Dark is the default scheme, so it is the default here too. */
export function colorForTone(tone: Tone, scheme: Scheme = 'dark'): string {
  return hues[toneHues[scheme][tone]];
}
