import { main as runUnits } from './units-main.js';

/**
 * `agentplex start`, wired.
 *
 * A module of its own because the bin's table maps a word to a module with a
 * `main` in it, and `start` and `stop` are two words. Everything either of them
 * does is in `units-main.ts`, which is handed the verb: two entrypoints around
 * one composition is what keeps the pair from drifting into two commands that
 * disagree about which units this machine has.
 */
export async function main(): Promise<void> {
  await runUnits('start');
}
