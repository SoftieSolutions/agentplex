import type { Clock } from './clock.js';

/**
 * The logging seam.
 *
 * Injected rather than imported at each call site, so a test asserts on what a
 * module said without capturing a global stream, and so the process decides
 * once — in `main` — where lines go.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that stamps every line with these fields. Cheap; make them freely. */
  child(fields: LogFields): Logger;
}

export interface LogRecord {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

export type LogSink = (record: LogRecord) => void;

/** What a redacted value reads as. The key survives; only the value goes. */
export const REDACTED = '[redacted]';

/**
 * Field names whose values never belong in a log line.
 *
 * Matched as substrings of the normalized key, so `token`, `serverToken` and
 * `SERVER_TOKEN` are all one rule. Over-redacting a `tokenCount` is a cost
 * worth paying: a secret in a log file is one that has to be rotated, and a
 * count that reads `[redacted]` is an annoyance.
 *
 * `databaseurl` is here because a Postgres URL carries its password inline, so
 * the field is a credential whatever it is named.
 */
const SECRET_KEYS = [
  'token',
  'ticket',
  'password',
  'secret',
  'authorization',
  'cookie',
  'databaseurl',
];

/** How deep to walk before giving up on a structure nobody meant to log. */
const MAX_DEPTH = 8;

export function createLogger(
  minimumLevel: LogLevel,
  sink: LogSink,
  baseFields: LogFields = {},
): Logger {
  const threshold = LOG_LEVELS.indexOf(minimumLevel);

  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (LOG_LEVELS.indexOf(level) < threshold) return;
    // Redacted here rather than at the call sites, because a call site that has
    // to remember is one that will forget: `main` and `runtime` both log
    // `String(error)`, the protocol carries a server token, and milestone 3
    // adds a client token and a single-use ticket. Every sink — the JSON line
    // sink, a test sink, whatever comes later — is handed a clean record.
    sink({ level, message, fields: redactSecrets({ ...baseFields, ...fields }) });
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (fields) => createLogger(minimumLevel, sink, { ...baseFields, ...fields }),
  };
}

/**
 * Replaces the value of every secret-looking field, at any depth, with
 * `[redacted]`.
 *
 * The key is kept. A line that silently lost a field reads as a line that
 * never had one, and then nobody can tell whether the token was absent or
 * hidden.
 */
export function redactSecrets(fields: LogFields): LogFields {
  const seen = new WeakSet<object>();
  // The root goes in too, or a field pointing back at the record it lives in
  // is walked once before the cycle is noticed.
  seen.add(fields);
  return redactRecord(fields, seen, 0);
}

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_KEYS.some((secret) => normalized.includes(secret));
}

/**
 * Only plain objects and arrays are walked. A Date, an Error or anything with
 * a class is left as it is: reading its keys would replace it with an empty
 * object, which loses more than it protects.
 */
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function redactRecord(record: object, seen: WeakSet<object>, depth: number): LogFields {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    redacted[key] = isSecretKey(key) ? REDACTED : redactValue(value, seen, depth + 1);
  }
  return redacted;
}

function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) return '[too deep]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen, depth + 1));
  return isPlainObject(value) ? redactRecord(value, seen, depth) : value;
}

/** One JSON object per line: greppable by a person, parseable by a log shipper. */
export function jsonLineSink(write: (line: string) => void, clock: Clock): LogSink {
  return ({ level, message, fields }) => {
    const time = new Date(clock.now()).toISOString();
    write(JSON.stringify({ time, level, message, ...fields }));
  };
}
