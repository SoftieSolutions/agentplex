import { runUnitsMain } from '../../installation/units-command.js';
import { START } from './start-command.js';

/**
 * `agentplex start`, wired.
 *
 * A module of its own because the bin's table maps a word to a module with a
 * `main` in it. Everything this does is the shell in `units-command.js`, handed
 * the one command declared next door.
 */
export async function main(): Promise<void> {
  await runUnitsMain(START);
}
