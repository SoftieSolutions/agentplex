import { describe, expect, it } from 'vitest';
import {
  currentRelease,
  parseReleaseProtocol,
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

const both = { client: 3, server: 3 } as const;

const current = JSON.stringify({
  cli: { current: '1.4.0', releases: { '1.4.0': {}, '1.3.0': {} } },
  hub: { current: '1.2.0', releases: { '1.2.0': both } },
  server: { current: '1.5.0', releases: { '1.5.0': { server: 3 } } },
  web: { current: '1.1.0', releases: { '1.1.0': both } },
});

describe('parseVersionsManifest', () => {
  it('reads what a previous release left behind', () => {
    expect(parseVersionsManifest('versions.json', current)['cli']).toEqual({
      current: '1.4.0',
      releases: { '1.4.0': {}, '1.3.0': {} },
    });
    expect(parseVersionsManifest('versions.json', current)['hub']).toEqual({
      current: '1.2.0',
      releases: { '1.2.0': { client: 3, server: 3 } },
    });
  });

  /**
   * Each leg is recorded by the packages that speak it and by no other: the
   * CLI speaks neither, the server only its own. An absent leg is "this release
   * does not speak it", which is a different fact from any number.
   */
  it('reads a release that declares one leg, or none', () => {
    const manifest = parseVersionsManifest('versions.json', current);
    expect(manifest['server']?.releases['1.5.0']).toEqual({ server: 3 });
    expect(manifest['cli']?.releases['1.4.0']).toEqual({});
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
    ['an entry with no current version', '{"cli":{"releases":{"1.4.0":{}}}}'],
    ['the shape before this file carried history', '{"cli":{"version":"1.4.0","protocol":3}}'],
    ['a current version that is not one', '{"cli":{"current":"latest","releases":{"latest":{}}}}'],
    ['a partial current version', '{"cli":{"current":"1.4","releases":{"1.4":{}}}}'],
    ['a released version that is not one', '{"cli":{"current":"1.4.0","releases":{"1.4":{}}}}'],
    ['a release that is one bare number', '{"cli":{"current":"1.4.0","releases":{"1.4.0":3}}}'],
    ['a leg that is a string', '{"hub":{"current":"1.4.0","releases":{"1.4.0":{"client":"3"}}}}'],
    ['a leg of zero', '{"hub":{"current":"1.4.0","releases":{"1.4.0":{"server":0}}}}'],
    ['a leg nobody named', '{"hub":{"current":"1.4.0","releases":{"1.4.0":{"browser":3}}}}'],
    ['a field nobody listed', '{"cli":{"current":"1.4.0","releases":{"1.4.0":{}},"channel":"b"}}'],
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
      parseVersionsManifest('versions.json', '{"cli":{"current":"1.5.0","releases":{"1.4.0":{}}}}'),
    ).toThrow('versions.json');
  });

  /**
   * A prerelease is a version this publishes and records. The workflow decides
   * separately whether one may advance the `v1` *tree* -- it may not -- and
   * `updateVersionsManifest` decides that it is never `current`. What it is is
   * installable by name, which is the whole reason it is in the file.
   */
  it('accepts a prerelease version', () => {
    expect(
      parseVersionsManifest(
        'versions.json',
        '{"cli":{"current":"2.0.0-rc.1","releases":{"2.0.0-rc.1":{}}}}',
      ),
    ).toEqual({ cli: { current: '2.0.0-rc.1', releases: { '2.0.0-rc.1': {} } } });
  });
});

describe('currentRelease', () => {
  it('gives the version the entry calls current and the legs it speaks', () => {
    const entry = parseVersionsManifest('versions.json', current)['hub'];
    if (entry === undefined) throw new Error('the fixture names a hub');

    expect(currentRelease(entry)).toEqual({
      version: '1.2.0',
      protocol: { client: 3, server: 3 },
    });
  });
});

