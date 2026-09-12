import { runUnitsMain } from '../../installation/units-command.js';
import { STOP } from './stop-command.js';

/** `agentplex stop`, wired. The argument for the shape is in `start/main.ts`. */
export async function main(): Promise<void> {
  await runUnitsMain(STOP);
}
