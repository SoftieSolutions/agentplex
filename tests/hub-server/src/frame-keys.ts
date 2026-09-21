/**
 * The key names no frame may carry, and the walk that looks for them.
 *
 * Its own file rather than a helper inside one suite, because the rule is
 * about every frame this repository puts on a wire and the frames are produced
 * by whichever suite drives the conversation that produces them. A copy of the
 * walker in each suite would be one rule with several readings, and the one
 * that mattered would be whichever the newest frames happened to land under --
 * which is exactly how the transcript frames were outside the sweep when they
 * were added.
 *
 * The rule itself is `CONTRIBUTING.md`'s: a process handle is meaningless off
 * the machine that owns it, and an argv, an environment or an operation name
 * on a wire is the `{ command }` frame the operation registry exists to
 * prevent. A display string crosses as `text`.
 */
export const FORBIDDEN_FRAME_KEYS = [
  'args',
  'argv',
  'env',
  'command',
  'operation',
  'pid',
  'terminalId',
] as const;

/** Every key anywhere in a frame, however deeply nested. */
export function keysOf(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...keysOf(nested)]);
}

/**
 * Which of the forbidden names this frame carries, anywhere inside it.
 *
 * A list rather than a boolean, so a suite asserting on it fails with the name
 * that was found rather than with "false is not true".
 */
export function forbiddenKeysIn(frame: unknown): readonly string[] {
  const keys = new Set(keysOf(frame));
  return FORBIDDEN_FRAME_KEYS.filter((forbidden) => keys.has(forbidden));
}
