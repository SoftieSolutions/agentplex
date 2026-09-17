import { assertNever } from '@agentplex/protocol';

/**
 * What the wizard offers a reader who has no server yet: the command that
 * installs one, and what that command leaves behind on the machine it ran on.
 *
 * Data, not a component. The three tabs this feeds are three answers to one
 * question -- what is in front of you -- and keeping the answers here means the
 * panel that draws them holds no prose, and a test can hold the prose against
 * the script that has to make it true.
 *
 * Two things this deliberately does not do. It mints nothing: the design this
 * came from put a token in the one-liner, and the real install has no token to
 * put there, because the server mints its own into its identity file on the
 * machine it installs. And it names no third platform. Docker and CI were
 * dropped rather than written honestly, and a tab that offered a command
 * nobody had run would be the worst kind of help.
 */

/**
 * The script, at the ref the release workflow moves.
 *
 * The same string as `INSTALL_SH_URL` in `scripts/install.sh` and the fetch
 * printed in `apps/cli/README.md`, and it is one string in three places rather
 * than three strings because the scripts suite reads this file by path and
 * refuses to pass on a copy that has drifted. It lives in exactly one module on
 * this side, so there is one line to change the day the short alias is
 * registered.
 */
export const INSTALL_SH_URL =
  'https://raw.githubusercontent.com/SoftieSolutions/agentplex/v1/scripts/install.sh';

/** What the reader says is in front of them. */
export type InstallTarget =
  /** A Linux box: the whole install, units and all. */
  | 'linux'
  /** A Mac: the same install, and nothing to keep the process up. */
  | 'macos'
  /** A machine that already has the bin, from this script or from npm. */
  | 'installed';

/** The command for that machine, in one line, ready to copy. */
export function installCommand(target: InstallTarget): string {
  switch (target) {
    // One command for both, because the script detects the platform itself.
    // Offering two spellings of the same line would invite the reader to
    // believe the difference is in what they type, when it is in what the run
    // is able to leave behind.
    case 'linux':
    case 'macos':
      return `curl -fsSL ${INSTALL_SH_URL} | bash -s -- --role=server`;
    // Downloading an installer onto a machine that has the thing installed is
    // how a version gets replaced by accident. What is missing on such a
    // machine is the identity file and the settings, and setup is what writes
    // those.
    case 'installed':
      return 'agentplex setup --role=server';
    default:
      return assertNever(target, 'install target');
  }
}

/**
 * What the reader is left holding once that command has run.
 *
 * The three differ in the one place it costs something not to know: whether
 * anything on that machine will start the server again. Copy that said "it is
 * installed" for all three would be true and would leave a Mac owner with a
 * process that dies with their terminal.
 */
export function targetNotes(target: InstallTarget): string {
  switch (target) {
    case 'linux':
      return (
        'The script installs the Node runtime, the toolchain if this machine needs one, and the ' +
        'server package, then writes systemd user units and leaves them stopped. Setup runs from ' +
        'the same terminal straight after -- it is handed the tty the pipe would otherwise have ' +
        'taken -- and fills in what the units need before anything starts.'
      );
    case 'macos':
      return (
        'The same script installs on a Mac, and stops short of keeping it running: there is no ' +
        'systemd here, so no unit is written and nothing will start the server for you. It prints ' +
        'the daemon command at the end instead, and that line is what you hand to launchd.'
      );
    case 'installed':
      return (
        'Setup is the part that is missing: it mints this server its identity file ' +
        '(~/.agentplex/server.json by default) and writes the settings the daemon reads. The ' +
        'pairing token you will need on the previous screen is in that file, and setup shows it ' +
        'nowhere, so read it there.'
      );
    default:
      return assertNever(target, 'install target');
  }
}
