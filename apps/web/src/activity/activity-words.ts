import { assertNever, type Activity } from '@agentplex/protocol';

/**
 * What an activity says, as three slots a renderer fills.
 *
 * The split is not cosmetic. `quoted` is the provider's own string -- a
 * command line or a file path -- and it is the only part of an activity this
 * app did not write: it is drawn in the monospace face and forced to
 * left-to-right, because a path or a command reordered by the surrounding
 * text's direction reads as a different path or a different command. `lead`
 * and `detail` are this app's words about it, and they are prose.
 *
 * Three slots rather than one finished string because the collapsed form and
 * the full form differ in how they are laid out and never in what they say:
 * one line that truncates, or a paragraph that wraps. A model that returned
 * markup would have to know which, and a model that returned one flat string
 * would give the command and the sentence about it the same face.
 */
export interface ActivityWords {
  /** This app's words before the quoted string, or `null` when it has none. */
  readonly lead: string | null;
  /** The provider's own string: monospace, `dir="ltr"`, never interpreted. */
  readonly quoted: string | null;
  /** This app's words after it, or `null`. */
  readonly detail: string | null;
}

/**
 * How a command ended, in words.
 *
 * A bare number is not an outcome anybody reads, and a colour alone is not
 * one anybody can read on a monochrome display or with a colour deficiency,
 * so the failure is said. Zero says nothing: a command that finished the way
 * commands finish is not news on a card that has one line to spend, and the
 * words it would cost are the words the next failure needs to stand out with.
 *
 * Absent is a third thing again -- still running, or killed by a signal that
 * left no status -- and it is also silence, because the alternative is this
 * app guessing between the two.
 */
function exitStatusWords(exitStatus: number | undefined): string | null {
  if (exitStatus === undefined || exitStatus === 0) return null;
  return `failed with exit status ${String(exitStatus)}`;
}

/**
 * How much of a file moved, when the adapter counted.
 *
 * Each count is said only if it arrived. A missing count is not a zero --
 * "the transcript did not say" and "nothing moved" are different claims, and
 * the schema keeps them apart by leaving the field off, so the words do too.
 */
function editCountWords(added: number | undefined, removed: number | undefined): string | null {
  const counts: string[] = [];
  if (added !== undefined) counts.push(`${String(added)} added`);
  if (removed !== undefined) counts.push(`${String(removed)} removed`);
  return counts.length === 0 ? null : counts.join(', ');
}

/**
 * A test run, as the counts it has so far.
 *
 * A run that has reported neither count is still a real moment -- the kind
 * alone says tests are running -- so it says that rather than drawing an
 * empty line. Neither count is invented: a run that has said how many passed
 * and not yet how many failed says only the first, because "0 failed" is the
 * claim a green run makes and this one has not made it.
 */
function testCountWords(passed: number | undefined, failed: number | undefined): string {
  const counts: string[] = [];
  if (passed !== undefined) counts.push(`${String(passed)} passed`);
  if (failed !== undefined) counts.push(`${String(failed)} failed`);
  return counts.length === 0 ? 'running tests' : counts.join(', ');
}

/**
 * The one switch over the activity vocabulary in this app.
 *
 * It ends in `assertNever`, so a seventh kind on the wire is a compile error
 * here rather than a card that silently draws nothing. Everything else in the
 * web app -- the collapsed line on a card, the full form on the session
 * screen, the string the session filter matches -- reads these three slots and
 * never the `kind`, which is what keeps one vocabulary from being worded three
 * slightly different ways.
 *
 * Four of the six kinds are emitted by no adapter today: the captured
 * transcripts redact the tool input a file edit, a test run and an agent's own
 * words would come from, and neither provider writes an approval to disk at
 * all (AGX-263 re-captures fixtures with tool inputs). They are rendered and
 * tested here anyway, because the wire vocabulary is the ticket's unit and a
 * renderer that grew a case per adapter release would be a renderer that has
 * to ship before the fixture it was waiting for can be used.
 */
export function activityWords(activity: Activity): ActivityWords {
  switch (activity.kind) {
    case 'command':
      return { lead: null, quoted: activity.text, detail: exitStatusWords(activity.exitStatus) };
    case 'edit':
      return {
        lead: 'editing',
        quoted: activity.path,
        detail: editCountWords(activity.added, activity.removed),
      };
    case 'tests':
      return { lead: testCountWords(activity.passed, activity.failed), quoted: null, detail: null };
    case 'narration':
    case 'approval':
    case 'plain':
      return { lead: activity.text, quoted: null, detail: null };
    default:
      return assertNever(activity, 'session activity');
  }
}

/**
 * The activity as one flat string: what a search over the session list
 * matches.
 *
 * Off the same words the widget draws rather than off the union's fields, so
 * that what somebody reads on a card is what typing it into the box finds. A
 * second walk over the kinds for the filter's benefit would be a second chance
 * to spell "editing" one way here and another way there.
 */
export function activityWordsText(activity: Activity): string {
  const words = activityWords(activity);
  return [words.lead, words.quoted, words.detail].filter((part) => part !== null).join(' ');
}
