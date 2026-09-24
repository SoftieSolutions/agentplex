import { z } from 'zod';

/**
 * The one sentence a ROUTER node decides by, and how it is read.
 *
 * A route in a graph is a condition and a destination. The condition is text
 * a person typed into an inspector, so it is a claim and goes through a parser
 * that can say no -- at write time, so the document a graph is published from
 * holds nothing the runtime will have to guess at, and again at run time, so
 * nothing downstream evaluates a string.
 *
 * ## Why this grammar and no other
 *
 * Three forms and nothing else:
 *
 *     field == literal
 *     field != literal
 *     only <glob>
 *
 * No `and`, no `or`, no parentheses, no arithmetic. The temptation is an
 * expression language, and the reason to refuse it is what a router is for: a
 * ROUTER decides which of a handful of agents sees a change, and a decision a
 * person cannot read off the node in one glance is a decision the graph editor
 * cannot draw. Two conditions that must both hold are two routers in a row;
 * two that may either hold are two routes to one destination. Both are
 * visible on the canvas, which is where a graph's logic is meant to live.
 *
 * `only <glob>` is the one form that is not a comparison, and it earns its
 * place because it is the question every code-review graph asks first: does
 * this change touch nothing but documentation, nothing but one language. It
 * matches when every entry of the input's `files` list fits the glob.
 *
 * ## What a parse failure carries
 *
 * A position, so an inspector can put the caret where the text stopped making
 * sense, and a sentence that names what was expected there. The sentence is
 * the parser's and travels as-is: the client renders it and never composes
 * its own reading of what went wrong.
 */

/**
 * A condition is one line a person reads at a glance. The bound is for the
 * frame it travels in, like every other text bound in this protocol, and it is
 * small because a condition near it is already one nobody can read.
 */
export const ROUTE_CONDITION_MAX_CHARS = 200;

/**
 * How large the JSON object a run is started with may be, serialised.
 *
 * A run's input is what a trigger hands the graph: a few fields naming a
 * change and the list of files it touched. Sixteen thousand characters is
 * room for a long file list and nothing like a document, which is the
 * distinction: an input is a description of work, and the work itself lives
 * on a machine.
 */
export const ROUTE_INPUT_MAX_CHARS = 16_000;

export type RouteCondition =
  | { readonly kind: 'equals'; readonly field: string; readonly literal: string }
  | { readonly kind: 'not-equals'; readonly field: string; readonly literal: string }
  | { readonly kind: 'only'; readonly glob: string };

export type RouteConditionParse =
  | { readonly ok: true; readonly condition: RouteCondition }
  /** `position` is the index in the text where reading stopped. */
  | { readonly ok: false; readonly position: number; readonly problem: string };

/** A field is a dotted path of identifiers: `language`, `pr.author.login`. */
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/;
const WHITESPACE = /^\s*/;
const BARE = /^[^\s"]+/;

function refuse(position: number, problem: string): RouteConditionParse {
  return { ok: false, position, problem: `${problem} at position ${String(position)}` };
}

/**
 * Reads a JSON string literal starting at the opening quote.
 *
 * Returns the index just past the closing quote and the decoded value, or the
 * position of the opening quote when the string never closes. JSON's own
 * escape rules and nothing else, decoded by the JSON parser rather than by a
 * second reading of them here.
 */
function readQuoted(
  text: string,
  start: number,
): { readonly end: number; readonly value: string } | null {
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '"') {
      const parsed = z.string().safeParse(safeJsonParse(text.slice(start, index + 1)));
      if (!parsed.success) return null;
      return { end: index + 1, value: parsed.data };
    }
    index += 1;
  }
  return null;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function parseRouteCondition(text: string): RouteConditionParse {
  if (text.length > ROUTE_CONDITION_MAX_CHARS) {
    return refuse(
      ROUTE_CONDITION_MAX_CHARS,
      `a condition is at most ${String(ROUTE_CONDITION_MAX_CHARS)} characters; this one goes on`,
    );
  }

  let position = WHITESPACE.exec(text)?.[0].length ?? 0;
  const rest = (): string => text.slice(position);
  const skipWhitespace = (): void => {
    position += WHITESPACE.exec(rest())?.[0].length ?? 0;
  };
  const atEnd = (): RouteConditionParse | null => {
    skipWhitespace();
    return position === text.length ? null : refuse(position, 'expected the end of the condition');
  };

  const field = FIELD.exec(rest())?.[0];
  if (field === undefined) {
    return refuse(position, 'expected a field name, or only followed by a glob');
  }

  if (field === 'only' && (position + 4 === text.length || /\s/.test(text[position + 4] ?? ''))) {
    position += 4;
    skipWhitespace();
    const glob = /^\S+/.exec(rest())?.[0];
    if (glob === undefined) return refuse(position, 'expected a glob after only');
    position += glob.length;
    const trailing = atEnd();
    if (trailing !== null) return trailing;
    return { ok: true, condition: { kind: 'only', glob } };
  }

  position += field.length;
  skipWhitespace();
  const operator = rest().slice(0, 2);
  if (operator !== '==' && operator !== '!=') {
    return refuse(position, 'expected == or != after the field');
  }
  position += 2;
  skipWhitespace();

  let literal: string;
  if (text[position] === '"') {
    const quoted = readQuoted(text, position);
    if (quoted === null) return refuse(position, 'expected a closing quote for the literal');
    literal = quoted.value;
    position = quoted.end;
  } else {
    const bare = BARE.exec(rest())?.[0];
    if (bare === undefined) return refuse(position, 'expected a literal after the operator');
    literal = bare;
    position += bare.length;
  }

  const trailing = atEnd();
  if (trailing !== null) return trailing;
  return {
    ok: true,
    condition: { kind: operator === '==' ? 'equals' : 'not-equals', field, literal },
  };
}

