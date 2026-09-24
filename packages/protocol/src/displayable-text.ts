/**
 * The one text-cleaning function two modules share, in a file of its own so
 * that neither has to import the other.
 *
 * It was born in `approval.ts`, and its argument for living in this package
 * still stands there: the proposal a person is shown and the rule compared
 * against it must be cleaned by one function. What moved it out is a cycle.
 * `route-condition.ts` cleans a condition's text with it, `graph.ts` parses a
 * condition, and once an approval could be about a graph run `approval.ts`
 * imported `graph.ts` -- a loop that loaded `graph.ts` before the schemas it
 * needed existed. A module with one function and no imports is the smallest
 * thing that breaks it.
 */

/**
 * Text an agent wrote, with the parts of it that are not text removed.
 *
 * It lives here rather than beside the provider that first needed it because
 * two things now depend on it agreeing with itself: the proposal a person is
 * shown, and the standing policy's rule that is compared against that proposal.
 * A second copy of this function at the edge would be a second alphabet, and
 * the day the two drifted apart would be the day a rule matched something a
 * person would have read differently. One function, in the package both ends
 * already agree on.
 *
 * Two classes, removed together because they are the same claim. A tool input
 * can carry an escape sequence -- a `Bash` command that clears the screen, a
 * file with a bell in it -- and a proposal is rendered wherever an approval is
 * shown, including a log an operator is reading in a terminal. Tabs and
 * newlines survive because they are layout; the rest are removed rather than
 * escaped, because a person deciding on a command is not helped by seeing
 * `\u001b` and a person is who this string is for.
 *
 * The bidirectional controls are the ones that cost something to see. Every
 * string this function guards is written by the agent that is asking, drawn
 * directly above the button that answers, and a right-to-left override in it
 * makes the line render in an order other than the one that runs: `rm -rf /x`
 * with a comment after it can be painted as a comment with a harmless-looking
 * command after that. Nothing downstream can undo it either -- by the time the
 * text is a DOM node the reordering is the browser doing its job correctly, and
 * `dir` on the element bounds the damage without removing it. So the marks, the
 * embeddings, the overrides, the pop and the isolates all go here, at the edge,
 * where the text stops being the provider's and starts being something a person
 * is asked to read.
 */
export function displayableApprovalText(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- the point is the control characters.
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
      .replace(/[؜‎‏‪-‮⁦-⁩]/g, '')
  );
}
