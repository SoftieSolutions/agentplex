import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from './version.js';
import { parseClientFrame, parseHubFrame, type ClientFrame, type HubFrame } from './client.js';
import { hubIdSchema } from './identity.js';
import { parseTextFrame } from './parse.js';

describe('parseClientFrame', () => {
  it('accepts hello with a version', () => {
    const result = parseClientFrame({
      type: 'hello',
      id: 1,
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown frame type rather than passing it along', () => {
    expect(parseClientFrame({ type: 'run', id: 1, command: 'rm -rf /' }).ok).toBe(false);
  });

  it('rejects a frame id that is not a positive integer', () => {
    expect(parseClientFrame({ type: 'ping', id: 0 }).ok).toBe(false);
    expect(parseClientFrame({ type: 'ping', id: -1 }).ok).toBe(false);
    expect(parseClientFrame({ type: 'ping', id: 1.5 }).ok).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(parseClientFrame('ping').ok).toBe(false);
    expect(parseClientFrame(null).ok).toBe(false);
  });
});

describe('parseHubFrame', () => {
  it('accepts a welcome', () => {
    const result = parseHubFrame({
      type: 'welcome',
      replyTo: 1,
      protocolVersion: PROTOCOL_VERSION,
      hubId: 'hub-1',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a refusal with a known code', () => {
    const result = parseHubFrame({
      type: 'refusal',
      replyTo: 1,
      code: 'unauthorized',
      message: 'token not accepted',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a refusal with a code outside the closed set', () => {
    const result = parseHubFrame({
      type: 'refusal',
      replyTo: 1,
      code: 'teapot',
      message: 'no',
    });
    expect(result.ok).toBe(false);
  });

  it('does not accept a client frame on the hub-to-client direction', () => {
    expect(parseHubFrame({ type: 'ping', id: 1 }).ok).toBe(false);
  });
});

/**
 * Both halves of a direction, checked against each other.
 *
 * A schema proves a parser accepts what the test author typed. It proves
 * nothing about whether the other side can build that value, or whether it
 * survives the JSON it travels as. Nothing in the applications calls these
 * parsers yet, so until milestone 3 wires them up this is the only thing
 * holding the two ends together.
 */
describe('client and hub round trips', () => {
  const clientFrames: readonly ClientFrame[] = [
    { type: 'hello', id: 1, protocolVersion: PROTOCOL_VERSION },
    { type: 'ping', id: 2 },
    { type: 'protocol-error', code: 'bad-request', message: 'frame is not valid JSON' },
  ];

  const hubFrames: readonly HubFrame[] = [
    {
      type: 'welcome',
      replyTo: 1,
      protocolVersion: PROTOCOL_VERSION,
      hubId: hubIdSchema.parse('hub-1'),
    },
    { type: 'pong', replyTo: 2 },
    { type: 'refusal', replyTo: 3, code: 'unauthorized', message: 'token not accepted' },
    { type: 'protocol-error', code: 'protocol-version', message: 'this hub speaks version 2' },
  ];

  it.each(clientFrames)('the hub reads back the $type a client sends', (frame) => {
    expect(parseTextFrame(parseClientFrame, JSON.stringify(frame))).toEqual({
      ok: true,
      value: frame,
    });
  });

  it.each(hubFrames)('a client reads back the $type the hub sends', (frame) => {
    expect(parseTextFrame(parseHubFrame, JSON.stringify(frame))).toEqual({
      ok: true,
      value: frame,
    });
  });

  it('lets either side say it could not read a frame, with nothing to reply to', () => {
    // The case a refusal cannot carry: an unparseable frame has no id to name.
    const unreadable = parseTextFrame(parseClientFrame, '{not json');
    expect(unreadable.ok).toBe(false);
    if (unreadable.ok) return;

    const answer: HubFrame = {
      type: 'protocol-error',
      code: 'bad-request',
      message: unreadable.reason,
    };
    expect(parseTextFrame(parseHubFrame, JSON.stringify(answer))).toEqual({
      ok: true,
      value: answer,
    });
  });

  it('refuses a protocol-error that names a code outside the two readable failures', () => {
    expect(parseHubFrame({ type: 'protocol-error', code: 'internal', message: 'no' }).ok).toBe(
      false,
    );
  });
});
