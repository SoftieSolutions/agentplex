/**
 * What a test outside this package shares with the tests inside it: the one
 * table of pins, so `install.sh`'s suite and this package's suite read the same
 * rows.
 */
export { PIN_GRAMMAR_CASES, SERIES_RESOLUTION_CASES } from './pin-cases.js';
export type { PinGrammarCase, PinKind, SeriesResolutionCase } from './pin-cases.js';
