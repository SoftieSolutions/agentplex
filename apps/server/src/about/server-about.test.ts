import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLogger, type LogRecord } from '@agentplex/node-shared';
import { createFakeProcessRunner, printed } from '@agentplex/providers/testing';
import { readServerAbout, type AboutSources } from './server-about.js';

/** Captured: see `os-release.test.ts` and `operations/os-name.test.ts` for where from. */
const SW_VERS = readFileSync(
  join(import.meta.dirname, '..', 'operations', 'fixtures', 'sw-vers-macos.txt'),
  'utf8',
);
const DEBIAN = readFileSync(
  join(import.meta.dirname, 'fixtures', 'os-release-debian-12.txt'),
  'utf8',
);

const MANIFEST = '/opt/agentplex/package.json';
/** The manifest `assemble-package.ts` writes, trimmed to the fields this reads past. */
const RELEASED = JSON.stringify({ name: '@softiesolutions/agentplex-server', version: '2.0.3' });

/**
 * A disk holding exactly the files named, answering ENOENT for every other
 * path the way `readFile` does, and remembering what was asked for.
 */
function disk(files: Readonly<Record<string, string>>) {
  const reads: string[] = [];
  return {
    reads,
    readFile: (path: string): Promise<string> => {
      reads.push(path);
      const text = files[path];
      if (text === undefined) {
        return Promise.reject(
          Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
            code: 'ENOENT',
          }),
        );
      }
      return Promise.resolve(text);
    },
  };
}

function sources(overrides: Partial<AboutSources> & Pick<AboutSources, 'platform'>): {
  sources: AboutSources;
  records: LogRecord[];
} {
  const records: LogRecord[] = [];
  return {
    records,
    sources: {
      kernel: { type: 'Darwin', release: '25.6.0' },
      runner: createFakeProcessRunner(),
      readFile: disk({ [MANIFEST]: RELEASED }).readFile,
      manifest: MANIFEST,
      logger: createLogger('info', (record) => records.push(record)),
      ...overrides,
    },
  };
}

describe('readServerAbout', () => {
  it("names a Mac by sw_vers's product name, and the daemon by its manifest", async () => {
    const runner = createFakeProcessRunner({ outcomes: { sw_vers: printed(SW_VERS) } });
    const files = disk({ [MANIFEST]: RELEASED });

    const about = await readServerAbout(
      sources({ platform: 'darwin', runner, readFile: files.readFile }).sources,
    );

    expect(about).toEqual({ os: 'macOS 26.6.2', daemonVersion: '2.0.3' });
    // Nothing on a Mac reads a Linux file.
    expect(files.reads).toEqual([MANIFEST]);
  });

  it("falls back to the kernel's name on a Mac whose sw_vers could not answer, and says so", async () => {
    const { sources: given, records } = sources({ platform: 'darwin' });

    const about = await readServerAbout(given);

    expect(about.os).toBe('Darwin 25.6.0');
    expect(records).toContainEqual(
      expect.objectContaining({ level: 'warn', message: 'naming this machine by its kernel' }),
    );
  });

  it("names a Linux machine by its distribution's os-release, and spawns nothing for it", async () => {
    const runner = createFakeProcessRunner();
    const files = disk({ [MANIFEST]: RELEASED, '/etc/os-release': DEBIAN });

    const about = await readServerAbout(
      sources({
        platform: 'linux',
        kernel: { type: 'Linux', release: '6.8.0' },
        runner,
        readFile: files.readFile,
      }).sources,
    );

    expect(about.os).toBe('Debian GNU/Linux 12 (bookworm)');
    expect(runner.requests).toEqual([]);
  });

  it('reads /usr/lib/os-release when /etc/os-release is absent', async () => {
    const files = disk({ [MANIFEST]: RELEASED, '/usr/lib/os-release': DEBIAN });

    const about = await readServerAbout(
      sources({
        platform: 'linux',
        kernel: { type: 'Linux', release: '6.8.0' },
        readFile: files.readFile,
      }).sources,
    );

    expect(about.os).toBe('Debian GNU/Linux 12 (bookworm)');
    expect(files.reads).toContain('/etc/os-release');
  });

  it("falls back to the kernel's name on a Linux machine with no readable os-release", async () => {
    const about = await readServerAbout(
      sources({ platform: 'linux', kernel: { type: 'Linux', release: '6.8.0' } }).sources,
    );

    expect(about.os).toBe('Linux 6.8.0');
  });

  it('names any other platform by its kernel, without a spawn or a read', async () => {
    const runner = createFakeProcessRunner();
    const files = disk({ [MANIFEST]: RELEASED });

    const about = await readServerAbout(
      sources({
        platform: 'freebsd',
        kernel: { type: 'FreeBSD', release: '14.1-RELEASE' },
        runner,
        readFile: files.readFile,
      }).sources,
    );

    expect(about.os).toBe('FreeBSD 14.1-RELEASE');
    expect(runner.requests).toEqual([]);
    expect(files.reads).toEqual([MANIFEST]);
  });

  it('says nothing about the os rather than send a kernel name the wire would refuse', async () => {
    const about = await readServerAbout(
      sources({ platform: 'freebsd', kernel: { type: '', release: '' } }).sources,
    );

    expect(about.os).toBeNull();
  });

  it('says nothing about the version when the manifest cannot be read, and never "unknown"', async () => {
    const cases: readonly (Readonly<Record<string, string>> | null)[] = [
      {},
      { [MANIFEST]: 'not json' },
      { [MANIFEST]: JSON.stringify({ name: 'agentplex' }) },
      { [MANIFEST]: JSON.stringify({ version: '' }) },
      { [MANIFEST]: JSON.stringify({ version: 'x'.repeat(33) }) },
      { [MANIFEST]: JSON.stringify(['2.0.3']) },
    ];
    for (const files of cases) {
      const { sources: given, records } = sources({
        platform: 'freebsd',
        kernel: { type: 'FreeBSD', release: '14.1-RELEASE' },
        readFile: disk(files ?? {}).readFile,
      });

      const about = await readServerAbout(given);

      expect(about.daemonVersion, JSON.stringify(files)).toBeNull();
      expect(records).toContainEqual(
        expect.objectContaining({ level: 'warn', message: 'this server cannot name its version' }),
      );
    }
  });
});
