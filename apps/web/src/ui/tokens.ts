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
  /** Dark paused marker: a session set down on purpose, alive and waiting. */
  slate: '#7d93b8',
  /** Dark mock tag: the chip on anything drawn from sample data. */
  lilac: '#b8a1d9',
  /** Dark inset border: the hairline around the onboarding wells (mock 7f). */
  slag: '#26251f',
  /** Dark inset well: the command box and the connected card (mock 7f). */
  tar: '#181815',
  /** Dark inset row: a row set inside a well, one step darker still (mock 7f). */
  void: '#121210',

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
  /** Light running word: fir darkened until it reads as text on paper. */
  moss: '#1f7a49',
  /** Light blocked word: brick darkened until it reads as text on paper. */
  rust: '#b8322c',
  /** Light paused marker. */
  denim: '#4a6fa5',
  /** Light idle marker. */
  pumice: '#cfcbc0',
  /** Light mock tag: lilac deepened to carry white text on paper. */
  plum: '#5e3f8a',

  // Both schemes.
  /** What every shadow is cast in; only ever drawn with an alpha byte. */
  umbra: '#000000',
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
  /** The wash behind every match a find in the pane turned up. */
  terminalMatch: HueName;
  /** The wash behind the one match the find bar is standing on. */
  terminalMatchActive: HueName;
  /**
   * The chip on anything drawn from sample data rather than from the hub.
   * A purple no status tone uses, so the tag is never read as a session
   * state: the five tones already take green, amber, red, grey and blue.
   */
  mockTag: HueName;
  /** The word on the mock tag. */
  onMockTag: HueName;
  /**
   * The brand mark's square. Not the accent in light: mock 7b draws an ink
   * square with the dark scheme's amber letter, because ochre on paper is a
   * pale chip where the mark should be the heaviest thing in the bar.
   */
  brand: HueName;
  /** The letter on the brand mark. */
  onBrand: HueName;
  /**
   * The one primary action in the chrome (New). Ink in light, as mock 7b
   * draws it, for the reason the mark is: white on ochre is 2.5:1.
   */
  primaryButton: HueName;
  /** The word on the primary action. */
  onPrimaryButton: HueName;
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
    terminalMatch: 'walnut',
    terminalMatchActive: 'ridge',
    mockTag: 'lilac',
    onMockTag: 'char',
    brand: 'amber',
    onBrand: 'char',
    primaryButton: 'amber',
    onPrimaryButton: 'char',
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
    // The same two hues as the dark scheme, for the same reason
    // `terminalText` is: the terminal well is dark in both schemes, so a
    // highlight that followed the page would paint a light block behind
    // driftwood text on paper and make the match the one thing unreadable.
    terminalMatch: 'walnut',
    terminalMatchActive: 'ridge',
    mockTag: 'plum',
    onMockTag: 'paper',
    brand: 'ink',
    onBrand: 'amber',
    primaryButton: 'ink',
    onPrimaryButton: 'paper',
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
 *
 * The fifth tone is `paused`: a session somebody set down on purpose, whose
 * process is alive and whose keyboard is withheld until they pick it up. It
 * is neither idle (nothing is wrong and nothing is missing) nor needs-you
 * (nobody is waiting on a person), so it gets a cool hue of its own rather
 * than borrowing one and being misread as either.
 */
export type Tone = 'running' | 'needs-you' | 'blocked' | 'idle' | 'paused';

export const toneHues = {
  dark: {
    running: 'lichen',
    'needs-you': 'amber',
    blocked: 'ember',
    idle: 'ash',
    paused: 'slate',
  },
  light: {
    running: 'fir',
    'needs-you': 'ochre',
    blocked: 'brick',
    idle: 'pumice',
    paused: 'denim',
  },
} as const satisfies Record<Scheme, Record<Tone, HueName>>;

/**
 * The scheme is required, with no default, since the app grew a control that
 * switches it (Settings, Appearance). A default here would be a call site
 * that keeps painting a dark-scheme marker on paper, and the only thing that
 * would notice is a person reading an unreadable dot.
 */
export function colorForTone(tone: Tone, scheme: Scheme): string {
  return hues[toneHues[scheme][tone]];
}

/**
 * The hue a tone is written in, as opposed to the dot it is drawn as.
 *
 * Two maps because a dot and a word are held to different floors. A 7px dot
 * is a mark beside its label and reads at the hue's own weight; a word has to
 * clear WCAG AA (4.5:1) on the surface it sits on. In dark every dot hue
 * already does, so the word is the dot. In light the running and blocked dots
 * (fir 3.0:1, brick 4.3:1 on paper) do not, and the mock writes those words
 * in the darker moss and rust; needs-you is bronze, the hue the link already
 * uses, since ochre is 2.5:1.
 *
 * Idle is the exception, on the mock's own terms: it writes an idle word in
 * stone, the muted text hue, which is 3.7:1 on paper. An idle word is
 * secondary text that says nothing is happening, and the test holds it to the
 * 3:1 floor rather than inventing a darker hue the mock never drew.
 */
