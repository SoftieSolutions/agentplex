import { type z } from 'zod';

/**
 * The result of reading a claim off the wire.
 *
 * Parsers return this rather than throwing: a malformed frame is an expected
 * condition on a socket open to the network, not an exceptional one, and the
 * caller has to decide between a refusal reply and a close either way.
 */
export type ParseResult<T> = { readonly ok: true; readonly value: T } | ParseFailure;

export type ParseFailure = { readonly ok: false; readonly reason: string };

/**
 * Builds the single parser a side of the protocol owns.
 *
 * Every frame arriving on a given direction goes through exactly one of these.
 * Downstream code narrows on the discriminant the schema already validated and
 * never re-checks `type` by hand.
 */
export function frameParser<S extends z.ZodType>(
  schema: S,
): (raw: unknown) => ParseResult<z.infer<S>> {
  return (raw: unknown) => {
    const result = schema.safeParse(raw);
    if (result.success) return { ok: true, value: result.data };
    return { ok: false, reason: describe(result.error) };
  };
}

/** Parses a JSON text frame, so that bad JSON and a bad shape read the same way. */
export function parseTextFrame<T>(
  parser: (raw: unknown) => ParseResult<T>,
  text: string,
): ParseResult<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'frame is not valid JSON' };
  }
  return parser(raw);
}

function describe(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'frame did not match the protocol';
  const path = issue.path.join('.');
  return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
}
