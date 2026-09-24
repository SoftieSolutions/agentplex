import { describe, expect, it } from 'vitest';
import {
  ROUTE_CONDITION_MAX_CHARS,
  ROUTE_GLOB_MAX_WILDCARDS,
  ROUTE_INPUT_MAX_CHARS,
  evaluateRouteCondition,
  parseRouteCondition,
  routeConditionTextSchema,
  routeInputSchema,
  type RouteCondition,
  type RouteInput,
} from './route-condition.js';

function condition(text: string) {
  const parsed = parseRouteCondition(text);
  if (!parsed.ok) throw new Error(`${text} did not parse: ${parsed.problem}`);
  return parsed.condition;
}

function input(value: unknown): RouteInput {
  return routeInputSchema.parse(value);
}

describe('parseRouteCondition', () => {
  it('reads the three forms and nothing else', () => {
    expect(parseRouteCondition('language == rust')).toEqual({
      ok: true,
      condition: { kind: 'equals', field: 'language', literal: 'rust' },
    });
    expect(parseRouteCondition('pr.author != bot')).toEqual({
      ok: true,
      condition: { kind: 'not-equals', field: 'pr.author', literal: 'bot' },
    });
    expect(parseRouteCondition('only docs/**/*.md')).toEqual({
      ok: true,
      condition: { kind: 'only', glob: 'docs/**/*.md' },
    });
  });

  it('takes a quoted literal, so a value with a space or a quote in it can be named', () => {
    expect(condition('title == "fix auth"')).toEqual({
      kind: 'equals',
      field: 'title',
      literal: 'fix auth',
    });
    expect(condition('title == "say \\"hi\\""')).toEqual({
      kind: 'equals',
      field: 'title',
      literal: 'say "hi"',
    });
  });

  it('is indifferent to the spaces around the operator and the ends', () => {
    expect(condition('  language==rust  ')).toEqual(condition('language == rust'));
    expect(condition('only\t*.ts')).toEqual({ kind: 'only', glob: '*.ts' });
  });

  it.each([
    ['nothing at all', '', 0, 'field'],
    ['a field with no operator', 'language', 8, '==|!='],
    ['an operator this grammar has not got', 'language < 3', 9, '==|!='],
    ['an operator with no literal', 'language ==', 11, 'literal'],
    ['a literal that never closes', 'language == "rust', 12, 'quote'],
    ['a field that starts with a digit', '3rd == x', 0, 'field'],
    ['a second clause', 'a == b and c == d', 7, 'end'],
    ['only with no glob', 'only', 4, 'glob'],
    ['only with two globs', 'only *.md *.txt', 10, 'end'],
    ['an ampersand, which is not a field', '&& x', 0, 'field'],
  ])('refuses %s, naming where it stopped', (_why, text, position, mentions) => {
    const parsed = parseRouteCondition(text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.position).toBe(position);
    expect(parsed.problem).toMatch(new RegExp(mentions));
  });

  it('has a bound the schema states and the parser keeps', () => {
    const long = `language == ${'x'.repeat(ROUTE_CONDITION_MAX_CHARS)}`;
    expect(routeConditionTextSchema.safeParse(long).success).toBe(false);
    expect(parseRouteCondition(long).ok).toBe(false);
  });

  it.each([
    ['a bidi override in a bare literal', 'language == a‮b', 13],
    ['a bell in a glob', 'only \u0007*.md', 5],
    ['a raw control character inside quotes', 'title == "a\u001bb"', 11],
    ['an escape sequence in a field position', '\u009blanguage == x', 0],
  ])('refuses %s, at the character', (_why, text, position) => {
    const parsed = parseRouteCondition(text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.position).toBe(position);
    expect(parsed.problem).toMatch(/control or bidirectional/);
  });

  it('refuses a control character a quoted literal spells as an escape, at the quote', () => {
    const parsed = parseRouteCondition('title == "a\\u202eb"');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.position).toBe(9);
    expect(parsed.problem).toMatch(/control or bidirectional/);
  });

  it('collapses a run of wildcards: stars within a segment to one, ** segments to one', () => {
    expect(condition('only **a**b')).toEqual({ kind: 'only', glob: '*a*b' });
    expect(condition('only src/***/x.rs')).toEqual({ kind: 'only', glob: 'src/**/x.rs' });
    expect(condition('only **/**/*.rs')).toEqual({ kind: 'only', glob: '**/*.rs' });
    expect(condition('only docs/**/*.md')).toEqual({ kind: 'only', glob: 'docs/**/*.md' });
  });

  it(`takes ${String(ROUTE_GLOB_MAX_WILDCARDS)} wildcards and refuses the one after, where it is`, () => {
    const atTheCap = `only ${'?'.repeat(ROUTE_GLOB_MAX_WILDCARDS)}`;
    expect(parseRouteCondition(atTheCap).ok).toBe(true);
    const overIt = `only ${'*a'.repeat(ROUTE_GLOB_MAX_WILDCARDS)}*`;
    const parsed = parseRouteCondition(overIt);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.position).toBe(5 + 2 * ROUTE_GLOB_MAX_WILDCARDS);
    expect(parsed.problem).toMatch(/wildcards/);
  });
});

