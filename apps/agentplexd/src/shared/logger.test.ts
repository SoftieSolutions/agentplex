import { describe, expect, it } from 'vitest';
import { createLogger, jsonLineSink, type LogRecord } from './logger.js';

function capture(): { records: LogRecord[]; sink: (record: LogRecord) => void } {
  const records: LogRecord[] = [];
  return { records, sink: (record) => records.push(record) };
}

describe('createLogger', () => {
  it('drops records below the configured level', () => {
    const { records, sink } = capture();
    const logger = createLogger('warn', sink);
    logger.debug('quiet');
    logger.info('also quiet');
    logger.warn('loud');
    expect(records.map((record) => record.message)).toEqual(['loud']);
  });

  it('stamps a child logger fields onto every record', () => {
    const { records, sink } = capture();
    const logger = createLogger('info', sink).child({ role: 'hub' });
    logger.info('started', { port: 8080 });
    expect(records[0]?.fields).toEqual({ role: 'hub', port: 8080 });
  });

  it('lets a call site override an inherited field', () => {
    const { records, sink } = capture();
    createLogger('info', sink).child({ role: 'hub' }).info('handoff', { role: 'server' });
    expect(records[0]?.fields).toEqual({ role: 'server' });
  });
});

describe('jsonLineSink', () => {
  it('writes one parseable JSON object per record', () => {
    const lines: string[] = [];
    const clock = { now: () => Date.parse('2026-09-01T12:00:00.000Z') };
    jsonLineSink(
      (line) => lines.push(line),
      clock,
    )({
      level: 'info',
      message: 'listening',
      fields: { port: 8080 },
    });
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      time: '2026-09-01T12:00:00.000Z',
      level: 'info',
      message: 'listening',
      port: 8080,
    });
  });
});
