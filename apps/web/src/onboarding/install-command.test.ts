import { describe, expect, it } from 'vitest';
import {
  INSTALL_SH_URL,
  installCommand,
  targetNotes,
  type InstallTarget,
} from './install-command.js';

const TARGETS: readonly InstallTarget[] = ['linux', 'macos', 'installed'];

describe('the install command this wizard offers', () => {
  /**
   * The literal, spelled out once here rather than derived, because a test that
   * built the URL the way the module builds it would agree with whatever the
   * module said. The other end of the tie is in the scripts suite, which reads
   * this module by path and holds it against the constant in `install.sh`; the
   * two together are what makes the script, the README and this screen one URL.
   */
  it('fetches the same URL the script and the README already print', () => {
    expect(INSTALL_SH_URL).toBe(
      'https://raw.githubusercontent.com/SoftieSolutions/agentplex/v1/scripts/install.sh',
    );
  });

  /**
   * One command for both platforms, because there is one: the script detects
   * the platform itself. What differs between Linux and macOS is what the run
   * leaves behind, and that is what `targetNotes` is for.
   */
  it('pipes the script to bash with the server role, on either platform', () => {
    const expected = `curl -fsSL ${INSTALL_SH_URL} | bash -s -- --role=server`;
    expect(installCommand('linux')).toBe(expected);
    expect(installCommand('macos')).toBe(expected);
  });

  it('runs setup, not the installer, on a machine that already has the bin', () => {
    expect(installCommand('installed')).toBe('agentplex setup --role=server');
  });

  /**
   * The mock this screen came from minted a token into the one-liner. The real
   * install mints its own on the machine it installs -- into that server's
   * identity file, printed nowhere -- so a command here that carried a secret
   * would be a command nobody could have produced. Nothing to fill in, and
   * nothing to leak into a shell history that means something to a stranger.
   */
  it('carries no token and no placeholder to substitute', () => {
    for (const target of TARGETS) {
      const command = installCommand(target);
      expect(command).not.toMatch(/token/i);
      expect(command).not.toMatch(/[<>]/);
      expect(command.trim()).toBe(command);
    }
  });

  /**
   * The note is the honest part of the tab. Each one says what that machine is
   * left holding, and the differences below are the ones a reader is bitten by
   * when the copy pretends the three paths are the same path.
   */
  it('tells a Linux reader that units are written and setup runs in front of them', () => {
    const notes = targetNotes('linux');
    expect(notes).toMatch(/systemd/i);
    expect(notes).toMatch(/unit/i);
    expect(notes).toMatch(/setup/i);
    expect(notes).toMatch(/terminal/i);
  });

  it('tells a macOS reader that no unit is written and names launchd instead', () => {
    const notes = targetNotes('macos');
    expect(notes).toMatch(/no systemd/i);
    expect(notes).toMatch(/launchd/i);
    // The script prints the daemon argv on that machine, because there is no
    // short command that starts a daemon; the note sends the reader to it
    // rather than inventing one here.
    expect(notes).toMatch(/prints/i);
  });

  it('tells a reader who already installed where the token they will need came from', () => {
    const notes = targetNotes('installed');
    expect(notes).toMatch(/setup/i);
    expect(notes).toMatch(/identity file/i);
  });

  it('gives every target a note, and none of them an emoji', () => {
    for (const target of TARGETS) {
      const notes = targetNotes(target);
      expect(notes.length).toBeGreaterThan(0);
      expect(notes).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});