describe('routeConditionTextSchema', () => {
  it('accepts exactly what the parser accepts, with the parser’s words on a no', () => {
    expect(routeConditionTextSchema.safeParse('language == rust').success).toBe(true);
    const refused = routeConditionTextSchema.safeParse('language <> rust');
    expect(refused.success).toBe(false);
    if (refused.success) return;
    expect(refused.error.issues[0]?.message).toContain('position 9');
  });
});

describe('routeInputSchema', () => {
  it('takes a JSON object and refuses anything that is not one', () => {
    expect(routeInputSchema.safeParse({ language: 'rust', files: ['a.rs'] }).success).toBe(true);
    expect(routeInputSchema.safeParse('rust').success).toBe(false);
    expect(routeInputSchema.safeParse(['rust']).success).toBe(false);
    expect(routeInputSchema.safeParse(null).success).toBe(false);
  });

  it('is bounded in its serialised size, so a frame carrying one fits the socket', () => {
    expect(routeInputSchema.safeParse({ text: 'x'.repeat(ROUTE_INPUT_MAX_CHARS) }).success).toBe(
      false,
    );
  });
});

describe('evaluateRouteCondition', () => {
  const pr = input({
    language: 'rust',
    size: 12,
    draft: false,
    reviewer: null,
    author: { login: 'ana' },
    files: ['src/lib.rs', 'src/main.rs'],
  });

  it('compares a string field with the literal', () => {
    expect(evaluateRouteCondition(condition('language == rust'), pr)).toBe(true);
    expect(evaluateRouteCondition(condition('language == ts'), pr)).toBe(false);
    expect(evaluateRouteCondition(condition('language != ts'), pr)).toBe(true);
  });

  it('compares a number, a boolean or a null the way it is written in JSON', () => {
    expect(evaluateRouteCondition(condition('size == 12'), pr)).toBe(true);
    expect(evaluateRouteCondition(condition('draft == false'), pr)).toBe(true);
    expect(evaluateRouteCondition(condition('reviewer == null'), pr)).toBe(true);
  });

  it('follows a dotted field into a nested object', () => {
    expect(evaluateRouteCondition(condition('author.login == ana'), pr)).toBe(true);
    expect(evaluateRouteCondition(condition('author.login.x == ana'), pr)).toBe(false);
  });

  it('treats a missing field as equal to nothing and unequal to everything', () => {
    expect(evaluateRouteCondition(condition('branch == main'), pr)).toBe(false);
    expect(evaluateRouteCondition(condition('branch != main'), pr)).toBe(true);
  });

  it('never equates an object or a list with a literal', () => {
    expect(evaluateRouteCondition(condition('author == ana'), pr)).toBe(false);
    expect(evaluateRouteCondition(condition('files == src/lib.rs'), pr)).toBe(false);
  });

  it('matches only when every file fits the glob, and there is at least one', () => {
    expect(evaluateRouteCondition(condition('only src/*.rs'), pr)).toBe(true);
    expect(evaluateRouteCondition(condition('only *.rs'), pr)).toBe(false);
    expect(evaluateRouteCondition(condition('only **/*.rs'), pr)).toBe(true);
    expect(evaluateRouteCondition(condition('only src/lib.rs'), pr)).toBe(false);
    expect(evaluateRouteCondition(condition('only src/???.rs'), pr)).toBe(false);
    expect(evaluateRouteCondition(condition('only src/**'), pr)).toBe(true);
    expect(evaluateRouteCondition(condition('only *.md'), input({ files: [] }))).toBe(false);
  });

  it('is false for an input with no file list, or one that is not a list of strings', () => {
    expect(evaluateRouteCondition(condition('only *.rs'), input({}))).toBe(false);
    expect(evaluateRouteCondition(condition('only *.rs'), input({ files: 'a.rs' }))).toBe(false);
    expect(evaluateRouteCondition(condition('only *.rs'), input({ files: ['a.rs', 3] }))).toBe(
      false,
    );
  });

  it('reads a glob as characters and never as a pattern of its own', () => {
    const odd = input({ files: ['a+b(c).rs'] });
    expect(evaluateRouteCondition(condition('only a+b(c).rs'), odd)).toBe(true);
    expect(evaluateRouteCondition(condition('only a+b(c).ts'), odd)).toBe(false);
    expect(evaluateRouteCondition(condition('only a.rs'), input({ files: ['aXrs'] }))).toBe(false);
    expect(evaluateRouteCondition(condition('only *.rs'), input({ files: ['ars'] }))).toBe(false);
  });

  const only = (glob: string, ...files: string[]): boolean =>
    evaluateRouteCondition(condition(`only ${glob}`), input({ files }));

  it('lets ** stand for any number of directories, including none', () => {
    expect(only('docs/**/*.md', 'docs/a.md', 'docs/a/b.md', 'docs/a/b/c/d.md')).toBe(true);
    expect(only('docs/**/*.md', 'src/a.md')).toBe(false);
    expect(only('docs/**/*.md', 'docs/a/b.rs')).toBe(false);
    expect(only('**/*.rs', 'lib.rs', 'src/lib.rs')).toBe(true);
    expect(only('src/**', 'src/a', 'src/a/b/c')).toBe(true);
    expect(only('src/**', 'lib/a')).toBe(false);
    expect(only('a/**/b/**/c', 'a/b/c', 'a/x/b/y/z/c')).toBe(true);
    expect(only('a/**/b/**/c', 'a/x/c')).toBe(false);
  });

  it('keeps * and ? within one directory', () => {
    expect(only('src/*.rs', 'src/lib.rs')).toBe(true);
    expect(only('src/*.rs', 'src/a/lib.rs')).toBe(false);
    expect(only('*', 'a', 'b.c')).toBe(true);
    expect(only('*', 'a/b')).toBe(false);
    expect(only('src/?.rs', 'src/a.rs')).toBe(true);
    expect(only('src/?.rs', 'src/ab.rs', 'src//.rs')).toBe(false);
    expect(only('a*b*c', 'abc', 'aXbYYc')).toBe(true);
    expect(only('a*b*c', 'ab', 'a/bc')).toBe(false);
  });

  it('reads a run of stars inside a segment as one star, in a glob no parser collapsed', () => {
    const stored: RouteCondition = { kind: 'only', glob: 'src/**.rs' };
    expect(evaluateRouteCondition(stored, input({ files: ['src/lib.rs'] }))).toBe(true);
    expect(evaluateRouteCondition(stored, input({ files: ['src/a/lib.rs'] }))).toBe(false);
  });

  it.each([8, 12])(
    'answers an adversarial glob of %i wildcard runs against a long name well within a tick',
    (k) => {
      // A backtracking regular expression takes seconds at k=6 and never
      // finishes at k=10 on this input. A matcher that has to answer for every
      // socket on the hub answers in linear time or not at all.
      const glob = `${'**a'.repeat(k)}**b`;
      const stored: RouteCondition = { kind: 'only', glob };
      const files = input({ files: ['a'.repeat(60)] });
      const started = performance.now();
      expect(evaluateRouteCondition(stored, files)).toBe(false);
      expect(evaluateRouteCondition(condition(`only ${glob}`), files)).toBe(false);
      expect(performance.now() - started).toBeLessThan(100);
    },
  );
});
