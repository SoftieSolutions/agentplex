import type { ProgramResolver } from '@agentplex/providers';
import type { Installation } from '../../installation/installation.js';
import type { RuntimePlatform } from './runtime.js';

/**
 * Whether npm will be able to build what this machine is about to install,
 * asked before anything is stopped.
 *
 * node-pty ships no Linux prebuild, so npm compiles it from source, and
 * node-gyp needs python3, make and a C++ compiler. It is a *required*
 * dependency of the server package -- deliberately, so that an npm which cannot
 * compile it fails the install rather than finishing without it -- which means
 * a server machine with no compiler is a machine where `npm install` is going
 * to fail.
 *
 * The point of asking first is the ordering. By the time npm runs, this command
 * has stopped the daemons; a compile that fails there leaves a machine with its
 * services down, its old packages half replaced and an operator reading
 * node-gyp's output. Asked here, the same machine is a refusal with nothing
 * touched and the package list to install.
 *
 * It only asks. `install.sh` installs the toolchain, because it runs as -- or
 * escalates to -- root at the moment somebody is setting the machine up, and
 * `agentplex update` is typed by whoever runs the daemons. A command that
 * reached for `sudo apt-get` in the middle of an update would be asking for a
 * password at an unpredictable moment, on a machine whose services it had just
 * stopped.
 */

/** The one component whose package requires the compiler. */
const NEEDS_A_COMPILER = 'server';

/** What node-gyp needs, in the package names each manager has for them. */
export const TOOLCHAIN_PACKAGES: Readonly<Record<string, string>> = {
  'apt-get': 'python3 make g++',
  dnf: 'python3 make gcc-c++',
  yum: 'python3 make gcc-c++',
  apk: 'python3 make g++',
};

/** The programs themselves, which is what is actually looked for. */
const REQUIRED = ['python3', 'make'] as const;

/** Any one of these is a C++ compiler as far as node-gyp is concerned. */
const COMPILERS = ['c++', 'g++', 'clang++'] as const;

export type Preflight =
  | { readonly ok: true; readonly lines: readonly string[] }
  | { readonly ok: false; readonly lines: readonly string[] };

export async function preflightToolchain(
  installation: Installation,
  platform: RuntimePlatform,
  programs: ProgramResolver,
): Promise<Preflight> {
  const server = installation.packages.find((one) => one.component === NEEDS_A_COMPILER);
  if (server === undefined || server.state !== 'installed') {
    return {
      ok: true,
      lines: ['toolchain   not needed: no package on this machine carries node-pty'],
    };
  }

  if (platform !== 'linux') {
    // node-pty's prebuilds cover macOS, so there is nothing to compile and
    // nothing to look for. If a prebuild is ever missing, npm's own error says
    // `xcode-select --install`, which is better than anything guessed here.
    return { ok: true, lines: ['toolchain   not needed on macOS (node-pty ships a prebuild)'] };
  }

  const missing: string[] = [];
  for (const program of REQUIRED) {
    if ((await programs.resolve(program)) === null) missing.push(program);
  }
  let compiler = false;
  for (const program of COMPILERS) {
    if ((await programs.resolve(program)) !== null) compiler = true;
  }
  if (!compiler) missing.push(COMPILERS.join(' or '));

  if (missing.length === 0) {
    return {
      ok: true,
      lines: ['toolchain   present, and node-pty must build or npm fails this install'],
    };
  }

  return {
    ok: false,
    lines: [
      `This machine runs a server, so npm compiles node-pty, and ${missing.join(', ')} ` +
        'is not here.',
      'Install the toolchain and run this again. Nothing has been stopped or replaced:',
      ...Object.entries(TOOLCHAIN_PACKAGES).map(
        ([manager, packages]) => `  ${manager.padEnd(8)} ${packages}`,
      ),
    ],
  };
}
