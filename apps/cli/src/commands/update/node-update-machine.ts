import { open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { nodeWriteMachine } from '../../installation/node-write-machine.js';
import type { UpdateMachine } from './update-machine.js';

/**
 * The real disk and the real terminal, as `agentplex update` holds them: the
 * write seam `install` shares, and the one question only an update asks.
 */
export const nodeUpdateMachine: UpdateMachine = {
  ...nodeWriteMachine,

  /**
   * One question, asked of whoever is at this machine.
   *
   * `/dev/tty` is *opened* rather than tested, which is `have_terminal()`'s
   * rule and is captured rather than reasoned about: `[ -r /dev/tty ]` answers
   * yes in a container with no controlling terminal, and the open then fails
   * with ENXIO. The consequence of getting it wrong is worse here than in the
   * installer -- a prompt nobody can answer is an update that hangs with the
   * daemons already stopped.
   *
   * The question is then put on `/dev/tty` itself rather than on stdin, and
   * that is the other half of the same decision. An update can be run with its
   * stdin redirected -- from a script, from `/dev/null`, out of a pipeline --
   * and the operator's terminal is still there; asking on the terminal reaches
   * the person, where asking on stdin would read a line of somebody's script as
   * an answer about replacing a runtime.
   */
  async askYesNo(question: string): Promise<'yes' | 'no' | 'nobody'> {
    let terminal;
    try {
      terminal = await open('/dev/tty', 'r+');
    } catch {
      return 'nobody';
    }

    try {
      const input = terminal.createReadStream();
      const output = terminal.createWriteStream();
      const lines = createInterface({ input, output });
      try {
        const answer = await new Promise<string | null>((resolve) => {
          // Both, in order, from one emitter: an input that ends while a
          // question is outstanding never settles if only the answer is waited
          // for, and racing two emitters throws away a line that arrived in the
          // same tick. The wizard's terminal carries the same note at length.
          lines.once('line', (text: string) => resolve(text));
          lines.once('close', () => resolve(null));
          lines.setPrompt(`${question} [y/N] `);
          lines.prompt();
        });
        if (answer === null) return 'nobody';
        return ['y', 'yes'].includes(answer.trim().toLowerCase()) ? 'yes' : 'no';
      } finally {
        lines.close();
      }
    } finally {
      await terminal.close();
    }
  },
};
