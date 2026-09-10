import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createNodeProgramResolver } from './node-program-resolver.js';
import { createMarkerProgram, createProbeProgram, type ProbeProgram } from './probe-program.js';

/**
 * A real directory search, against a real disk.
 *
 * The seam exists so nothing else has to touch a filesystem; this is the one
 * test that has to, because what is being checked is exactly what the disk says
 * — a mode bit, a directory wearing a program's name, an entry that is not
 * there. A fake would only ever answer what its author already believed.
 *
 * The programs are made rather than borrowed, for the reason `probe-program.ts`
 * gives: a name no PATH entry on this machine holds can only have been found in
 * the directory the test built.
 */

const made: ProbeProgram[] = [];

function program(name?: string): ProbeProgram {
  const created = name === undefined ? createProbeProgram() : createProbeProgram(name);
  made.push(created);
  return created;
}

/** A directory that holds something by that name which is not a program. */
function decoy(name: string, kind: 'directory' | 'unreadable-mode'): string {
  const directory = mkdtempSync(join(tmpdir(), 'agentplex-decoy-'));
  const path = join(directory, name);
  if (kind === 'directory') mkdirSync(path);
  else writeFileSync(path, 'not a program', { encoding: 'utf8', mode: 0o644 });
  made.push({ directory, name, remove: () => rmSync(directory, { recursive: true, force: true }) });
  return directory;
}

afterAll(() => {
  for (const created of made) created.remove();
});

describe('createNodeProgramResolver', () => {
  it('names the directory a program was found in', async () => {
    const probe = program();

    const resolver = createNodeProgramResolver([probe.directory]);

    expect(await resolver.resolve(probe.name)).toBe(probe.directory);
  });

  it('answers null when nothing on the search path holds it', async () => {
    // The case the whole preflight exists for: on a pty this is a session that
    // starts and dies, so it has to become a word before anybody taps start.
    const probe = program();

    const resolver = createNodeProgramResolver([]);

    expect(await resolver.resolve(probe.name)).toBeNull();
  });

  it('takes the first directory that holds it, as a spawn will', async () => {
    const first = createMarkerProgram('agentplex-twice', 'first');
    const second = createMarkerProgram('agentplex-twice', 'second');
    made.push(first, second);

    const resolver = createNodeProgramResolver([first.directory, second.directory]);

    expect(await resolver.resolve('agentplex-twice')).toBe(first.directory);
  });

  it('does not report a directory wearing the program name as a program', async () => {
    // Every directory on a PATH is executable, so an access check alone would
    // report this one and name a directory no spawn will ever resolve from.
    const probe = program();
    const wrong = decoy(probe.name, 'directory');

    const resolver = createNodeProgramResolver([wrong, probe.directory]);

    expect(await resolver.resolve(probe.name)).toBe(probe.directory);
  });

  it('does not report a file this process may not run', async () => {
    const probe = program();
    const wrong = decoy(probe.name, 'unreadable-mode');

    const resolver = createNodeProgramResolver([wrong, probe.directory]);

    expect(await resolver.resolve(probe.name)).toBe(probe.directory);
  });

  it('lets a directory that is not there cost itself and not the search', async () => {
    const probe = program();

    const resolver = createNodeProgramResolver(['/nonexistent-agentplex-bin', probe.directory]);

    expect(await resolver.resolve(probe.name)).toBe(probe.directory);
  });
});
