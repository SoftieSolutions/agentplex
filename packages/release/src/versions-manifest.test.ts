import { describe, expect, it } from 'vitest';
import {
  parseVersionsManifest,
  serializeVersionsManifest,
  updateVersionsManifest,
} from './versions-manifest.js';

/**
 * The manifest the release publishes on `v1`.
 *
 * The other half of these assertions is in `install.sh.integration.test.ts`,
 * where the same file is read by the shell parser that machines actually run
 * it through. This suite is about the writing end: what a release will carry
 * forward off a branch, and what it refuses to.
 */

const current = JSON.stringify({
  cli: { version: '1.4.0', protocol: 3 },
  hub: { version: '1.2.0', protocol: 3 },
  server: { version: '1.5.0', protocol: 3 },
  web: { version: '1.1.0', protocol: 3 },
});

describe('parseVersionsManifest', () => {
  it('reads what a previous release left behind', () => {
    expect(parseVersionsManifest('versions.json', current)['hub']).toEqual({
      version: '1.2.0',
      protocol: 3,
    });
  });

  /**
   * The first release of the first component has nothing to inherit, and
   * treating that as a failure would make the one release nobody can retry the
   * one that cannot run.
   */
  it('takes an empty file as an empty manifest rather than as a failure', () => {
    expect(parseVersionsManifest('versions.json', '')).toEqual({});
    expect(parseVersionsManifest('versions.json', '  \n')).toEqual({});
  });

  it('refuses something that is not JSON, naming the file', () => {
    expect(() => parseVersionsManifest('versions.json', 'not json')).toThrow('versions.json');
  });

  /**
   * The branch this is read off is one anybody with write access can push to,
   * so every one of these is a file a release could really meet. Each fails the
   * release rather than being carried forward and served to every machine that
   * installs.
   */
  it.each([
    ['a JSON array', '[]'],
    ['a JSON string', '"1.4.0"'],
    ['an entry that is not an object', '{"cli":"1.4.0"}'],
    ['an entry with no protocol', '{"cli":{"version":"1.4.0"}}'],
    ['an entry with no version', '{"cli":{"protocol":3}}'],
    ['a version that is not one', '{"cli":{"version":"latest","protocol":3}}'],
    ['a partial version', '{"cli":{"version":"1.4","protocol":3}}'],
    ['a protocol that is a string', '{"cli":{"version":"1.4.0","protocol":"3"}}'],
    ['a protocol of zero', '{"cli":{"version":"1.4.0","protocol":0}}'],
    ['a field nobody listed', '{"cli":{"version":"1.4.0","protocol":3,"channel":"beta"}}'],
  ])('refuses %s', (_name, text) => {
    expect(() => parseVersionsManifest('versions.json', text)).toThrow();
  });

  /**
   * A prerelease is a version this can publish -- the workflow decides
   * separately whether a prerelease should advance `v1` at all -- so the
   * parser has no business refusing one.
   */
  it('accepts a prerelease version', () => {
    expect(
      parseVersionsManifest('versions.json', '{"cli":{"version":"2.0.0-rc.1","protocol":4}}'),
    ).toEqual({ cli: { version: '2.0.0-rc.1', protocol: 4 } });
  });
});

describe('updateVersionsManifest', () => {
  /** A tag releases one component, so a release knows one entry and inherits the rest. */
  it('replaces one entry and leaves the others exactly as they were', () => {
    const previous = parseVersionsManifest('versions.json', current);

    const updated = updateVersionsManifest(previous, 'hub', { version: '1.3.0', protocol: 3 });

    expect(updated).toEqual({
      cli: { version: '1.4.0', protocol: 3 },
      hub: { version: '1.3.0', protocol: 3 },
      server: { version: '1.5.0', protocol: 3 },
      web: { version: '1.1.0', protocol: 3 },
    });
    expect(previous['hub']).toEqual({ version: '1.2.0', protocol: 3 });
  });

  it('adds a component the manifest did not carry yet', () => {
    expect(
      Object.keys(updateVersionsManifest({}, 'cli', { version: '1.0.0', protocol: 1 })),
    ).toEqual(['cli']);
  });

  /**
   * The entry being written is checked too, and not only the file it is being
   * merged into. It arrives from the release job as three argv strings, and a
   * `protocol` that came out as NaN would otherwise be serialized as `null` and
   * read by every machine that installs.
   */
  it('refuses an entry that is not one', () => {
    expect(() =>
      updateVersionsManifest({}, 'cli', { version: '1.0.0', protocol: Number('') }),
    ).toThrow();
    expect(() => updateVersionsManifest({}, 'cli', { version: 'latest', protocol: 1 })).toThrow();
  });

  /**
   * Sorted, so the file a release writes differs from the one before it in
   * exactly the lines that changed. This is the one artifact of a release a
   * person might look at on the branch.
   */
  it('sorts the components, so a release is a one-line diff', () => {
    const manifest = updateVersionsManifest(
      { web: { version: '1.1.0', protocol: 3 }, cli: { version: '1.4.0', protocol: 3 } },
      'hub',
      { version: '1.2.0', protocol: 3 },
    );

    expect(Object.keys(manifest)).toEqual(['cli', 'hub', 'web']);
  });
});

describe('serializeVersionsManifest', () => {
  it('writes indented JSON with a trailing newline, which is what a file on a branch is', () => {
    const text = serializeVersionsManifest({ cli: { version: '1.4.0', protocol: 3 } });

    expect(text).toBe('{\n  "cli": {\n    "version": "1.4.0",\n    "protocol": 3\n  }\n}\n');
  });

  /** Round trip: what a release writes is what the next release reads back. */
  it('produces something the parser accepts', () => {
    const manifest = parseVersionsManifest('versions.json', current);

    expect(parseVersionsManifest('versions.json', serializeVersionsManifest(manifest))).toEqual(
      manifest,
    );
  });
});
