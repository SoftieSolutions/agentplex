// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { shellStyles, SHELL_OVERSCROLL } from './shell-styles.js';

/**
 * The document's one rule, asserted the way the browser will read it: parsed
 * into a real stylesheet and read back off the element it names.
 *
 * A string comparison would pass on a rule with a typo in the property name,
 * which is the failure this is guarding against -- the declaration is a single
 * line nothing else in the app depends on at runtime, so a silent one is a
 * silent regression. What cannot be asserted here is the behaviour: jsdom does
 * not bounce, and neither does desktop Chrome, so whether a PWA on a home
 * screen stops peeling is a claim this repository cannot check and says so
 * rather than implying otherwise.
 */

const sheets: HTMLStyleElement[] = [];

afterEach(() => {
  while (sheets.length > 0) sheets.pop()?.remove();
});

/** Puts the shell's stylesheet in the document, as the head does. */
function applyShellStyles(): void {
  const style = document.createElement('style');
  style.textContent = shellStyles();
  document.head.append(style);
  sheets.push(style);
}

/**
 * What an element with nothing declared on it answers here.
 *
 * A browser answers `auto`, the property's initial value. jsdom carries no
 * initial value for this one and answers the empty string, which is the same
 * statement -- nothing has been said about this element -- in jsdom's words.
 * Named rather than inlined so the two assertions below read as "undeclared"
 * and "declared" rather than as a string nobody can place.
 */
const UNDECLARED = '';

describe('the shell stylesheet', () => {
  it('stops the page bouncing past the ends of itself', () => {
    expect(getComputedStyle(document.documentElement).overscrollBehavior).toBe(UNDECLARED);

    applyShellStyles();

    expect(getComputedStyle(document.documentElement).overscrollBehavior).toBe(SHELL_OVERSCROLL);
  });

  it('says nothing about anything else, because nothing else is the viewport', () => {
    applyShellStyles();

    // Every other surface is a component's, and a rule here would reach past
    // the one thing no component can own.
    expect(getComputedStyle(document.body).overscrollBehavior).toBe(UNDECLARED);
  });
});
