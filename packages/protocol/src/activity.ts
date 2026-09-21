import { z } from 'zod';

/**
 * What a session is doing right now, in the one vocabulary every provider is
 * reduced to -- the sentence a card shows under a session's name and the
 * session screen shows in full.
 *
 * This is parsed session state and never terminal bytes. An adapter reads a
 * provider's own transcript, which is structured, and hands up one of these;
 * nothing here is scraped off a pane, and nothing downstream re-reads a
 * provider's vocabulary. That is the same split `SessionStatus` makes, one
 * level finer: a status says whether somebody is wanted, an activity says what
 * the agent is up to.
 *
 * The set is closed, and small, for the reason the status set is: a client
 * renders each kind differently -- a monospace line for a command, a path and
 * two counts for an edit -- and a switch over an open set has a bottom nobody
 * wrote. `plain` is the escape hatch *inside* the set: an adapter that has a
 * line of text and no idea what it is says so, and the client draws it as a
 * line rather than as a claim about a command that ran.
 *
 * What is deliberately not here is anything executable and anything large. No
 * field names an operation, an argv element or an environment variable -- a
 * command crosses as `text`, a display string with no path back to a spawn,
 * which is why the field is not called `command`. And no field carries file
 * contents or a diff hunk: this rides on the descriptor of every session in a
 * store, re-sent on every scan, so what it may carry is a label and a handful
 * of small numbers. The whole transcript is a separate, bounded request.
 */

/**
 * How long a display string on an activity may be.
 *
 * The bound exists because of where this rides. A store report carries every
 * session in the store and is sent again every couple of seconds, so an
 * unbounded line in one session's activity is a cost the whole fleet pays
 * forever. Two hundred is the same answer `NODE_NAME_MAX_CHARS` gives to the
 * same question, and it is well past what a card's one collapsed line can
 * show: the client is already eliding, and what it elides is a prefix of the
 * truth rather than a string somebody's transcript made arbitrarily long.
 *
 * An adapter with more text than this truncates it before it sends, because
 * the alternative is refusing the frame that carries every other session in
 * the store.
 */
export const ACTIVITY_TEXT_MAX_CHARS = 200;

/**
 * How long a path label on an activity may be.
 *
 * Its own constant rather than a reuse of the text bound, because it answers a
 * different question -- how deep a checkout goes, not how much an agent says
 * -- and the day one of them moves it should not drag the other with it. It is
 * a label and never a path anything opens: nothing sends it back, and no read
 * on any machine takes a path off a frame.
 */
export const ACTIVITY_PATH_MAX_CHARS = 200;

/**
 * Whitespace a transcript records inside one logical line: the tab, and the
 * line and page breaks. These become a single space rather than vanishing, so
 * `editing\tsrc/a.ts` does not collapse into one word.
 */
function isLineWhitespace(code: number): boolean {
  return code === 0x09 || (code >= 0x0a && code <= 0x0d);
}

/**
 * Everything else that is a control character or a bidi format character.
 *
 * The rest of C0, DEL, the C1 range -- which is where an escape sequence's
 * introducer lives in its one-byte form -- and the bidi marks and embeddings:
 * LRM, RLM, ALM, the U+202A..U+202E embeddings and overrides, and the
 * U+2066..U+2069 isolates.
 *
 * A predicate over code points rather than a character class, because a
 * regular expression that names these characters is one `no-control-regex`
 * objects to and one nobody can read at a glance -- the ranges are the
 * argument here, and this way they are written as ranges.
 */
