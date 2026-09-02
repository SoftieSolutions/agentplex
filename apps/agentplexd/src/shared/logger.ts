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

export function createLogger(
  minimumLevel: LogLevel,
  sink: LogSink,
  baseFields: LogFields = {},
): Logger {
  const threshold = LOG_LEVELS.indexOf(minimumLevel);

  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (LOG_LEVELS.indexOf(level) < threshold) return;
    sink({ level, message, fields: { ...baseFields, ...fields } });
  };

  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (fields) => createLogger(minimumLevel, sink, { ...baseFields, ...fields }),
  };
}

/** One JSON object per line: greppable by a person, parseable by a log shipper. */
export function jsonLineSink(write: (line: string) => void, clock: Clock): LogSink {
  return ({ level, message, fields }) => {
    const time = new Date(clock.now()).toISOString();
    write(JSON.stringify({ time, level, message, ...fields }));
  };
}
