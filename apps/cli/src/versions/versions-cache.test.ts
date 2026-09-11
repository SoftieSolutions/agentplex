import { describe, expect, it } from 'vitest';
import {
  CACHE_MAX_AGE_MS,
  describeAge,
  isStale,
  parseCachedVersions,
  serializeCachedVersions,
  versionsCacheDirectory,
  versionsCacheFile,
} from './versions-cache.js';

/**
 * The file the notice reads and `update --check` writes.
 *
 * Two things are worth asserting about it and both are about degrading: where
 * it goes on a machine that runs this command as more than one identity, and
 * what happens to a file that is there and is not a cache.
 */

describe('where the cache lives', () => {
  /**
   * Per-identity, and deliberately not under the prefix. A `--system` machine
   * runs this command as root, as the service account and as an operator; the
   * prefix is writable by one of them, and a cache one identity cannot write is
   * a notice that is either an error or a lie for that identity.
   */
  it('goes under the running user cache directory', () => {
    expect(versionsCacheFile({ HOME: '/home/alice' })).toBe(
      '/home/alice/.cache/agentplex/versions.json',
    );
  });

  it('follows XDG_CACHE_HOME when the machine sets one', () => {
    expect(versionsCacheFile({ HOME: '/home/alice', XDG_CACHE_HOME: '/var/cache/alice' })).toBe(
      '/var/cache/alice/agentplex/versions.json',
    );
  });

  /**
   * `null` rather than a path under `/` or under wherever the operator was
   * standing: a cache written somewhere arbitrary is litter nothing will clean
   * up, and a machine with no home does without a notice.
   */
  it('has nowhere to put one when there is no home', () => {
    expect(versionsCacheFile({})).toBeNull();
    expect(versionsCacheFile({ HOME: '' })).toBeNull();
  });

  it('names the directory that has to be made first', () => {
    expect(versionsCacheDirectory('/home/alice/.cache/agentplex/versions.json')).toBe(
      '/home/alice/.cache/agentplex',
    );
  });
});

describe('reading one back', () => {
  const written = serializeCachedVersions({
    checkedAt: 1_800_000_000_000,
    source: 'https://example.invalid/versions.json',
    manifest: { cli: { version: '1.5.0', protocol: 3 } },
  });

  it('round trips what was written', () => {
    expect(parseCachedVersions(written)).toEqual({
      checkedAt: 1_800_000_000_000,
      source: 'https://example.invalid/versions.json',
      manifest: { cli: { version: '1.5.0', protocol: 3 } },
    });
  });

  /**
   * A file this program wrote is still a file off a disk: truncated by a full
   * disk, edited by somebody curious, or left by an older version of this
   * command. Each is a machine with no cached answer rather than a crash in the
   * middle of an unrelated command.
   */
  it.each([
    ['something that is not JSON', 'not json'],
    ['a cache with no timestamp', '{"source":"x","manifest":{}}'],
    ['a timestamp that is not one', '{"checkedAt":"yesterday","source":"x","manifest":{}}'],
    ['a manifest that is not one', '{"checkedAt":1,"source":"x","manifest":{"cli":"1.5.0"}}'],
    [
      'a version that is not one',
      '{"checkedAt":1,"source":"x","manifest":{"cli":{"version":"latest","protocol":3}}}',
    ],
  ])('refuses %s', (_name, text) => {
    expect(parseCachedVersions(text)).toBeNull();
  });
});

describe('how old it is', () => {
  it('is stale a day after it was written, and not before', () => {
    const cached = {
      checkedAt: 1000,
      source: 'x',
      manifest: { cli: { version: '1.5.0', protocol: 3 } },
    };

    expect(isStale(cached, 1000 + CACHE_MAX_AGE_MS - 1)).toBe(false);
    expect(isStale(cached, 1000 + CACHE_MAX_AGE_MS)).toBe(true);
  });

  /** A stale answer is labelled with its age, in the words a person uses. */
  it('says the age in the largest unit that is not zero', () => {
    expect(describeAge(0)).toBe('just now');
    expect(describeAge(59_000)).toBe('just now');
    expect(describeAge(60_000)).toBe('1 minute ago');
    expect(describeAge(3 * 60_000)).toBe('3 minutes ago');
    expect(describeAge(60 * 60_000)).toBe('1 hour ago');
    expect(describeAge(26 * 60 * 60_000)).toBe('1 day ago');
    expect(describeAge(3 * 24 * 60 * 60_000)).toBe('3 days ago');
  });

  /**
   * A clock that moved backwards, or a cache copied from another machine. The
   * direction that does not over-claim is to say nothing rather than to print a
   * negative age -- and it only looks fresher than it is where the alternative
   * is nonsense.
   */
  it('reports a cache stamped in the future as just now', () => {
    expect(describeAge(-60_000)).toBe('just now');
  });
});