function isControlOrBidi(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** Runs of spaces left behind once the characters above are gone. */
const SPACE_RUN = / {2,}/gu;

/**
 * The display form of a string an adapter read out of a provider's transcript.
 *
 * Stripped rather than refused, and the direction is the point. A transcript
 * is somebody else's file: it carries tabs, wrapped lines, and whatever a tool
 * echoed into it, and a schema that refused those would throw away the store
 * report that carries every other session rather than lose a tab. So the
 * characters that cannot be drawn come out, and what is left is a line.
 *
 * The bidi characters come out for a second reason. A right-to-left override
 * reorders everything after it, so a command displayed through one can read as
 * a different command than the one that ran -- the trick that makes
 * `txt.exe` look like `exe.txt`. On a screen whose whole job is telling
 * somebody what an agent did, a string that renders as something other than
 * itself is the one failure worth spending a regex on.
 *
 * Idempotent, because an activity is parsed again at every hop it crosses and
 * a normalisation that moved on the second pass would mean the hub and the
 * client disagree about what the server said.
 */
export function displayableActivityText(raw: string): string {
  let drawable = '';
  for (const character of raw) {
    const code = character.codePointAt(0) ?? 0;
    if (isLineWhitespace(code)) drawable += ' ';
    else if (!isControlOrBidi(code)) drawable += character;
  }
  return drawable.replace(SPACE_RUN, ' ').trim();
}

/**
 * A display string on an activity: bounded on the wire, stripped to what can
 * be drawn, and refused when nothing survives.
 *
 * The bound is checked against what arrived, so the frame's size is bounded by
 * what was sent rather than by what is left after stripping. The emptiness
 * check is after, because a string of nothing but control characters and one
 * that was empty to begin with are the same thing to draw: nothing. An
 * activity is a claim that something happened, so an activity with nothing to
 * show is refused and the adapter sends no activity at all -- which is what
 * the descriptor's absent field already means.
 */
const activityTextSchema = z
  .string()
  .max(ACTIVITY_TEXT_MAX_CHARS)
  .transform(displayableActivityText)
  .pipe(z.string().min(1));

/** The same, for the one path label the vocabulary carries. */
const activityPathSchema = z
  .string()
  .max(ACTIVITY_PATH_MAX_CHARS)
  .transform(displayableActivityText)
  .pipe(z.string().min(1));

/**
 * A line count on an activity, when the adapter has one.
 *
 * Optional and never defaulted, for the reason `usage` is optional on a
 * descriptor: a zero here says the agent touched a file and moved no lines,
 * and "the transcript did not say" has to draw as a missing number instead.
 */
const activityCountSchema = z.int().nonnegative();

/**
 * Every variant is a strict object, so an unknown key is a refusal rather than
 * a field that is silently dropped.
 *
 * That is what holds the rule this union is most exposed to. `tests/hub-server`
 * walks every frame in all four directions and fails on a key named `args`,
 * `argv`, `env`, `command`, `operation`, `pid` or `terminalId`; a strict object
 * refuses one at the parser instead, on the peer that sent it, rather than
 * quietly accepting a frame that a stricter reader would reject. It is also
 * what keeps one variant's fields off another: `{ kind: 'plain', path }` is a
 * client guessing at a shape, and guessing is the thing a parser exists to
 * say no to.
 */
export const activitySchema = z.discriminatedUnion('kind', [
  /**
   * A command the agent ran, as the provider's own record of it reads.
   *
   * `text` and not `command`, and the name is not cosmetic. A frame that
   * carries a field called `command` is the generic execution surface the
   * operation registry exists to prevent, whatever the code around it happens
   * to do with it today. This is a display string: nothing sends it back,
   * nothing spawns from it, and the integration suite fails the build if the
   * key ever comes back.
   */
  z.strictObject({
    kind: z.literal('command'),
    text: activityTextSchema,
    /**
     * How the command ended, or absent while it is still running -- and absent
     * too for one killed by a signal, which has no exit status to report.
     *
     * Bounded to a byte because that is what a wait status holds. A number
     * outside it did not come from a process ending.
     */
    exitStatus: z.int().min(0).max(255).optional(),
  }),
  /**
   * A file the agent edited: which file, and how much of it moved.
   *
   * The path only. A diff hunk is file contents, and file contents on a frame
   * that rides every scan is a different protocol with a different bound; the
   * session screen that wants one asks for it.
   */
  z.strictObject({
    kind: z.literal('edit'),
    path: activityPathSchema,
    added: activityCountSchema.optional(),
    removed: activityCountSchema.optional(),
  }),
  /**
   * A test run, as counts.
   *
   * Both counts optional and optional apart: a run that has said how many
   * passed and not yet how many failed is a real moment, and the kind alone
   * already says tests are running. Neither defaults to zero, because zero
   * failures is the claim a green run makes.
   */
  z.strictObject({
    kind: z.literal('tests'),
    passed: activityCountSchema.optional(),
    failed: activityCountSchema.optional(),
  }),
  /** What the agent said it is doing, in its own words. */
  z.strictObject({ kind: z.literal('narration'), text: activityTextSchema }),
  /**
   * What the agent is waiting for permission to do.
   *
   * The text of the request and nothing actionable: answering an approval is
   * its own frame with its own identity, not a string echoed back from here.
   */
  z.strictObject({ kind: z.literal('approval'), text: activityTextSchema }),
  /**
   * A line the adapter has and cannot classify.
   *
   * The honest bottom of the set, and the reason the other five may stay
   * narrow. A client draws this as a line and claims nothing about it. It is
   * not what an adapter sends when it found no activity at all -- that is an
   * absent field, and the difference is between "here is what it said" and
   * "there is nothing to show".
   */
  z.strictObject({ kind: z.literal('plain'), text: activityTextSchema }),
]);

/**
 * One activity, whole.
 *
 * A discriminated union and not a record with optional fields, so a renderer
 * switches on `kind` and ends in `assertNever`: the day a seventh kind is
 * added, every switch that has not grown a case fails to compile rather than
 * drawing nothing.
 */
export type Activity = z.infer<typeof activitySchema>;

/** The discriminator's own type, for a client that keys a table by kind. */
export type ActivityKind = Activity['kind'];
