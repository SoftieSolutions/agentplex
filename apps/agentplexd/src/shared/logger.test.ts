import { describe, expect, it } from 'vitest';
import { REDACTED, createLogger, jsonLineSink, redactSecrets, type LogRecord } from './logger.js';

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

describe('redaction', () => {
  it('replaces a credential with a marker rather than dropping the field', () => {
    const redacted = redactSecrets({ role: 'server', token: 'a-server-token' });
    // The key survives: a line that lost the field entirely reads the same as
    // one that never had it, and then nobody can tell hidden from absent.
    expect(redacted).toEqual({ role: 'server', token: REDACTED });
  });

  it('reaches a credential nested inside another field', () => {
    const redacted = redactSecrets({ server: { id: 'server-1', ticket: 'one-shot' } });
    expect(redacted).toEqual({ server: { id: 'server-1', ticket: REDACTED } });
  });

  it('reaches one inside an array, which is where a list of peers puts it', () => {
    const redacted = redactSecrets({ servers: [{ password: 'hunter2' }] });
    expect(redacted).toEqual({ servers: [{ password: REDACTED }] });
  });

  it('covers the names a credential actually travels under', () => {
    const redacted = redactSecrets({
      token: 'a',
      ticket: 'b',
      password: 'c',
      authorization: 'd',
      databaseUrl: 'postgres://agentplex:hunter2@localhost:5432/agentplex',
    });
    expect(Object.values(redacted)).toEqual([REDACTED, REDACTED, REDACTED, REDACTED, REDACTED]);
  });

  it('does not care how the key was spelled', () => {
    const redacted = redactSecrets({
      DATABASE_URL: 'postgres://x',
      'database-url': 'postgres://y',
      serverToken: 'z',
    });
    expect(Object.values(redacted)).toEqual([REDACTED, REDACTED, REDACTED]);
  });

  it('leaves everything else alone, including values it cannot walk', () => {
    const at = new Date('2026-09-01T12:00:00.000Z');
    const redacted = redactSecrets({ port: 8080, ok: true, at, missing: null });
    expect(redacted).toEqual({ port: 8080, ok: true, at, missing: null });
  });

  it('survives a structure that refers to itself', () => {
    const fields: Record<string, unknown> = { token: 'a' };
    fields['self'] = fields;
    expect(redactSecrets(fields)).toEqual({ token: REDACTED, self: '[circular]' });
  });
});

describe('createLogger redaction', () => {
  it('redacts at the sink, so no call site has to remember to', () => {
    const { records, sink } = capture();
    createLogger('info', sink).info('handshake', { token: 'a-server-token' });
    expect(records[0]?.fields).toEqual({ token: REDACTED });
  });

  it('redacts a field a child logger stamps on every line', () => {
    const { records, sink } = capture();
    createLogger('info', sink).child({ token: 'a-server-token' }).info('dialling');
    expect(records[0]?.fields).toEqual({ token: REDACTED });
  });
});