export const toneTextHues = {
  dark: {
    running: 'lichen',
    'needs-you': 'amber',
    blocked: 'ember',
    idle: 'stone',
    paused: 'slate',
  },
  light: {
    running: 'moss',
    'needs-you': 'bronze',
    blocked: 'rust',
    idle: 'stone',
    paused: 'denim',
  },
} as const satisfies Record<Scheme, Record<Tone, HueName>>;

/** The hue a tone's word is written in; see `toneTextHues`. */
export function colorForToneText(tone: Tone, scheme: Scheme): string {
  return hues[toneTextHues[scheme][tone]];
}

/**
 * A named hue with an alpha byte, as the 8-digit hex the mock writes
 * (`#5fd08a22`).
 *
 * A byte and not a fraction, so a value transcribes from the mock exactly:
 * the running ring's `22` is 34/255, which no two-decimal fraction rounds
 * back to. Refused outside 0-255 or off the integers, since CSS drops a colour
 * it cannot parse and the shadow or border would vanish without a word.
 */
export function translucent(hue: HueName, alpha: number): string {
  if (!Number.isInteger(alpha) || alpha < 0 || alpha > 0xff) {
    throw new RangeError(`alpha ${alpha} is not a byte`);
  }
  return `${hues[hue]}${alpha.toString(16).padStart(2, '0')}`;
}

/** Every shadow the mocks draw, by what it is on. */
export interface SchemeShadows {
  /** Popovers and menus (7a, 7b). Mantine's `shadow="md"` resolves to it. */
  readonly popover: string;
  /** The phone's floating action button (7e). */
  readonly fab: string;
  /** A raised segment or selected row on a light inset (7b, 7d). */
  readonly raised: string;
  /** The halo around a card that needs the user (6a, 7b). */
  readonly needsYouRing: string;
  /** The same halo on a graph node, one pixel wider (6d). */
  readonly needsYouNodeRing: string;
  /** The halo around an executing graph node (6d). */
  readonly runningRing: string;
  /** A control held open, such as the New button with its menu up (7a). */
  readonly focusRing: string;
  /** A connection that just came up, lit (7f). */
  readonly glow: string;
}

/**
 * Transcribed from the mocks. Where a mock draws only one scheme, the other
 * takes the same geometry in its own hues rather than a guess at a new one.
 */
export const shadows: Record<Scheme, SchemeShadows> = {
  dark: {
    popover: `0 12px 32px ${translucent('umbra', 0x80)}`,
    fab: `0 8px 24px ${translucent('umbra', 0x80)}, 0 0 0 1px ${hues[roles.dark.background]}`,
    raised: 'none',
    needsYouRing: `0 0 0 3px ${translucent(toneHues.dark['needs-you'], 0x1f)}`,
    needsYouNodeRing: `0 0 0 4px ${translucent(toneHues.dark['needs-you'], 0x1f)}`,
    runningRing: `0 0 0 4px ${translucent(toneHues.dark.running, 0x22)}`,
    focusRing: `0 0 0 3px ${translucent(roles.dark.accent, 0x40)}`,
    glow: `0 0 8px ${hues[toneHues.dark.running]}`,
  },
  light: {
    popover: `0 12px 32px ${translucent('umbra', 0x22)}`,
    fab: `0 8px 24px ${translucent('umbra', 0x33)}`,
    raised: `0 1px 2px ${translucent('umbra', 0x0f)}`,
    needsYouRing: `0 0 0 3px ${translucent(toneHues.light['needs-you'], 0x1f)}`,
    needsYouNodeRing: `0 0 0 4px ${translucent(toneHues.light['needs-you'], 0x1f)}`,
    runningRing: `0 0 0 4px ${translucent(toneHues.light.running, 0x22)}`,
    focusRing: `0 0 0 3px ${translucent(roles.light.accent, 0x40)}`,
    glow: `0 0 8px ${hues[toneHues.light.running]}`,
  },
};

/** The border a card wears for what it is saying. */
export interface CardBorders {
  readonly blocked: string;
  readonly needsYou: string;
  /** The card of the session the footer is reporting on. */
  readonly focused: string;
  /** A machine that has just connected, in the onboarding card (7f). */
  readonly connected: string;
}

/**
 * The mocks draw a card's state in its border at partial strength in dark,
 * where a full-strength hue on soot would outshout the dot, and mostly solid
 * in light, where it would not (7a, 7b, 7e, 7f).
 */
export const cardBorders: Record<Scheme, CardBorders> = {
  dark: {
    blocked: translucent(toneHues.dark.blocked, 0x99),
    needsYou: translucent(toneHues.dark['needs-you'], 0x99),
    focused: translucent(roles.dark.text, 0x55),
    connected: translucent(toneHues.dark.running, 0x66),
  },
  light: {
    blocked: translucent(toneHues.light.blocked, 0x88),
    needsYou: hues[toneHues.light['needs-you']],
    focused: hues[roles.light.text],
    connected: translucent(toneHues.light.running, 0x66),
  },
};

/**
 * The onboarding column's insets (mock 7f): a well a step darker than the
 * page, a row inside it darker again, and the hairline around both. The light
 * scheme answers with the panel hues it already has.
 */
export const insets = {
  dark: { well: 'tar', row: 'void', border: 'slag' },
  light: { well: 'linen', row: 'parchment', border: 'sand' },
} as const satisfies Record<Scheme, Record<'well' | 'row' | 'border', HueName>>;
