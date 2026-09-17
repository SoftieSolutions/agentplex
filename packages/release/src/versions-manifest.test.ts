import { describe, expect, it } from 'vitest';
import {
  currentRelease,
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
  cli: { current: '1.4.0', releases: { '1.4.0': 3, '1.3.0': 2 } },
  hub: { current: '1.2.0', releases: { '1.2.0': 3 } },
  server: { current: '1.5.0', releases: { '1.5.0': 3 } },
  web: { current: '1.1.0', releases: { '1.1.0': 3 } },
});

describe('parseVersionsManifest', () => {
  it('reads what a previous release left behind', () => {
    expect(parseVersionsManifest('versions.json', current)['cli']).toEqual({
      current: '1.4.0',
      releases: { '1.4.0': 3, '1.3.0': 2 },
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
    ['an entry with no releases', '{"cli":{"current":"1.4.0"}}'],
    ['an entry with no current version', '{"cli":{"releases":{"1.4.0":3}}}'],
    ['the shape before this file carried history', '{"cli":{"version":"1.4.0","protocol":3}}'],
    ['a current version that is not one', '{"cli":{"current":"latest","releases":{"latest":3}}}'],
    ['a partial current version', '{"cli":{"current":"1.4","releases":{"1.4":3}}}'],
    ['a released version that is not one', '{"cli":{"current":"1.4.0","releases":{"1.4":3}}}'],
    ['a protocol that is a string', '{"cli":{"current":"1.4.0","releases":{"1.4.0":"3"}}}'],
    ['a protocol of zero', '{"cli":{"current":"1.4.0","releases":{"1.4.0":0}}}'],
    ['a field nobody listed', '{"cli":{"current":"1.4.0","releases":{"1.4.0":3},"channel":"b"}}'],
  ])('refuses %s', (_name, text) => {
    expect(() => parseVersionsManifest('versions.json', text)).toThrow();
  });

  /**
   * The invariant that makes the file answerable in one read. A manifest
   * calling a version current and listing no protocol for it is a `v1` branch
   * somebody hand-edited, and every machine that installs would read it.
   */
  it('refuses an entry whose current version is not one of its releases', () => {
    expect(() =>
      parseVersionsManifest('versions.json', '{"cli":{"current":"1.5.0","releases":{"1.4.0":3}}}'),
    ).toThrow('versions.json');
  });

  /**
   * A prerelease is a version this can publish -- the workflow decides
   * separately whether a prerelease should advance `v1` at all -- so the
   * parser has no business refusing one. `install.sh` is where a prerelease is
   * excluded, and only from a *partial* pin's candidates.
   */
  it('accepts a prerelease version', () => {
    expect(
      parseVersionsManifest(
        'versions.json',
        '{"cli":{"current":"2.0.0-rc.1","releases":{"2.0.0-rc.1":4}}}',
      ),
    ).toEqual({ cli: { current: '2.0.0-rc.1', releases: { '2.0.0-rc.1': 4 } } });
  });
});

describe('currentRelease', () => {
  it('gives the version the entry calls current and the protocol it speaks', () => {
    const entry = parseVersionsManifest('versions.json', current)['cli'];
    if (entry === undefined) throw new Error('the fixture names a cli');

    expect(currentRelease(entry)).toEqual({ version: '1.4.0', protocol: 3 });
  });
});

describe('updateVersionsManifest', () => {
  /** A tag releases one component, so a release knows one entry and inherits the rest. */
  it('appends to one component and leaves the others exactly as they were', () => {
    const previous = parseVersionsManifest('versions.json', current);

    const updated = updateVersionsManifest(previous, 'hub', { version: '1.3.0', protocol: 3 });

    expect(updated['hub']).toEqual({ current: '1.3.0', releases: { '1.3.0': 3, '1.2.0': 3 } });
    expect(updated['server']).toEqual({ current: '1.5.0', releases: { '1.5.0': 3 } });
    expect(previous['hub']).toEqual({ current: '1.2.0', releases: { '1.2.0': 3 } });
  });

  /**
   * The whole of what history is for. A patch to an older line is published
   * after the newer line exists, and the file has to keep both -- otherwise
   * `--role=hub@1.2` resolves to nothing the week after 1.3.0 ships.
   */
  it('keeps an older series when a patch to it is released after a newer one', () => {
    const previous = updateVersionsManifest({}, 'hub', { version: '1.3.0', protocol: 3 });

    const updated = updateVersionsManifest(previous, 'hub', { version: '1.2.1', protocol: 2 });

    expect(updated['hub']).toEqual({ current: '1.2.1', releases: { '1.3.0': 3, '1.2.1': 2 } });
  });

  it('adds a component the manifest did not carry yet', () => {
    expect(
      Object.keys(updateVersionsManifest({}, 'cli', { version: '1.0.0', protocol: 1 })),
    ).toEqual(['cli']);
  });

  /** A tag re-cut is one release published twice, not two. */
  it('writes the same version once when it is released again', () => {
    const previous = updateVersionsManifest({}, 'cli', { version: '1.0.0', protocol: 1 });

    const updated = updateVersionsManifest(previous, 'cli', { version: '1.0.0', protocol: 2 });

    expect(updated['cli']).toEqual({ current: '1.0.0', releases: { '1.0.0': 2 } });
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
      {
        web: { current: '1.1.0', releases: { '1.1.0': 3 } },
        cli: { current: '1.4.0', releases: { '1.4.0': 3 } },
      },
      'hub',
      { version: '1.2.0', protocol: 3 },
    );

    expect(Object.keys(manifest)).toEqual(['cli', 'hub', 'web']);
  });

  /**
   * By precedence and not by string, newest first: `1.3.10` is newer than
   * `1.3.9` and sorts above it, which no lexical ordering of these keys does.
   */
  it('sorts a component history newest first', () => {
    let manifest = updateVersionsManifest({}, 'hub', { version: '1.3.9', protocol: 3 });
    manifest = updateVersionsManifest(manifest, 'hub', { version: '1.10.0', protocol: 4 });
    manifest = updateVersionsManifest(manifest, 'hub', { version: '1.3.10', protocol: 3 });

    expect(Object.keys(manifest['hub']?.releases ?? {})).toEqual(['1.10.0', '1.3.10', '1.3.9']);
  });
});

describe('serializeVersionsManifest', () => {
  it('writes indented JSON with a trailing newline, which is what a file on a branch is', () => {
    const text = serializeVersionsManifest({
      cli: { current: '1.4.0', releases: { '1.4.0': 3 } },
    });

    expect(text).toBe(
      '{\n  "cli": {\n    "current": "1.4.0",\n    "releases": {\n      "1.4.0": 3\n    }\n  }\n}\n',
    );
  });

  /** Round trip: what a release writes is what the next release reads back. */
  it('produces something the parser accepts', () => {
    const manifest = parseVersionsManifest('versions.json', current);

    expect(parseVersionsManifest('versions.json', serializeVersionsManifest(manifest))).toEqual(
      manifest,
    );
  });
});