/**
 * A condition as it travels: the text, refused unless the parser reads it.
 *
 * The text and not the parsed form, because the text is what a person typed
 * and what the inspector shows back; the parsed form is a reading of it that
 * either end can repeat. The refusal carries the parser's sentence, position
 * included, so a client can say where.
 */
export const routeConditionTextSchema = z
  .string()
  .max(ROUTE_CONDITION_MAX_CHARS)
  .superRefine((text, context) => {
    const parsed = parseRouteCondition(text);
    if (!parsed.ok) context.addIssue({ code: 'custom', message: parsed.problem });
  });

/**
 * What a run is started with: one JSON object, bounded.
 *
 * An object and not any JSON value, because a condition names a field and a
 * field is something an object has. Every value inside is whatever JSON
 * allows; the conditions above decide what they can compare with.
 */
export const routeInputSchema = z
  .record(z.string().min(1).max(64), z.json())
  .refine(
    (value) => JSON.stringify(value).length <= ROUTE_INPUT_MAX_CHARS,
    `an input is at most ${String(ROUTE_INPUT_MAX_CHARS)} characters serialised`,
  );
export type RouteInput = z.infer<typeof routeInputSchema>;

/** Walks a dotted field into the input; `undefined` for a path that is not there. */
function lookup(input: RouteInput, field: string): unknown {
  let current: unknown = input;
  for (const segment of field.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Whether a scalar equals a literal, in the spelling a person would type.
 *
 * A string is compared as itself. A number, a boolean and `null` are compared
 * the way JSON writes them, so `size == 12` and `draft == false` read as they
 * would in the input. An object or a list equals no literal: there is no one
 * spelling of either that a person would type into a condition.
 */
function equals(value: unknown, literal: string): boolean {
  if (typeof value === 'string') return value === literal;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return JSON.stringify(value) === literal;
  }
  return false;
}

const GLOB_SPECIAL = /[.+^${}()|[\]\\]/g;

/**
 * A glob as a regular expression over a slash-separated path.
 *
 * `**` crosses directories, `*` stays within one, `?` is one character that is
 * not a slash. Every other character is itself, escaped, so a parenthesis or
 * a plus in a filename is a filename character and never a pattern.
 */
function globToPattern(glob: string): RegExp {
  let pattern = '';
  let index = 0;
  while (index < glob.length) {
    if (glob.startsWith('**/', index)) {
      pattern += '(?:.*/)?';
      index += 3;
    } else if (glob.startsWith('**', index)) {
      pattern += '.*';
      index += 2;
    } else if (glob[index] === '*') {
      pattern += '[^/]*';
      index += 1;
    } else if (glob[index] === '?') {
      pattern += '[^/]';
      index += 1;
    } else {
      pattern += (glob[index] ?? '').replace(GLOB_SPECIAL, '\\$&');
      index += 1;
    }
  }
  return new RegExp(`^${pattern}$`);
}

/**
 * Whether a condition holds for an input. Never throws: an input is a claim a
 * trigger made about a change, and a condition that met one it did not expect
 * is a route not taken, not a run that crashed.
 *
 * `only` holds when the input has a non-empty list of file names and every
 * one fits the glob. Empty is a deliberate no rather than a vacuous yes: a
 * router asking "does this touch only documentation" of a change that
 * touched nothing should not send it to the documentation reviewer.
 */
export function evaluateRouteCondition(condition: RouteCondition, input: RouteInput): boolean {
  switch (condition.kind) {
    case 'equals':
      return equals(lookup(input, condition.field), condition.literal);
    case 'not-equals':
      return !equals(lookup(input, condition.field), condition.literal);
    case 'only': {
      const files = lookup(input, 'files');
      if (!Array.isArray(files) || files.length === 0) return false;
      const pattern = globToPattern(condition.glob);
      return files.every((file) => typeof file === 'string' && pattern.test(file));
    }
  }
}