describe('updateVersionsManifest', () => {
  const v = (n: number) => ({ client: n, server: n });

  /** A tag releases one component, so a release knows one entry and inherits the rest. */
  it('appends to one component and leaves the others exactly as they were', () => {
    const previous = parseVersionsManifest('versions.json', current);

    const updated = updateVersionsManifest(previous, 'hub', { version: '1.3.0', protocol: v(3) });

    expect(updated['hub']).toEqual({
      current: '1.3.0',
      releases: { '1.3.0': v(3), '1.2.0': v(3) },
    });
    expect(updated['server']).toEqual({ current: '1.5.0', releases: { '1.5.0': { server: 3 } } });
    expect(previous['hub']).toEqual({ current: '1.2.0', releases: { '1.2.0': v(3) } });
  });

  /**
   * The legs move independently: a client-only change releases a hub whose
   * server leg is the one it had, and the file records exactly that.
   */
  it('records a release whose legs differ from each other', () => {
    const updated = updateVersionsManifest({}, 'hub', {
      version: '1.3.0',
      protocol: { client: 4, server: 3 },
    });

    expect(updated['hub']?.releases['1.3.0']).toEqual({ client: 4, server: 3 });
  });

  /** The CLI speaks neither leg, and its release says so by naming none. */
  it('records a release that speaks no leg', () => {
    const updated = updateVersionsManifest({}, 'cli', { version: '1.0.0', protocol: {} });

    expect(updated['cli']).toEqual({ current: '1.0.0', releases: { '1.0.0': {} } });
  });

  /**
   * The whole of what history is for. A patch to an older line is published
   * after the newer line exists, and the file has to keep both -- otherwise
   * `--role=hub@1.2` resolves to nothing the week after 1.3.0 ships.
   */
  it('keeps an older series when a patch to it is released after a newer one', () => {
    const previous = updateVersionsManifest({}, 'hub', { version: '1.3.0', protocol: v(3) });

    const updated = updateVersionsManifest(previous, 'hub', { version: '1.2.1', protocol: v(2) });

    expect(updated['hub']?.releases).toEqual({ '1.3.0': v(3), '1.2.1': v(2) });
  });

  /**
   * And it does not make that patch current. Every unpinned install on the
   * fleet reads this field, so a release to an older line that moved it would
   * downgrade all of them.
   */
  it('leaves current where it is when an older line is patched', () => {
    const previous = updateVersionsManifest({}, 'hub', { version: '1.3.0', protocol: v(3) });

    const updated = updateVersionsManifest(previous, 'hub', { version: '1.2.1', protocol: v(2) });

    expect(updated['hub']?.current).toBe('1.3.0');
  });

  /**
   * A prerelease is recorded so that `--role=hub@1.3.8-rc1` can be installed at
   * all -- the installer refuses a pin the manifest does not list -- and is
   * never made current, so nobody who asked for nothing in particular gets it.
   */
  it('records a prerelease without making it current', () => {
    const previous = updateVersionsManifest({}, 'hub', { version: '1.3.7', protocol: v(3) });

    const updated = updateVersionsManifest(previous, 'hub', {
      version: '1.3.8-rc1',
      protocol: v(3),
    });

    expect(updated['hub']).toEqual({
      current: '1.3.7',
      releases: { '1.3.8-rc1': v(3), '1.3.7': v(3) },
    });
  });

  /**
   * The one case where a prerelease is current: there is nothing else. `current`
   * is what an unpinned install takes and the schema will not let it be absent,
   * so the only release there is beats naming none -- and it stops being current
   * the moment anything else ships.
   */
  it('makes a prerelease current only while it is the only release', () => {
    const first = updateVersionsManifest({}, 'hub', { version: '1.0.0-rc.1', protocol: v(1) });
    expect(first['hub']?.current).toBe('1.0.0-rc.1');

    const second = updateVersionsManifest(first, 'hub', { version: '1.0.0', protocol: v(1) });
    expect(second['hub']?.current).toBe('1.0.0');
  });

  /** Build metadata carries a `-` of its own, and it is not a prerelease marker. */
  it('does not read a dash inside build metadata as a prerelease', () => {
    const manifest = updateVersionsManifest({}, 'hub', {
      version: '1.4.0+build-7',
      protocol: v(3),
    });

    expect(manifest['hub']?.current).toBe('1.4.0+build-7');
  });

  it('adds a component the manifest did not carry yet', () => {
    expect(
      Object.keys(updateVersionsManifest({}, 'cli', { version: '1.0.0', protocol: {} })),
    ).toEqual(['cli']);
  });

  /** A tag re-cut is one release published twice, not two. */
  it('writes the same version once when it is released again', () => {
    const previous = updateVersionsManifest({}, 'hub', { version: '1.0.0', protocol: v(1) });

    const updated = updateVersionsManifest(previous, 'hub', { version: '1.0.0', protocol: v(2) });

    expect(updated['hub']).toEqual({ current: '1.0.0', releases: { '1.0.0': v(2) } });
  });

  /**
   * The entry being written is checked too, and not only the file it is being
   * merged into. It arrives from the release job as argv strings, and a leg
   * that came out as NaN would otherwise be serialized as `null` and read by
   * every machine that installs.
   */
  it('refuses an entry that is not one', () => {
    expect(() =>
      updateVersionsManifest({}, 'hub', { version: '1.0.0', protocol: { client: Number('') } }),
    ).toThrow();
    expect(() =>
      updateVersionsManifest({}, 'hub', { version: 'latest', protocol: v(1) }),
    ).toThrow();
  });

  /**
   * Sorted, so the file a release writes differs from the one before it in
   * exactly the lines that changed. This is the one artifact of a release a
   * person might look at on the branch.
   */
  it('sorts the components, so a release is a one-line diff', () => {
    const manifest = updateVersionsManifest(
      {
        web: { current: '1.1.0', releases: { '1.1.0': v(3) } },
        cli: { current: '1.4.0', releases: { '1.4.0': {} } },
      },
      'hub',
      { version: '1.2.0', protocol: v(3) },
    );

    expect(Object.keys(manifest)).toEqual(['cli', 'hub', 'web']);
  });

  /**
   * By precedence and not by string, newest first: `1.3.10` is newer than
   * `1.3.9` and sorts above it, which no lexical ordering of these keys does.
   */
  it('sorts a component history newest first', () => {
    let manifest = updateVersionsManifest({}, 'hub', { version: '1.3.9', protocol: v(3) });
    manifest = updateVersionsManifest(manifest, 'hub', { version: '1.10.0', protocol: v(4) });
    manifest = updateVersionsManifest(manifest, 'hub', { version: '1.3.10', protocol: v(3) });

    expect(Object.keys(manifest['hub']?.releases ?? {})).toEqual(['1.10.0', '1.3.10', '1.3.9']);
  });
});

