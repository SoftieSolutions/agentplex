import { describe, expect, it } from 'vitest';
import { compareVersions, isNewerVersion } from './version-order.js';

/**
 * Ordering two releases, which is the whole of what this package will say about
 * a version. The cases that matter are the ones a string compare gets wrong.
 */
describe('compareVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.3.0', '1.2.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.4')).toBeLessThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  /**
   * The case a lexical compare gets backwards, and the reason the numbers are
   * parsed rather than the strings compared: `10` sorts before `9` as text.
   */
  it('compares components as numbers and not as text', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0);
  });

  /** A release beats its own prereleases: the other case text gets backwards. */
  it('puts a prerelease before the release it belongs to', () => {
    expect(compareVersions('1.5.0-rc.1', '1.5.0')).toBeLessThan(0);
    expect(compareVersions('1.5.0', '1.5.0-rc.1')).toBeGreaterThan(0);
    expect(compareVersions('1.5.0-rc.1', '1.4.9')).toBeGreaterThan(0);
  });

  it('orders prerelease identifiers by semver rules', () => {
    expect(compareVersions('1.0.0-rc.9', '1.0.0-rc.10')).toBeLessThan(0);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
    expect(compareVersions('1.0.0-rc', '1.0.0-rc.1')).toBeLessThan(0);
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
  });

  /** semver says build metadata is not part of precedence. */
  it('ignores build metadata', () => {
    expect(compareVersions('1.2.3+build.1', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3+a', '1.2.3+b')).toBe(0);
  });

  /**
   * No opinion rather than an invented one. Both callers already have a
   * sentence for not knowing, because both already survive a manifest they
   * could not reach.
   */
  it.each([
    ['latest', '1.0.0'],
    ['1.2', '1.0.0'],
    ['1.2.3.4', '1.0.0'],
    ['v1.2.3', '1.0.0'],
    ['01.2.3', '1.0.0'],
    [' 1.2.3', '1.0.0'],
    ['1.2.3-', '1.0.0'],
    ['1.0.0', 'nonsense'],
  ])('refuses to compare %s with %s', (left, right) => {
    expect(compareVersions(left, right)).toBeNull();
  });
});

describe('isNewerVersion', () => {
  it('is the question the update notice asks', () => {
    expect(isNewerVersion('1.5.0', '1.4.0')).toBe(true);
    expect(isNewerVersion('1.4.0', '1.4.0')).toBe(false);
    expect(isNewerVersion('1.3.0', '1.4.0')).toBe(false);
  });

  /** Something that cannot be compared is not something newer. */
  it('says no when it cannot tell', () => {
    expect(isNewerVersion('latest', '1.4.0')).toBe(false);
  });
});
