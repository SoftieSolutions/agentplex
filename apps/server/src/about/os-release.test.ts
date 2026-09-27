import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { osReleaseName } from './os-release.js';

/**
 * The fixtures are `/etc/os-release` exactly as three distributions ship it,
 * captured with `docker run --rm <image> cat /etc/os-release` from
 * `debian:bookworm-slim`, `ubuntu:24.04` and `alpine:3.20`. They differ in the
 * ways that matter to a parser: Debian and Ubuntu quote every value that has a
 * space in it, Alpine leaves `VERSION_ID` bare, and Alpine puts `NAME` first
 * and `PRETTY_NAME` fourth where the other two put it first.
 *
 * The cases no captured file shows -- a distribution with no `PRETTY_NAME`, a
 * value in single quotes -- are derived from these by editing one line, so
 * every other line under test is still one a distribution wrote.
 */
function fixture(name: string): string {
  return readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
}

const DEBIAN = fixture('os-release-debian-12.txt');
const UBUNTU = fixture('os-release-ubuntu-24.04.txt');
const ALPINE = fixture('os-release-alpine-3.20.txt');

function withoutKey(text: string, key: string): string {
  return text
    .split('\n')
    .filter((line) => !line.startsWith(`${key}=`))
    .join('\n');
}

function replacingKey(text: string, key: string, line: string): string {
  return text
    .split('\n')
    .map((original) => (original.startsWith(`${key}=`) ? line : original))
    .join('\n');
}

describe('osReleaseName', () => {
  it('takes PRETTY_NAME, which is the name the distribution wants shown', () => {
    expect(osReleaseName(DEBIAN)).toBe('Debian GNU/Linux 12 (bookworm)');
    expect(osReleaseName(UBUNTU)).toBe('Ubuntu 24.04.5 LTS');
    expect(osReleaseName(ALPINE)).toBe('Alpine Linux v3.20');
  });

  it('falls back to NAME and VERSION_ID, quoted or bare, when there is no PRETTY_NAME', () => {
    expect(osReleaseName(withoutKey(DEBIAN, 'PRETTY_NAME'))).toBe('Debian GNU/Linux 12');
    expect(osReleaseName(withoutKey(ALPINE, 'PRETTY_NAME'))).toBe('Alpine Linux 3.20.10');
  });

  it('names a distribution with no version by its name alone, as a rolling release is', () => {
    const rolling = withoutKey(withoutKey(DEBIAN, 'PRETTY_NAME'), 'VERSION_ID');

    expect(osReleaseName(rolling)).toBe('Debian GNU/Linux');
  });

  it('reads single quotes and the escapes the format allows inside double quotes', () => {
    expect(osReleaseName(replacingKey(DEBIAN, 'PRETTY_NAME', "PRETTY_NAME='Debian 12'"))).toBe(
      'Debian 12',
    );
    expect(
      osReleaseName(replacingKey(DEBIAN, 'PRETTY_NAME', 'PRETTY_NAME="Debian \\"12\\" \\$x"')),
    ).toBe('Debian "12" $x');
  });

  it('ignores comments and blank lines', () => {
    expect(osReleaseName(`# written by hand\n\n${ALPINE}`)).toBe('Alpine Linux v3.20');
  });

  it('passes over a PRETTY_NAME the wire would refuse and uses NAME and VERSION_ID', () => {
    const long = replacingKey(DEBIAN, 'PRETTY_NAME', `PRETTY_NAME="${'Debian '.repeat(12)}"`);
    const escaped = replacingKey(DEBIAN, 'PRETTY_NAME', 'PRETTY_NAME="Debian \u001b[2J"');

    expect(osReleaseName(long)).toBe('Debian GNU/Linux 12');
    expect(osReleaseName(escaped)).toBe('Debian GNU/Linux 12');
  });

  it('says nothing for a file that names no distribution', () => {
    expect(osReleaseName('')).toBeNull();
    expect(osReleaseName(withoutKey(withoutKey(DEBIAN, 'PRETTY_NAME'), 'NAME'))).toBeNull();
    // An unterminated quote is a line this cannot read, not a name.
    expect(
      osReleaseName(withoutKey(replacingKey(DEBIAN, 'PRETTY_NAME', 'PRETTY_NAME="Debian'), 'NAME')),
    ).toBeNull();
  });
});
