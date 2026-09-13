import { TERMINAL_INPUT_MAX_CHARS } from '@agentplex/protocol';

/**
 * Cutting input into pieces the protocol will accept, in order.
 *
 * A keystroke is never near the cap and a paste routinely is: the frame takes
 * `TERMINAL_INPUT_MAX_CHARS` characters and a pasted file is however long the
 * file is. The protocol says outright that anything longer goes as more than
 * one frame, and it is right that it is the client's job -- the far end is a
 * pty, which has no notion of a message boundary at all. Two frames of half a
 * paste each arrive at the process as one stream of bytes, which is what the
 * process was always going to see.
 *
 * So this is the one place a size limit turns into frames, and the pane runs
 * everything the emulator produces through it rather than only pastes. A rule
 * that applied to the paste path alone would be a rule that the day somebody
 * sends input from somewhere else it silently stops applying.
 *
 * Order is the whole of the contract. Bracketed paste makes that concrete: the
 * `ESC[200~` that opens a paste is in the first piece and the `ESC[201~` that
 * closes it is in the last, and a pty handed them out of order is a pty handed
 * a paste that never ends.
 */

/** Whether a UTF-16 unit is the leading half of a surrogate pair. */
function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

/**
 * Input as frames, oldest first. An empty string is no frames at all: there is
 * nothing to tell the far end, and a frame carrying nothing would still count
 * against a discard the user would then be shown a sentence about.
 *
 * The cap is counted in UTF-16 code units, because that is what the schema's
 * `max` counts, and a cut is never made between the halves of a surrogate
 * pair. Splitting one would put a lone surrogate on the wire: unpaired
 * surrogates are not encodable as UTF-8, so what reaches the process would be
 * two replacement characters where the user pasted one emoji. Backing the cut
 * up by a single unit costs one character off one frame and is the difference
 * between the paste arriving and the paste arriving corrupted.
 */
export function chunkTerminalInput(data: string): readonly string[] {
  if (data.length === 0) return [];
  if (data.length <= TERMINAL_INPUT_MAX_CHARS) return [data];

  const pieces: string[] = [];
  let start = 0;
  while (start < data.length) {
    let end = Math.min(start + TERMINAL_INPUT_MAX_CHARS, data.length);
    if (end < data.length && isHighSurrogate(data.charCodeAt(end - 1))) end -= 1;
    pieces.push(data.slice(start, end));
    start = end;
  }
  return pieces;
}
