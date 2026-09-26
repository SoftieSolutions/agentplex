import { describe, expect, it } from 'vitest';
import * as protocol from './index.js';
import {
  CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSIONS,
  SERVER_PROTOCOL_VERSION,
  checkClientProtocolVersion,
  checkServerProtocolVersion,
} from './version.js';

describe('checkClientProtocolVersion', () => {
  it('accepts only an exact match', () => {
    expect(checkClientProtocolVersion(CLIENT_PROTOCOL_VERSION)).toBeNull();
  });

  it('refuses a newer peer rather than guessing what it added', () => {
    expect(checkClientProtocolVersion(CLIENT_PROTOCOL_VERSION + 1)).toEqual({
      expected: CLIENT_PROTOCOL_VERSION,
      received: CLIENT_PROTOCOL_VERSION + 1,
    });
  });

  it('refuses an older peer rather than guessing what it lacks', () => {
    expect(checkClientProtocolVersion(CLIENT_PROTOCOL_VERSION - 1)).toEqual({
      expected: CLIENT_PROTOCOL_VERSION,
      received: CLIENT_PROTOCOL_VERSION - 1,
    });
  });
});

describe('checkServerProtocolVersion', () => {
  it('accepts only an exact match', () => {
    expect(checkServerProtocolVersion(SERVER_PROTOCOL_VERSION)).toBeNull();
  });

  it('refuses a newer peer rather than guessing what it added', () => {
    expect(checkServerProtocolVersion(SERVER_PROTOCOL_VERSION + 1)).toEqual({
      expected: SERVER_PROTOCOL_VERSION,
      received: SERVER_PROTOCOL_VERSION + 1,
    });
  });

  it('refuses an older peer rather than guessing what it lacks', () => {
    expect(checkServerProtocolVersion(SERVER_PROTOCOL_VERSION - 1)).toEqual({
      expected: SERVER_PROTOCOL_VERSION,
      received: SERVER_PROTOCOL_VERSION - 1,
    });
  });
});

describe('PROTOCOL_VERSIONS', () => {
  it('names each leg by its own constant', () => {
    expect(PROTOCOL_VERSIONS).toEqual({
      client: CLIENT_PROTOCOL_VERSION,
      server: SERVER_PROTOCOL_VERSION,
    });
  });
});

describe('the package entry', () => {
  it('no longer offers one version for both legs', () => {
    expect(protocol).not.toHaveProperty('PROTOCOL_VERSION');
    expect(protocol).not.toHaveProperty('checkProtocolVersion');
  });

  it('offers each leg its own constant and check', () => {
    expect(protocol).toMatchObject({
      CLIENT_PROTOCOL_VERSION,
      SERVER_PROTOCOL_VERSION,
      PROTOCOL_VERSIONS,
      checkClientProtocolVersion,
      checkServerProtocolVersion,
    });
  });
});