describe('serializeVersionsManifest', () => {
  it('writes indented JSON with a trailing newline, which is what a file on a branch is', () => {
    const text = serializeVersionsManifest({
      hub: { current: '1.4.0', releases: { '1.4.0': { client: 3, server: 2 } } },
    });

    expect(text).toBe(
      '{\n  "hub": {\n    "current": "1.4.0",\n    "releases": {\n      "1.4.0": {\n        "client": 3,\n        "server": 2\n      }\n    }\n  }\n}\n',
    );
  });

  /**
   * Client before server whatever order the release named them in, so a file
   * two releases wrote differs only where a number moved.
   */
  it('writes the legs in one order', () => {
    const manifest = updateVersionsManifest({}, 'hub', {
      version: '1.0.0',
      protocol: { server: 2, client: 3 },
    });

    expect(serializeVersionsManifest(manifest)).toContain(
      '"1.0.0": {\n        "client": 3,\n        "server": 2\n      }',
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

/**
 * The protocol a release job hands in, as the JSON text the workflow reads out
 * of the package's own manifest. It is argv, so it is a claim.
 */
describe('parseReleaseProtocol', () => {
  it('reads both legs, one, or none', () => {
    expect(parseReleaseProtocol('argv', '{"client":39,"server":38}')).toEqual({
      client: 39,
      server: 38,
    });
    expect(parseReleaseProtocol('argv', '{"server":39}')).toEqual({ server: 39 });
    expect(parseReleaseProtocol('argv', '{}')).toEqual({});
  });

  it.each([
    ['a bare number', '39'],
    ['a leg nobody named', '{"browser":39}'],
    ['a leg that is a string', '{"client":"39"}'],
    ['a leg of zero', '{"client":0}'],
    ['a fractional leg', '{"server":1.5}'],
    ['something that is not JSON', 'client=39'],
    ['an empty word', ''],
  ])('refuses %s, naming where it came from', (_name, text) => {
    expect(() => parseReleaseProtocol('the protocol argument', text)).toThrow(
      'the protocol argument',
    );
  });
});
