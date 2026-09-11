import { describe, expect, it } from 'vitest';
import {
  CLI_PACKAGE,
  DAEMONS as PACKAGED_DAEMONS,
  HUB_PACKAGE,
  PACKAGES,
  SERVER_PACKAGE,
  WEB_PACKAGE,
} from '../../../../scripts/assemble-package.js';
import { COMPONENTS, COMPONENT_PACKAGES, daemonEntrypoint, daemonPackage } from './components.js';

/**
 * The component table, held against the assembler's own.
 *
 * `status` reads a manifest out of `<prefix>/lib/node_modules/<name>`, so a
 * rename on the publishing side and not here is a command that reports every
 * package on a correctly installed machine as absent -- a green install and a
 * report that says nothing is on it. `install.sh.integration.test.ts` holds the
 * script's copy of this table against the same source, and this is the third
 * reader doing the same thing.
 *
 * A test may reach across into the repository's tooling where the shipped
 * program may not: tests are excluded from the build, and `programs.test.ts`
 * already argues it.
 */
describe('the components', () => {
  it('name the packages the assembler publishes, and all four of them', () => {
    expect(COMPONENT_PACKAGES).toEqual({
      cli: CLI_PACKAGE,
      hub: HUB_PACKAGE,
      server: SERVER_PACKAGE,
      web: WEB_PACKAGE,
    });
    expect([...COMPONENTS].sort()).toEqual(PACKAGES.map((target) => target.component).sort());
  });

  it('hold a daemon package for every daemon the assembler ships, and for nothing else', () => {
    for (const daemon of PACKAGED_DAEMONS) expect(daemonPackage(daemon)).not.toBeNull();
    // `cli` holds no daemon and `web` is static files. A lookup that fell
    // through would send the foreground command at a file that is not there.
    for (const notADaemon of ['cli', 'web', 'hubb', '']) {
      expect(daemonPackage(notADaemon)).toBeNull();
    }
  });

  it('name the entry inside a package the way the unit files do', () => {
    // The installer's `daemon_command` builds exactly this, and the container
    // check greps for the whole ExecStart line. The layout inside a published
    // package is the workspace's, so one expression is right everywhere.
    expect(daemonEntrypoint('hub')).toBe('apps/hub/dist/main.js');
    expect(daemonEntrypoint('server')).toBe('apps/server/dist/main.js');
  });
});
