import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createFakeNetwork } from '../commands/update/fake-update-machine.js';
import {
  VERSIONS_DIRECTORY_VARIABLE,
  VERSIONS_URL,
  checkVersions,
  describeSource,
  manifestSource,
} from './version-check.js';

/**
 * Where the version manifest comes from, and what is made of it.
 *
 * The first case below is the tie to `install.sh`. The script reads the same
 * file with a bash grammar, because it runs before there is a Node on the
 * machine to read it with -- so the two parsers cannot be one, and what holds
 * them together is that they name the same URL and refuse the same shapes. The
 * schema itself is shared, in `@agentplex/release`, and tested there.
 */
const SCRIPT = readFileSync(
  fileURLToPath(new URL('../../../../scripts/install.sh', import.meta.url)),
  'utf8',
);

function declared(name: string): string {
  const found = new RegExp(`^readonly ${name}='([^']*)'$`, 'm').exec(SCRIPT)?.[1];
  expect(found, `install.sh declares no ${name}`).toBeDefined();
  return found ?? '';
}

const NOW = 1_800_000_000_000;

describe('where what is current is published', () => {
  it('is the URL install.sh resolves through', () => {
    expect(VERSIONS_URL).toBe(declared('VERSIONS_URL'));
  });

  /**
   * The seam `install.sh` calls `AGENTPLEX_VERSIONS`: a directory laid out as a
   * release is. It is what an air-gapped mirror uses and what keeps this
   * repository's end-to-end checks off the network, and it means the same thing
   * to both readers or it means nothing.
   */
  it('is a local directory when the machine names one, laid out as the release is', () => {
    const join = (directory: string, file: string): string => `${directory}/${file}`;

    expect(manifestSource({ [VERSIONS_DIRECTORY_VARIABLE]: '/srv/mirror' }, join)).toEqual({
      kind: 'file',
      path: '/srv/mirror/versions.json',
    });
    expect(SCRIPT).toContain('file="$AGENTPLEX_VERSIONS/versions.json"');
  });

  it('falls back to the release branch when the variable is absent or empty', () => {
    const join = (directory: string, file: string): string => `${directory}/${file}`;

    expect(manifestSource({}, join)).toEqual({ kind: 'url', url: VERSIONS_URL });
    expect(manifestSource({ [VERSIONS_DIRECTORY_VARIABLE]: '' }, join)).toEqual({
      kind: 'url',
      url: VERSIONS_URL,
    });
  });

  it('describes either source as the one line a report names it by', () => {
    expect(describeSource({ kind: 'url', url: VERSIONS_URL })).toBe(VERSIONS_URL);
    expect(describeSource({ kind: 'file', path: '/srv/x.json' })).toBe('/srv/x.json');
  });
});

describe('what is made of it', () => {
  const source = { kind: 'url', url: VERSIONS_URL } as const;

  async function check(served: Readonly<Record<string, string>>) {
    return checkVersions(source, { reader: createFakeNetwork({ served }), now: () => NOW });
  }

  it('reads the manifest and stamps it with the clock it was given', async () => {
    const checked = await check({
      [VERSIONS_URL]: '{"cli":{"version":"1.5.0","protocol":3}}',
    });

    expect(checked).toEqual({
      ok: true,
      manifest: { cli: { version: '1.5.0', protocol: 3 } },
      source: VERSIONS_URL,
      checkedAt: NOW,
    });
  });

  /**
   * The degrade that must not over-claim, and the one `install.sh` already
   * keeps about nodejs.org: an unreachable manifest is unknown, never up to
   * date.
   */
  it('says why it could not read one, naming where it looked', async () => {
    const checked = await check({});

    expect(checked.ok).toBe(false);
    expect(checked.ok === false && checked.problem).toContain(VERSIONS_URL);
  });

  it('refuses a manifest that is not one rather than carrying it forward', async () => {
    const checked = await check({ [VERSIONS_URL]: '{"cli":{"version":"latest","protocol":3}}' });

    expect(checked.ok).toBe(false);
  });

  /**
   * An empty manifest parses -- the first release of the first component has to
   * be able to write one -- and it answers nothing. Reporting it as a
   * successful check would give every component "could not check" with no
   * reason beside it, which reads as a broken machine rather than a file that
   * says nothing yet.
   */
  it('treats a manifest that names nobody as a check that did not answer', async () => {
    const checked = await check({ [VERSIONS_URL]: '{}' });

    expect(checked.ok).toBe(false);
    expect(checked.ok === false && checked.problem).toContain('names no component');
  });
});
