import { describe, expect, it } from 'vitest';
import { markTaskProse, type TaskSegment } from './task-block-model.js';

/**
 * The marker, held to the two promises the block is built on: it never changes
 * a character of what the user typed, and it marks nothing it is not sure
 * about.
 *
 * The second is the harder one to keep, and it is the one these tests spend
 * their cases on. The prose is a person's prompt, so every rule here is up
 * against ordinary English -- `main` is a branch in "open a PR against main"
 * and a word in "keep the main loop responsive", and a marker that took the
 * second for a branch would put a monospace box around a random noun in the
 * middle of a sentence. Missing a branch costs the prose nothing; marking a
 * word costs it the sentence.
 */

/** Everything the segments draw, in order, which must be the prompt itself. */
function drawn(segments: readonly TaskSegment[]): string {
  return segments.map((segment) => segment.text).join('');
}

/** The tokens the marker was sure about. */
function branches(segments: readonly TaskSegment[]): string[] {
  return segments.filter((segment) => segment.branch).map((segment) => segment.text);
}

describe('marking the branch in a task prompt', () => {
  it("marks the branch in the mockup's own prose, and nothing else in it", () => {
    // 7c's TASK block, word for word.
    const prose =
      'Fix the auth refresh race when two tabs refresh at once. ' +
      'Add a regression test and open a PR against main.';

    const segments = markTaskProse(prose);

    expect(branches(segments)).toEqual(['main']);
    expect(drawn(segments)).toBe(prose);
    // The full stop is prose and stays prose: the mark is the branch and not
    // the punctuation that happens to end the sentence it is in.
    expect(segments.at(-1)).toEqual({ text: '.', branch: false });
  });

  it('leaves a prompt with no branch-like token as one run of plain prose', () => {
    const prose = 'Work out why the nightly job takes eleven minutes and write down what you find.';

    expect(markTaskProse(prose)).toEqual([{ text: prose, branch: false }]);
  });

  it('marks a branch named the way branches are named', () => {
    const segments = markTaskProse('Do the work on fix/auth-refresh and leave it there.');

    expect(branches(segments)).toEqual(['fix/auth-refresh']);
  });

  it('marks a default branch name only where a branch is what it can mean', () => {
    // The preposition is doing the work. Nothing else in English is followed
    // by `main` the way "against" and "onto" are.
    expect(branches(markTaskProse('Rebase onto main when the tests pass.'))).toEqual(['main']);
    // Both of them, since both are after a word that can only introduce one.
    expect(branches(markTaskProse('Merge develop into master.'))).toEqual(['develop', 'master']);
  });

  it('leaves a default branch name alone when it is just a word', () => {
    expect(branches(markTaskProse('Keep the main loop responsive under load.'))).toEqual([]);
    expect(branches(markTaskProse('The master copy of the config lives in the repo.'))).toEqual([]);
  });

  it('does not take a path for a branch', () => {
    // A slash is not enough, which is why the prefix has to be one branches
    // are actually named with -- and why a token that ends in a file
    // extension is a file whatever it starts with.
    const segments = markTaskProse('The race is in src/auth/refresh.ts; cover it in test/auth.ts.');

    expect(branches(segments)).toEqual([]);
  });

  it('does not guess at a slashed token nobody can be sure about', () => {
    // `robert/thing` is a branch on half the repositories in the world and a
    // directory on the other half. Unmarked prose is the honest answer.
    expect(branches(markTaskProse('Take it from robert/spike and tidy it up.'))).toEqual([]);
  });

  it('marks the word inside the ticks a user typed, and draws the ticks', () => {
    const segments = markTaskProse('Open a PR against `main`.');

    expect(branches(segments)).toEqual(['main']);
    // Never alters the text: the ticks were typed, so the ticks are drawn.
    expect(drawn(segments)).toBe('Open a PR against `main`.');
  });

  it('gives back exactly what it was given, whatever it was given', () => {
    const prompts = [
      'Fix the auth refresh race. Open a PR against main.',
      'Two  spaces,\na newline, and a trailing space on fix/thing ',
      '   ',
      'no branch here at all',
      'main',
    ];

    for (const prompt of prompts) {
      expect(drawn(markTaskProse(prompt))).toBe(prompt);
    }
  });

  it('has nothing to draw for an empty prompt', () => {
    expect(markTaskProse('')).toEqual([]);
  });
});
