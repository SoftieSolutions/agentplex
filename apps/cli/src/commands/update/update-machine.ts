import type { WriteMachine } from '../../installation/write-machine.js';

/**
 * The disk as `agentplex update` needs it, which is the write seam `install`
 * shares, plus the one question only an update asks a person.
 *
 * Kept apart from `WriteMachine` because `install` has nobody to ask: its
 * runtime is `install.sh`'s, and every other decision it makes is a flag.
 */
export interface UpdateMachine extends WriteMachine {
  /**
   * Puts one yes-or-no question to whoever is at this machine.
   *
   * `nobody` is a third answer and not a `false`, because the two lead
   * somewhere different: a person who said no has decided, and a run with
   * nobody at it has not been asked. The runtime is skipped either way and the
   * line printed is different, which is the whole of `--node`/`--no-node`
   * existing -- an unattended run should be able to say what it wants in
   * advance rather than be guessed at.
   *
   * Whether there is anybody is decided by *opening* `/dev/tty` rather than
   * testing it, which is `have_terminal()`'s rule and the one thing about this
   * seam that was learned the hard way: `[ -r /dev/tty ]` answers yes in a
   * container with no controlling terminal, and the open then fails with ENXIO.
   * A check that says yes and a prompt that then hangs is worse than either --
   * it is an update stopped halfway with the daemons already down.
   */
  askYesNo(question: string): Promise<'yes' | 'no' | 'nobody'>;
}
